import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, getEffectiveSettings } from './env.mjs';
import { streamChatCompletion } from './llm.mjs';
import { synthesizeElevenLabs, convertUploadedAudioToMp3, probeAudioDuration } from './voice.mjs';
import { transcribeWithDeepgram, alignScriptWithLCS } from './timing.mjs';
import { generateStoryboard, validateAndRepairStoryboard } from './storyboard.mjs';
import { renderProjectVideo } from './renderer.mjs';
import {
  STAGES,
  loadProject,
  saveProject,
  appendStageLog,
  writeProjectArtifact,
  readProjectArtifact,
  getProjectDir,
  broadcastSSE
} from './projects.mjs';

const activeRuns = new Map(); // projectId -> { stage, controller }

export function parseScriptOutput(raw, fallbackTopic = '') {
  const text = String(raw || '').trim();
  let title = fallbackTopic;
  let scriptLines = [];
  let sources = [];

  const titleMatch = text.match(/TITLE\s*:\s*(.+)/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  const scriptMatch = text.match(/SCRIPT\s*:\s*([\s\S]*?)(?=\n\s*SOURCES\s*:|$)/i);
  if (scriptMatch) {
    scriptLines = scriptMatch[1]
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^```/.test(l));
  } else {
    // Fallback: take all non-header lines
    scriptLines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^(TITLE|SCRIPT|SOURCES)\s*:/i.test(l) && !/^```/.test(l));
  }

  const sourcesMatch = text.match(/SOURCES\s*:\s*([\s\S]*)$/i);
  if (sourcesMatch) {
    sources = sourcesMatch[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/^\d+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim())
      .filter((l) => l && !/^```/.test(l));
  }

  return {
    title: title || fallbackTopic || 'عارف ليه؟',
    scriptText: scriptLines.join('\n'),
    sources
  };
}

function setStageStatus(projectId, stage, status, error = null) {
  const project = loadProject(projectId);
  if (!project) return null;
  project.stages[stage].status = status;
  project.stages[stage].error = error;
  if (status === 'running') {
    project.stages[stage].startedAt = new Date().toISOString();
    project.stages[stage].finishedAt = null;
    project.activeStage = stage;
  } else {
    project.stages[stage].finishedAt = new Date().toISOString();
    if (project.activeStage === stage) {
      project.activeStage = null;
    }
  }
  return saveProject(project);
}

export function cancelProjectRun(projectId) {
  const entry = activeRuns.get(projectId);
  if (entry) {
    entry.controller.abort();
    activeRuns.delete(projectId);
    appendStageLog(projectId, entry.stage, 'تم إلغاء المرحلة بواسطة المستخدم.');
    setStageStatus(projectId, entry.stage, 'idle', null);
    return true;
  }
  return false;
}

export async function runStage(projectId, stage, { serverOrigin } = {}) {
  if (!STAGES.includes(stage)) {
    throw new Error(`Invalid stage: ${stage}`);
  }

  // Cancel any existing run on this project
  if (activeRuns.has(projectId)) {
    cancelProjectRun(projectId);
  }

  const controller = new AbortController();
  activeRuns.set(projectId, { stage, controller });
  const signal = controller.signal;

  let project = loadProject(projectId);
  if (!project) throw new Error('Project not found');

  // Clear previous logs for fresh rerun
  project.stages[stage].logs = [];
  saveProject(project);
  setStageStatus(projectId, stage, 'running', null);

  try {
    if (stage === 'script') {
      await executeScriptStage(projectId, signal);
    } else if (stage === 'voice') {
      await executeVoiceStage(projectId, signal);
    } else if (stage === 'timing') {
      await executeTimingStage(projectId, signal);
    } else if (stage === 'storyboard') {
      await executeStoryboardStage(projectId, signal);
    } else if (stage === 'render') {
      await executeRenderStage(projectId, serverOrigin, signal);
    }

    if (signal.aborted) return loadProject(projectId);

    project = loadProject(projectId);
    const mode = project.stages[stage].mode;
    const nextIdx = STAGES.indexOf(stage) + 1;

    if (mode === 'approval' && stage !== 'render') {
      setStageStatus(projectId, stage, 'review', null);
      appendStageLog(projectId, stage, 'بانتظار مراجعتك وموافقتك للمتابعة.');
    } else {
      setStageStatus(projectId, stage, 'done', null);
      if (nextIdx < STAGES.length && mode === 'auto') {
        const nextStage = STAGES[nextIdx];
        // Trigger next stage asynchronously so SSE updates flow smoothly
        setImmediate(() => {
          runStage(projectId, nextStage, { serverOrigin }).catch(() => {});
        });
      }
    }
    return loadProject(projectId);
  } catch (err) {
    if (err.name === 'AbortError' || signal.aborted) {
      setStageStatus(projectId, stage, 'idle', null);
      return loadProject(projectId);
    }
    appendStageLog(projectId, stage, `خطأ: ${err.message}`);
    setStageStatus(projectId, stage, 'error', err.message);
    throw err;
  } finally {
    const cur = activeRuns.get(projectId);
    if (cur && cur.controller === controller) {
      activeRuns.delete(projectId);
    }
  }
}

export async function approveStage(projectId, stage, { serverOrigin } = {}) {
  const project = loadProject(projectId);
  if (!project) throw new Error('Project not found');
  if (!STAGES.includes(stage)) throw new Error('Invalid stage');

  setStageStatus(projectId, stage, 'done', null);
  appendStageLog(projectId, stage, 'تمت الموافقة على المرحلة.');

  const nextIdx = STAGES.indexOf(stage) + 1;
  if (nextIdx < STAGES.length) {
    const nextStage = STAGES[nextIdx];
    setImmediate(() => {
      runStage(projectId, nextStage, { serverOrigin }).catch(() => {});
    });
  }
  return loadProject(projectId);
}

async function executeScriptStage(projectId, signal) {
  const project = loadProject(projectId);
  const stylePath = path.join(ROOT_DIR, 'references', 'script-style.md');
  const styleGuide = fs.existsSync(stylePath) ? fs.readFileSync(stylePath, 'utf8') : '';
  const targetWords = Math.round(project.durationSec * 2.6);

  appendStageLog(projectId, 'script', `كتابة سكريبت بالعامية المصرية (${project.durationSec} ثانية ≈ ${targetWords} كلمة)...`);

  const systemPrompt = `أنت كاتب سكريبتات سلسلة الريلز العلمية «عارف ليه؟» (شرح علمي بدون وش بالعامية المصرية).
التزم حرفياً بدليل الأسلوب التالي:
${styleGuide}

قواعد حاسمة:
1. استهدف طول سكريبت قريب جداً من ${targetWords} كلمة (معدل ٢.٦ كلمة في الثانية لمدة ${project.durationSec} ثانية).
2. المصطلحات العلمية الإنجليزية الشائعة اكتبها بالإنجليزي داخل الجملة (مثل X-rays, Calcium, Electrons, Photons, DNA).
3. الأرقام اكتبها بالحروف العربية.
4. أخرج النتيجة فقط بهذه الصيغة:
TITLE: ...
SCRIPT:
...
SOURCES:
1. ...`;

  const userPrompt = `الموضوع: ${project.topic}
المدة المطلوبة: ${project.durationSec} ثانية (حوالي ${targetWords} كلمة).
اكتب السكريبت الآن.`;

  const fullText = await streamChatCompletion({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    maxTokens: 1600,
    onDelta: (delta, visible) => {
      broadcastSSE(projectId, 'llm_chunk', { stage: 'script', delta, text: visible });
    },
    signal
  });

  const parsed = parseScriptOutput(fullText, project.topic);
  writeProjectArtifact(projectId, 'script.txt', parsed.scriptText);
  writeProjectArtifact(projectId, 'script_raw.txt', fullText);

  const fresh = loadProject(projectId);
  fresh.title = parsed.title;
  fresh.sources = parsed.sources;
  fresh.artifacts.scriptText = parsed.scriptText;
  fresh.artifacts.streamText = fullText;
  saveProject(fresh);

  const wc = parsed.scriptText.split(/\s+/).filter(Boolean).length;
  appendStageLog(projectId, 'script', `تم توليد السكريبت: "${parsed.title}" (${wc} كلمة).`);
}

async function executeVoiceStage(projectId, signal) {
  const project = loadProject(projectId);
  const projectDir = getProjectDir(projectId);
  const voiceMp3 = path.join(projectDir, 'voice.mp3');

  if (project.voiceMode === 'upload') {
    const rawUpload = fs.readdirSync(projectDir).find((f) => f.startsWith('uploaded_audio'));
    if (!rawUpload && !fs.existsSync(voiceMp3)) {
      throw new Error('لم يتم رفع ملف صوتي بعد. ارفع ملفاً صوتياً أو اختر التوليد الصوتي.');
    }
    if (rawUpload) {
      appendStageLog(projectId, 'voice', `معالجة الملف الصوتي المرفوع (${rawUpload})...`);
      await convertUploadedAudioToMp3({
        inputPath: path.join(projectDir, rawUpload),
        outputPath: voiceMp3,
        signal
      });
    }
    const dur = await probeAudioDuration(voiceMp3);
    writeProjectArtifact(projectId, 'voice_timings.json', { source: 'uploaded', duration: dur, timedWords: [] });

    const fresh = loadProject(projectId);
    fresh.artifacts.hasAudio = true;
    fresh.artifacts.audioDuration = dur;
    saveProject(fresh);
    appendStageLog(projectId, 'voice', `تم تجهيز الصوت المرفوع (${dur.toFixed(2)} ثانية).`);
    return;
  }

  const scriptText = readProjectArtifact(projectId, 'script.txt', false) || project.artifacts.scriptText;
  if (!scriptText || !scriptText.trim()) {
    throw new Error('السكريبت فارغ. شغّل مرحلة السكريبت أولاً.');
  }

  const settings = getEffectiveSettings();
  const voiceId = project.voiceId || settings.elevenLabsVoiceId;
  appendStageLog(projectId, 'voice', `توليد التعليق الصوتي عبر ElevenLabs (voice: ${voiceId})...`);

  const res = await synthesizeElevenLabs({
    text: scriptText,
    voiceId,
    outputPath: voiceMp3,
    signal
  });

  writeProjectArtifact(projectId, 'voice_timings.json', res);

  const fresh = loadProject(projectId);
  fresh.artifacts.hasAudio = true;
  fresh.artifacts.audioDuration = res.duration;
  saveProject(fresh);

  appendStageLog(projectId, 'voice', `تم توليد الصوت (${res.duration.toFixed(2)} ثانية، ${res.timedWords.length} كلمة مؤقتة).`);
}

async function executeTimingStage(projectId, signal) {
  const project = loadProject(projectId);
  const projectDir = getProjectDir(projectId);
  const voiceMp3 = path.join(projectDir, 'voice.mp3');
  const scriptText = readProjectArtifact(projectId, 'script.txt', false) || project.artifacts.scriptText;

  if (!scriptText || !scriptText.trim()) {
    throw new Error('السكريبت فارغ.');
  }
  if (!fs.existsSync(voiceMp3)) {
    throw new Error('ملف الصوت voice.mp3 غير موجود.');
  }

  let rawWords = [];
  const voiceTimings = readProjectArtifact(projectId, 'voice_timings.json', true);

  if (project.voiceMode === 'upload' || !voiceTimings || !Array.isArray(voiceTimings.timedWords) || voiceTimings.timedWords.length === 0) {
    appendStageLog(projectId, 'timing', 'تحليل التوقيت عبر Deepgram (nova-3, ar, punctuate)...');
    rawWords = await transcribeWithDeepgram({ audioPath: voiceMp3, signal });
    appendStageLog(projectId, 'timing', `تم استلام ${rawWords.length} كلمة من Deepgram.`);
  } else {
    rawWords = voiceTimings.timedWords;
    appendStageLog(projectId, 'timing', `استخدام توقيتات ElevenLabs (${rawWords.length} كلمة).`);
  }

  const dur = project.artifacts.audioDuration || (await probeAudioDuration(voiceMp3));
  const aligned = alignScriptWithLCS({
    scriptText,
    timedWords: rawWords,
    totalDuration: dur
  });

  const weakCount = aligned.filter((w) => w.weak).length;
  writeProjectArtifact(projectId, 'aligned_words.json', aligned);

  const fresh = loadProject(projectId);
  fresh.artifacts.wordCount = aligned.length;
  fresh.artifacts.weakWordCount = weakCount;
  saveProject(fresh);

  appendStageLog(projectId, 'timing', `تمت المحاذاة عبر LCS على ${aligned.length} كلمة (كلمات ضعيفة: ${weakCount}).`);
}

async function executeStoryboardStage(projectId, signal) {
  const project = loadProject(projectId);
  const scriptText = readProjectArtifact(projectId, 'script.txt', false) || project.artifacts.scriptText;
  const alignedWords = readProjectArtifact(projectId, 'aligned_words.json', true);

  if (!alignedWords || !Array.isArray(alignedWords) || alignedWords.length === 0) {
    throw new Error('توقيتات الكلمات غير موجودة. شغّل مرحلة التوقيت أولاً.');
  }

  const { storyboard, icons } = await generateStoryboard({
    topic: project.topic,
    title: project.title,
    scriptText,
    alignedWords,
    durationSec: project.artifacts.audioDuration || project.durationSec,
    onStream: (visible) => {
      broadcastSSE(projectId, 'llm_chunk', { stage: 'storyboard', text: visible });
    },
    onLog: (msg) => appendStageLog(projectId, 'storyboard', msg),
    signal
  });

  writeProjectArtifact(projectId, 'storyboard.json', storyboard);
  writeProjectArtifact(projectId, 'icons.json', icons);

  const fresh = loadProject(projectId);
  fresh.artifacts.sceneCount = storyboard.scenes.length;
  saveProject(fresh);
}

async function executeRenderStage(projectId, serverOrigin, signal) {
  const project = loadProject(projectId);
  const projectDir = getProjectDir(projectId);
  const alignedWords = readProjectArtifact(projectId, 'aligned_words.json', true);
  const storyboard = readProjectArtifact(projectId, 'storyboard.json', true);
  let icons = readProjectArtifact(projectId, 'icons.json', true);

  if (!alignedWords || !storyboard) {
    throw new Error('البيانات المطلوبة للريندر غير مكتملة.');
  }

  if (!icons) {
    const repaired = validateAndRepairStoryboard(storyboard, alignedWords);
    icons = repaired.icons;
    writeProjectArtifact(projectId, 'icons.json', icons);
  }

  const result = await renderProjectVideo({
    projectDir,
    serverOrigin,
    title: project.title || project.topic,
    durationSec: project.artifacts.audioDuration || project.durationSec,
    words: alignedWords,
    storyboard,
    icons,
    onProgress: (prog) => {
      broadcastSSE(projectId, 'render_progress', prog);
    },
    onPreviewFrame: (frameData) => {
      broadcastSSE(projectId, 'preview_frame', frameData);
    },
    onLog: (msg) => appendStageLog(projectId, 'render', msg),
    signal
  });

  const fresh = loadProject(projectId);
  fresh.artifacts.hasVideo = true;
  fresh.artifacts.hasContactSheet = true;
  fresh.artifacts.audioDuration = result.duration;
  saveProject(fresh);
}
