import { streamChatCompletion } from './llm.mjs';
import { collectProjectIcons, listAvailableIconNames } from './icons.mjs';

export const SCENE_TYPES = ['intro', 'question', 'concept', 'process', 'compare', 'stat', 'recap'];
export const TEMPLATES = ['body', 'zoom', 'flow', 'cycle', 'timeline', 'chart', 'layers', 'cards', 'meter'];
export const ACCENT_TONES = ['accent', 'second', 'success', 'warning', 'underline'];

const DEFAULT_TEMPLATE_BY_TYPE = {
  intro: 'cards',
  question: 'zoom',
  concept: 'layers',
  process: 'flow',
  compare: 'cards',
  stat: 'meter',
  recap: 'timeline'
};

export function extractJsonFromText(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text.trim();
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function pickAlternateTemplate(currentTemplate, prevTemplate, type) {
  const preferred = DEFAULT_TEMPLATE_BY_TYPE[type] || 'flow';
  const pool = [preferred, ...TEMPLATES];
  for (const cand of pool) {
    if (cand !== currentTemplate && cand !== prevTemplate) return cand;
  }
  return 'cards';
}

export function validateAndRepairStoryboard(raw, alignedWords = []) {
  const wordCount = Math.max(1, alignedWords.length);
  const maxIdx = wordCount - 1;

  const input = raw && typeof raw === 'object' ? raw : {};
  let scenes = Array.isArray(input.scenes) ? input.scenes.map((s) => ({ ...s })) : [];

  if (scenes.length === 0) {
    scenes = [
      {
        type: 'intro',
        template: 'cards',
        at: 0,
        title: 'عارف ليه؟',
        subtitle: 'شرح علمي سريع',
        icon: 'atom',
        items: [
          { label: 'الفكرة', icon: 'bulb' },
          { label: 'الآلية', icon: 'wave' }
        ]
      }
    ];
  }

  // Normalize fields & clamp word indices
  scenes = scenes.map((s, idx) => {
    const type = SCENE_TYPES.includes(s.type) ? s.type : (idx === 0 ? 'intro' : 'concept');
    const template = TEMPLATES.includes(s.template)
      ? s.template
      : (DEFAULT_TEMPLATE_BY_TYPE[type] || 'cards');
    let at = Number.isFinite(Number(s.at)) ? Math.round(Number(s.at)) : 0;
    at = Math.max(0, Math.min(maxIdx, at));
    return {
      ...s,
      type,
      template,
      at,
      title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : `مشهد ${idx + 1}`,
      subtitle: typeof s.subtitle === 'string' ? s.subtitle.trim() : '',
      icon: typeof s.icon === 'string' && s.icon.trim() ? s.icon.trim() : 'atom'
    };
  });

  // Sort by `at`
  scenes.sort((a, b) => a.at - b.at);

  // Ensure first scene is intro at word index 0
  if (scenes[0].at !== 0) {
    scenes.unshift({
      type: 'intro',
      template: scenes[0].template === 'cards' ? 'zoom' : 'cards',
      at: 0,
      title: scenes[0].title || 'عارف ليه؟',
      subtitle: scenes[0].subtitle || '',
      icon: scenes[0].icon || 'atom',
      items: scenes[0].items
    });
  } else {
    scenes[0].type = 'intro';
    scenes[0].at = 0;
  }

  // Deduplicate identical `at` indices (advance or drop if no room)
  const deduped = [];
  for (const s of scenes) {
    if (deduped.length === 0) {
      deduped.push(s);
      continue;
    }
    const prev = deduped[deduped.length - 1];
    if (s.at <= prev.at) {
      if (prev.at + 1 <= maxIdx) {
        s.at = prev.at + 1;
        deduped.push(s);
      }
      // else drop overcrowded duplicate at very end
    } else {
      deduped.push(s);
    }
  }
  scenes = deduped;

  // Enforce no template three times in a row
  for (let i = 2; i < scenes.length; i++) {
    if (scenes[i].template === scenes[i - 1].template && scenes[i - 1].template === scenes[i - 2].template) {
      scenes[i].template = pickAlternateTemplate(scenes[i].template, scenes[i - 1].template, scenes[i].type);
    }
  }

  // Validate accents: [[wordIndex, tone], ...]
  const rawAccents = Array.isArray(input.accents) ? input.accents : [];
  const accentMap = new Map();
  for (const entry of rawAccents) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const wi = Math.round(Number(entry[0]));
    const tone = String(entry[1] || '').trim();
    if (!Number.isFinite(wi) || wi < 0 || wi > maxIdx) continue;
    const safeTone = ACCENT_TONES.includes(tone) ? tone : 'accent';
    accentMap.set(wi, safeTone);
  }
  const accents = Array.from(accentMap.entries())
    .sort((a, b) => a[0] - b[0]);

  const repaired = {
    version: 1,
    scenes,
    accents
  };

  // Resolve only the icons used in this project
  const projectIcons = collectProjectIcons(repaired);

  return {
    storyboard: repaired,
    icons: projectIcons
  };
}

function buildIndexedWordsSummary(alignedWords) {
  return alignedWords
    .map((w) => `[${w.index}]${w.text}(${w.start.toFixed(2)}s)`)
    .join(' ');
}

export async function generateStoryboard({
  topic,
  title,
  scriptText,
  alignedWords,
  durationSec,
  onStream,
  onLog,
  signal
}) {
  const iconNames = listAvailableIconNames().slice(0, 60).join(', ');
  const indexedWords = buildIndexedWordsSummary(alignedWords);
  const targetScenes = durationSec <= 12 ? '3 to 4' : durationSec <= 25 ? '4 to 5' : durationSec <= 40 ? '5 to 7' : '7 to 9';

  const systemPrompt = `You are a visual director for the Arabic (Egyptian dialect) science-explainer vertical reel series «عارف ليه؟».
Output ONLY valid JSON (no markdown fences, no commentary) matching this schema:
{
  "scenes": [
    {
      "type": "intro|question|concept|process|compare|stat|recap",
      "template": "body|zoom|flow|cycle|timeline|chart|layers|cards|meter",
      "at": 0,
      "title": "short Arabic title (2-5 words)",
      "subtitle": "short Arabic label or metric (optional)",
      "icon": "simple english noun",
      "organ": "for body template: heart|bone|lungs|brain|eye|stomach|kidneys",
      "macro": {"label": "Arabic", "icon": "english noun"},
      "micro": {"label": "Arabic", "icon": "english noun"},
      "steps": [{"label": "Arabic", "icon": "english noun"}],
      "items": [{"label": "Arabic", "value": "optional", "icon": "english noun"}],
      "layers": [{"label": "Arabic", "icon": "english noun", "tone": "accent|second|success|warning"}],
      "left": {"label": "Arabic", "value": "optional", "icon": "english noun"},
      "right": {"label": "Arabic", "value": "optional", "icon": "english noun"},
      "value": 99,
      "unit": "%",
      "points": [{"label": "Arabic", "value": 40}]
    }
  ],
  "accents": [[wordIndex, "accent|second|success|warning|underline"]]
}

Rules:
- First scene MUST have "type": "intro" and "at": 0.
- Use ${targetScenes} scenes aligned to phrase boundaries in the indexed words.
- Never repeat the exact same "template" 3 times in a row.
- Keep all visible text labels inside scenes crisp, short Arabic (or key English science terms).
- Use simple English nouns for icons (examples: ${iconNames}).
- Add 4-10 "accents" highlighting key science terms, numbers, and hook words ("accent" cyan, "second" blue, "success" green, "warning" amber, "underline" emphasis).`;

  const userPrompt = `Topic: ${topic}
Title: ${title || topic}
Target duration: ${durationSec}s
Script:
${scriptText}

Indexed timed words:
${indexedWords}

Create the storyboard JSON now.`;

  if (onLog) onLog('Pass 1: توليد المسودة الأولى للستوري بورد من النموذج...');
  const pass1Raw = await streamChatCompletion({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.45,
    maxTokens: 2200,
    onDelta: (_, full) => {
      if (onStream) onStream(full);
    },
    signal
  });

  const pass1Json = extractJsonFromText(pass1Raw);
  const pass1Repaired = validateAndRepairStoryboard(pass1Json, alignedWords);

  if (onLog) {
    onLog(`Pass 1 اكتمل (${pass1Repaired.storyboard.scenes.length} مشاهد). جاري المراجعة الذاتية (Pass 2)...`);
  }

  // Second self-review LLM pass to improve weak scene choices
  const reviewPrompt = `Review and improve this draft storyboard JSON for the Arabic science reel "${title || topic}".
Critique checklist:
1. Replace any generic template with a more expressive visual template (body, zoom, flow, cycle, timeline, chart, layers, cards, meter) matching the exact line spoken at that word index.
2. Ensure every scene has rich structured fields for its chosen template (steps for flow/cycle/timeline, macro+micro for zoom, organ for body, left+right for compare/cards, value+unit for meter, points for chart, layers for layers).
3. Ensure icon names are simple concrete English nouns.
4. Ensure accents highlight the hook, key English science terms, and numbers.
5. Keep first scene type="intro" at=0, valid sorted word indices (0..${Math.max(0, alignedWords.length - 1)}), and no template 3 times in a row.

Indexed timed words:
${indexedWords}

Draft storyboard JSON:
${JSON.stringify(pass1Repaired.storyboard, null, 2)}

Return ONLY the improved valid JSON.`;

  try {
    const pass2Raw = await streamChatCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: reviewPrompt }
      ],
      temperature: 0.3,
      maxTokens: 2400,
      onDelta: (_, full) => {
        if (onStream) onStream(full);
      },
      signal
    });

    const pass2Json = extractJsonFromText(pass2Raw);
    if (pass2Json && Array.isArray(pass2Json.scenes) && pass2Json.scenes.length > 0) {
      const finalRepaired = validateAndRepairStoryboard(pass2Json, alignedWords);
      if (onLog) {
        onLog(`Pass 2 المراجعة الذاتية اكتملت (${finalRepaired.storyboard.scenes.length} مشاهد، ${Object.keys(finalRepaired.icons).length} أيقونة).`);
      }
      return finalRepaired;
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (onLog) onLog(`تنبيه: تعذّر إكمال المراجعة الثانية، تم اعتماد المسودة المُصلحة (${err.message}).`);
  }

  return pass1Repaired;
}
