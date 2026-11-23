import fs from 'node:fs';
import path from 'node:path';

function writeWavMono16(filePath, samples, sampleRate = 44100) {
  const numSamples = samples.length;
  const byteRate = sampleRate * 2;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM
  buffer.writeUInt16LE(1, 20);  // AudioFormat 1
  buffer.writeUInt16LE(1, 22);  // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(2, 32);  // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
}

// Deterministic PRNG for noise shaping
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateWhooshWav(filePath, durationSec = 0.28, sampleRate = 44100) {
  const n = Math.floor(durationSec * sampleRate);
  const samples = new Float32Array(n);
  const rand = mulberry32(4301);
  let lp1 = 0;
  let lp2 = 0;

  for (let i = 0; i < n; i++) {
    const p = i / n;
    // Smooth bell envelope
    const env = Math.sin(Math.PI * p) ** 1.6;
    const noise = rand() * 2 - 1;
    // Swept low-pass cutoff for gentle air whoosh
    const alpha = 0.04 + 0.18 * Math.sin(Math.PI * p);
    lp1 = lp1 + alpha * (noise - lp1);
    lp2 = lp2 + alpha * (lp1 - lp2);
    // Subtle warm body sine sweep 180Hz -> 90Hz
    const t = i / sampleRate;
    const tone = Math.sin(2 * Math.PI * (180 - 90 * p) * t) * 0.14;
    samples[i] = (lp2 * 0.85 + tone) * env * 0.45;
  }

  writeWavMono16(filePath, samples, sampleRate);
  return filePath;
}

export function generateTickWav(filePath, durationSec = 0.075, sampleRate = 44100) {
  const n = Math.floor(durationSec * sampleRate);
  const samples = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 68);
    const sig = Math.sin(2 * Math.PI * 1150 * t) * 0.55 + Math.sin(2 * Math.PI * 2300 * t) * 0.25;
    samples[i] = sig * env * 0.4;
  }

  writeWavMono16(filePath, samples, sampleRate);
  return filePath;
}
