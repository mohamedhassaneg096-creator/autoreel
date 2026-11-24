import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function unpackAsarPath(binPath) {
  if (!binPath) return null;
  if (binPath.includes('app.asar')) {
    const unpacked = binPath.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return fs.existsSync(binPath) ? binPath : null;
}

let cachedFfmpeg = null;
let cachedFfprobe = null;

export function getFfmpegPath() {
  if (cachedFfmpeg) return cachedFfmpeg;
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    cachedFfmpeg = process.env.FFMPEG_PATH;
    return cachedFfmpeg;
  }
  try {
    const modPath = require('ffmpeg-static');
    const resolved = unpackAsarPath(modPath);
    if (resolved) {
      cachedFfmpeg = resolved;
      return cachedFfmpeg;
    }
  } catch {
    // ignore and fallback to PATH
  }
  cachedFfmpeg = 'ffmpeg';
  return cachedFfmpeg;
}

export function getFfprobePath() {
  if (cachedFfprobe) return cachedFfprobe;
  if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) {
    cachedFfprobe = process.env.FFPROBE_PATH;
    return cachedFfprobe;
  }
  try {
    const mod = require('ffprobe-static');
    const resolved = unpackAsarPath(mod?.path);
    if (resolved) {
      cachedFfprobe = resolved;
      return cachedFfprobe;
    }
  } catch {
    // ignore and fallback to PATH
  }
  cachedFfprobe = 'ffprobe';
  return cachedFfprobe;
}
