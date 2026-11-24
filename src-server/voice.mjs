import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getEffectiveSettings } from './env.mjs';
import { getFfmpegPath, getFfprobePath } from './bins.mjs';

const execFileAsync = promisify(execFile);

export async function fetchElevenLabsVoices() {
  const settings = getEffectiveSettings();
  const url = `${settings.elevenLabsBaseUrl}/v1/voices`;
  const headers = {};
  if (settings.elevenLabsApiKey) {
    headers['xi-api-key'] = settings.elevenLabsApiKey;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`ElevenLabs /v1/voices failed (${res.status}): ${errText.slice(0, 240)}`);
  }
  const data = await res.json();
  const voices = Array.isArray(data.voices) ? data.voices : [];
  return voices.map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    category: v.category || 'premade',
    labels: v.labels || {},
    preview_url: v.preview_url || ''
  }));
}

export function charsAlignmentToWords(alignment) {
  if (!alignment || !Array.isArray(alignment.characters)) {
    return [];
  }
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds || [];
  const ends = alignment.character_end_times_seconds || [];

  const words = [];
  let buf = '';
  let wStart = null;
  let wEnd = null;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const s = typeof starts[i] === 'number' ? starts[i] : (wEnd ?? 0);
    const e = typeof ends[i] === 'number' ? ends[i] : s + 0.05;

    if (/\s/.test(ch)) {
      if (buf.length > 0) {
        words.push({
          word: buf,
          start: Number(wStart.toFixed(3)),
          end: Number(Math.max(wStart + 0.05, wEnd).toFixed(3)),
          confidence: 0.98
        });
        buf = '';
        wStart = null;
        wEnd = null;
      }
    } else {
      if (wStart === null) wStart = s;
      wEnd = e;
      buf += ch;
    }
  }

  if (buf.length > 0) {
    words.push({
      word: buf,
      start: Number(wStart.toFixed(3)),
      end: Number(Math.max(wStart + 0.05, wEnd).toFixed(3)),
      confidence: 0.98
    });
  }

  return words;
}

export async function synthesizeElevenLabs({ text, voiceId, outputPath, signal }) {
  const settings = getEffectiveSettings();
  const vid = encodeURIComponent(voiceId || settings.elevenLabsVoiceId || '21m00Tcm4TlvDq8ikWAM');
  const url = `${settings.elevenLabsBaseUrl}/v1/text-to-speech/${vid}/with-timestamps`;

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (settings.elevenLabsApiKey) {
    headers['xi-api-key'] = settings.elevenLabsApiKey;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.55,
        similarity_boost: 0.78
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${errText.slice(0, 280)}`);
  }

  const data = await res.json();
  if (!data.audio_base64) {
    throw new Error('ElevenLabs response missing audio_base64');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const audioBuf = Buffer.from(data.audio_base64, 'base64');
  fs.writeFileSync(outputPath, audioBuf);

  const alignment = data.alignment || data.normalized_alignment;
  const timedWords = charsAlignmentToWords(alignment);
  const duration = await probeAudioDuration(outputPath);

  return {
    source: 'elevenlabs',
    voiceId: vid,
    duration,
    timedWords,
    rawAlignment: alignment || null
  };
}

export async function probeAudioDuration(audioPath) {
  try {
    const { stdout } = await execFileAsync(getFfprobePath(), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath
    ]);
    const val = parseFloat(stdout.trim());
    return Number.isFinite(val) && val > 0 ? Number(val.toFixed(3)) : 0;
  } catch {
    return 0;
  }
}

export async function convertUploadedAudioToMp3({ inputPath, outputPath, signal }) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await execFileAsync(getFfmpegPath(), [
    '-y',
    '-i', inputPath,
    '-vn',
    '-ar', '44100',
    '-ac', '1',
    '-b:a', '192k',
    outputPath
  ], { signal });
  const duration = await probeAudioDuration(outputPath);
  return {
    source: 'uploaded',
    duration,
    timedWords: []
  };
}
