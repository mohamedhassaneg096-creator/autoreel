import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MOCK_PORT = Number(process.env.MOCK_PORT || 4399);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function buildMockScript(topic, targetSec) {
  if (targetSec <= 15) {
    return `TITLE: إزاي الأشعة بتشوف عضمك؟
SCRIPT:
الدكتور شاف الكسر اللي في عضمك بدون جراحة.
عارف ليه؟ السر كله في الضل.
أشعة X-rays بتعدي لحمك بسهولة لكن Calcium عضمك بيوقفها.
صورة الأشعة دي ضل عضمك.
SOURCES:
1. National Institute of Biomedical Imaging and Bioengineering (NIBIB)`;
  }

  return `TITLE: ${topic || 'إزاي الأشعة بتشوف عضمك؟'}
SCRIPT:
الدكتور شاف الكسر اللي في عضمك من غير ما يلمس جلدك.
عارف ليه؟ هشرحهولك في ثواني.
السر كله في الضل، نور كشاف على إيدك في الضلمة.
أشعة X-rays نور أقوى بكتير، بتعدي من لحمك بسهولة.
لكن Calcium عضمك بيوقف الأشعة ويعمل ضل على الفيلم.
تسعة وتسعين في المية حرارة وواحد في المية أشعة.
يعني صورة الأشعة دي ضل عضمك.
SOURCES:
1. National Institute of Biomedical Imaging and Bioengineering (NIBIB)
2. Radiological Society of North America (RSNA)`;
}

function parseIndexedWordsCount(prompt) {
  const matches = [...prompt.matchAll(/\[(\d+)\]/g)];
  if (matches.length === 0) return 26;
  return Number(matches[matches.length - 1][1]) + 1;
}

function buildMockStoryboardDraft(wordCount) {
  const c1 = Math.min(wordCount - 1, Math.floor(wordCount * 0.25));
  const c2 = Math.min(wordCount - 1, Math.floor(wordCount * 0.55));
  const c3 = Math.min(wordCount - 1, Math.floor(wordCount * 0.80));

  return {
    scenes: [
      {
        type: 'intro',
        template: 'body',
        at: 0,
        title: 'كسر جوه عضمك',
        subtitle: 'من غير جراحة',
        icon: 'bone',
        organ: 'bone'
      },
      {
        type: 'question',
        template: 'cards',
        at: c1,
        title: 'عارف ليه؟',
        subtitle: 'السر في الضل',
        left: { label: 'كشاف وإيدك', icon: 'flashlight' },
        right: { label: 'ضل على الحيطة', icon: 'shadow' }
      },
      {
        type: 'process',
        template: 'flow',
        at: c2,
        title: 'رحلة الأشعة',
        steps: [
          { label: 'أشعة X-rays', icon: 'xray-beam' },
          { label: 'تعدي اللحم', icon: 'hand' },
          { label: 'يوقفها Calcium', icon: 'calcium-crystal' }
        ]
      },
      {
        type: 'recap',
        template: 'zoom',
        at: c3,
        title: 'ضل عضمك',
        macro: { label: 'صورة الأشعة', icon: 'film-plate' },
        micro: { label: 'كثافة Calcium', icon: 'bone-fracture' }
      }
    ],
    accents: [
      [2, 'warning'],
      [7, 'accent'],
      [Math.min(wordCount - 1, c2 + 1), 'second'],
      [Math.min(wordCount - 1, wordCount - 1), 'success']
    ]
  };
}

function buildMockStoryboardReviewed(wordCount) {
  const base = buildMockStoryboardDraft(wordCount);
  // Second pass adds an extra layer/meter or refines labels
  if (wordCount >= 18) {
    base.scenes[1] = {
      type: 'question',
      template: 'layers',
      at: base.scenes[1].at,
      title: 'السر في الاختراق',
      layers: [
        { label: 'الجلد واللحم: بتعدي', icon: 'hand', tone: 'accent' },
        { label: 'العضم والـ Calcium: بيوقفها', icon: 'bone', tone: 'warning' },
        { label: 'الفيلم: يسجل الضل', icon: 'film-plate', tone: 'success' }
      ]
    };
  }
  return base;
}

// Synthesize an actual MP3 where each word produces a soft audible cadence pulse
// matching exact per-character timings, so captions sync visibly and audibly!
async function synthesizeCadenceMp3(text) {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  const sampleRate = 22050;
  const wordDur = 0.34;
  const gapDur = 0.04;
  const step = wordDur + gapDur;
  const totalSec = Math.max(2.0, tokens.length * step + 0.30);
  const numSamples = Math.floor(totalSec * sampleRate);
  const pcm = new Float32Array(numSamples);

  const characters = [];
  const starts = [];
  const ends = [];

  let cursor = 0.12;
  tokens.forEach((tok, idx) => {
    const startT = cursor;
    const endT = startT + wordDur;
    const freq = 220 + (idx % 5) * 45;
    const s0 = Math.floor(startT * sampleRate);
    const s1 = Math.min(numSamples, Math.floor(endT * sampleRate));
    for (let i = s0; i < s1; i++) {
      const localP = (i - s0) / Math.max(1, s1 - s0);
      const env = Math.sin(Math.PI * localP);
      const t = i / sampleRate;
      pcm[i] = Math.sin(2 * Math.PI * freq * t) * 0.22 * env;
    }

    const chars = [...tok];
    const chStep = wordDur / Math.max(1, chars.length);
    chars.forEach((ch, ci) => {
      characters.push(ch);
      starts.push(Number((startT + ci * chStep).toFixed(3)));
      ends.push(Number((startT + (ci + 1) * chStep).toFixed(3)));
    });
    if (idx < tokens.length - 1) {
      characters.push(' ');
      starts.push(Number(endT.toFixed(3)));
      ends.push(Number((endT + gapDur).toFixed(3)));
    }
    cursor = endT + gapDur;
  });

  // Write temp WAV and encode to MP3 via ffmpeg
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-el-'));
  const wavPath = path.join(tmpDir, 'out.wav');
  const mp3Path = path.join(tmpDir, 'out.mp3');

  const buf = Buffer.alloc(44 + numSamples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + numSamples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(numSamples * 2, 40);
  for (let i = 0; i < numSamples; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(wavPath, buf);

  await execFileAsync('ffmpeg', ['-y', '-i', wavPath, '-ar', '44100', '-ac', '1', '-b:a', '128k', mp3Path]);
  const mp3Buf = fs.readFileSync(mp3Path);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  return {
    audio_base64: mp3Buf.toString('base64'),
    alignment: {
      characters,
      character_start_times_seconds: starts,
      character_end_times_seconds: ends
    }
  };
}

export function createMockServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${MOCK_PORT}`);
      const pathname = url.pathname;

      // 1. Mock FreeLLMAPI /v1/chat/completions (SSE with <think> block)
      if (req.method === 'POST' && pathname === '/v1/chat/completions') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const userMsg = (body.messages || []).map((m) => m.content).join('\n');

        let contentText = '';
        if (userMsg.includes('Review and improve this draft storyboard JSON')) {
          const wc = parseIndexedWordsCount(userMsg);
          contentText = JSON.stringify(buildMockStoryboardReviewed(wc), null, 2);
        } else if (userMsg.includes('Create the storyboard JSON now')) {
          const wc = parseIndexedWordsCount(userMsg);
          contentText = JSON.stringify(buildMockStoryboardDraft(wc), null, 2);
        } else {
          const topicMatch = userMsg.match(/الموضوع:\s*(.+)/);
          const durMatch = userMsg.match(/المدة المطلوبة:\s*(\d+)/);
          const topic = topicMatch ? topicMatch[1].trim() : 'الأشعة السينية';
          const dur = durMatch ? Number(durMatch[1]) : 10;
          contentText = buildMockScript(topic, dur);
        }

        // Wrap with <think> block split across chunks to verify stripping!
        const fullWithThink = `<think>التفكير في الأسلوب العلمي المصري وتنسيق المدة...\n</think>\n${contentText}`;

        if (body.stream === false) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            id: 'mock-chat',
            choices: [{ index: 0, message: { role: 'assistant', content: fullWithThink } }]
          }));
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache'
        });

        const chunkSize = 18;
        for (let i = 0; i < fullWithThink.length; i += chunkSize) {
          const slice = fullWithThink.slice(i, i + chunkSize);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: slice } }] })}\n\n`);
          await new Promise((r) => setTimeout(r, 8));
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // 2. Mock ElevenLabs /v1/voices
      if (req.method === 'GET' && pathname === '/v1/voices') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          voices: [
            { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'طارق (صوت علمي هادئ)', category: 'premade' },
            { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'آدم (إلقاء مصري سريع)', category: 'premade' },
            { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'سارة (شرح مبسط)', category: 'premade' }
          ]
        }));
      }

      // 3. Mock ElevenLabs /v1/text-to-speech/:voice/with-timestamps
      if (req.method === 'POST' && /^\/v1\/text-to-speech\/[^/]+\/with-timestamps$/.test(pathname)) {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const payload = await synthesizeCadenceMp3(body.text || 'تجربة صوت');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(payload));
      }

      // 4. Mock Deepgram /v1/listen
      if (req.method === 'POST' && pathname === '/v1/listen') {
        await readBody(req);
        const sampleWords = [
          'الدكتور', 'شاف', 'الكسر', 'اللي', 'في', 'عضمك', 'من', 'غير', 'ما', 'يلمس', 'جلدك',
          'عارف', 'ليه', 'السر', 'كله', 'في', 'الضل'
        ];
        const words = sampleWords.map((w, i) => ({
          word: w,
          punctuated_word: w,
          start: Number((0.12 + i * 0.4).toFixed(3)),
          end: Number((0.46 + i * 0.4).toFixed(3)),
          confidence: i === 5 ? 0.58 : 0.94
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          results: {
            channels: [{ alternatives: [{ transcript: sampleWords.join(' '), words }] }]
          }
        }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Mock endpoint not found: ${req.method} ${pathname}` }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const srv = createMockServer();
  srv.listen(MOCK_PORT, '127.0.0.1', () => {
    console.log(`Mock APIs (FreeLLMAPI, ElevenLabs, Deepgram) running at http://127.0.0.1:${MOCK_PORT}`);
  });
}
