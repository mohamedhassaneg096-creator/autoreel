import fs from 'node:fs';
import path from 'node:path';

export const ROOT_DIR = process.cwd();
export const DATA_DIR = path.resolve(ROOT_DIR, 'data');
export const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
export const DEFAULT_FONT_FOLDER = 'assets/fonts';

const dotEnv = {};

export function loadDotEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    dotEnv[key] = val;
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadDotEnv();

function readSettingsFile() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function maskKey(key) {
  if (!key || typeof key !== 'string') return '';
  const clean = key.trim();
  if (!clean) return '';
  if (clean.length <= 4) return '••••';
  return '••••••••' + clean.slice(-4);
}

export function getEffectiveSettings() {
  const file = readSettingsFile();

  const envLlmBase = process.env.LLM_BASE_URL || process.env.FREELLM_BASE_URL;
  const envElBase = process.env.ELEVENLABS_BASE_URL;
  const envDgBase = process.env.DEEPGRAM_BASE_URL;

  const llmBaseUrl = envLlmBase || file.llmBaseUrl || dotEnv.LLM_BASE_URL || 'http://127.0.0.1:31415/v1';
  const llmApiKey = (file.llmApiKey !== undefined && file.llmApiKey !== '')
    ? file.llmApiKey
    : (process.env.LLM_API_KEY || dotEnv.LLM_API_KEY || '');
  const llmModel = process.env.LLM_MODEL || file.llmModel || dotEnv.LLM_MODEL || 'auto';

  const elevenLabsBaseUrl = envElBase || file.elevenLabsBaseUrl || dotEnv.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';
  const elevenLabsApiKey = (file.elevenLabsApiKey !== undefined && file.elevenLabsApiKey !== '')
    ? file.elevenLabsApiKey
    : (process.env.ELEVENLABS_API_KEY || dotEnv.ELEVENLABS_API_KEY || '');
  const elevenLabsVoiceId = file.elevenLabsVoiceId || process.env.ELEVENLABS_VOICE_ID || dotEnv.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  const deepgramBaseUrl = envDgBase || file.deepgramBaseUrl || dotEnv.DEEPGRAM_BASE_URL || 'https://api.deepgram.com';
  const deepgramApiKey = (file.deepgramApiKey !== undefined && file.deepgramApiKey !== '')
    ? file.deepgramApiKey
    : (process.env.DEEPGRAM_API_KEY || dotEnv.DEEPGRAM_API_KEY || '');

  const fontFolder = file.fontFolder || process.env.FONT_FOLDER || dotEnv.FONT_FOLDER || DEFAULT_FONT_FOLDER;

  return {
    llmBaseUrl: llmBaseUrl.replace(/\/+$/, ''),
    llmApiKey,
    llmModel,
    elevenLabsBaseUrl: elevenLabsBaseUrl.replace(/\/+$/, ''),
    elevenLabsApiKey,
    elevenLabsVoiceId,
    deepgramBaseUrl: deepgramBaseUrl.replace(/\/+$/, ''),
    deepgramApiKey,
    fontFolder,
    envOverrides: {
      llmBaseUrl: Boolean(envLlmBase && envLlmBase !== dotEnv.LLM_BASE_URL),
      elevenLabsBaseUrl: Boolean(envElBase && envElBase !== dotEnv.ELEVENLABS_BASE_URL),
      deepgramBaseUrl: Boolean(envDgBase && envDgBase !== dotEnv.DEEPGRAM_BASE_URL),
    }
  };
}

export function getPublicSettings() {
  const s = getEffectiveSettings();
  return {
    llmBaseUrl: s.llmBaseUrl,
    llmApiKeyMasked: maskKey(s.llmApiKey),
    hasLlmApiKey: Boolean(s.llmApiKey),
    llmModel: s.llmModel,
    elevenLabsBaseUrl: s.elevenLabsBaseUrl,
    elevenLabsApiKeyMasked: maskKey(s.elevenLabsApiKey),
    hasElevenLabsApiKey: Boolean(s.elevenLabsApiKey),
    elevenLabsVoiceId: s.elevenLabsVoiceId,
    deepgramBaseUrl: s.deepgramBaseUrl,
    deepgramApiKeyMasked: maskKey(s.deepgramApiKey),
    hasDeepgramApiKey: Boolean(s.deepgramApiKey),
    fontFolder: s.fontFolder,
    envOverrides: s.envOverrides
  };
}

export function saveSettings(patch = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const existing = readSettingsFile();
  const next = { ...existing };

  if (typeof patch.llmBaseUrl === 'string' && patch.llmBaseUrl.trim()) {
    next.llmBaseUrl = patch.llmBaseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof patch.llmModel === 'string' && patch.llmModel.trim()) {
    next.llmModel = patch.llmModel.trim();
  }
  if (typeof patch.elevenLabsBaseUrl === 'string' && patch.elevenLabsBaseUrl.trim()) {
    next.elevenLabsBaseUrl = patch.elevenLabsBaseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof patch.elevenLabsVoiceId === 'string' && patch.elevenLabsVoiceId.trim()) {
    next.elevenLabsVoiceId = patch.elevenLabsVoiceId.trim();
  }
  if (typeof patch.deepgramBaseUrl === 'string' && patch.deepgramBaseUrl.trim()) {
    next.deepgramBaseUrl = patch.deepgramBaseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof patch.fontFolder === 'string') {
    next.fontFolder = patch.fontFolder.trim() || DEFAULT_FONT_FOLDER;
  }

  // Only update API keys if explicitly replaced (not masked placeholder) or cleared
  if (patch.clearLlmApiKey) {
    next.llmApiKey = '';
  } else if (typeof patch.llmApiKey === 'string' && patch.llmApiKey.trim() && !patch.llmApiKey.includes('••••')) {
    next.llmApiKey = patch.llmApiKey.trim();
  }

  if (patch.clearElevenLabsApiKey) {
    next.elevenLabsApiKey = '';
  } else if (typeof patch.elevenLabsApiKey === 'string' && patch.elevenLabsApiKey.trim() && !patch.elevenLabsApiKey.includes('••••')) {
    next.elevenLabsApiKey = patch.elevenLabsApiKey.trim();
  }

  if (patch.clearDeepgramApiKey) {
    next.deepgramApiKey = '';
  } else if (typeof patch.deepgramApiKey === 'string' && patch.deepgramApiKey.trim() && !patch.deepgramApiKey.includes('••••')) {
    next.deepgramApiKey = patch.deepgramApiKey.trim();
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return getPublicSettings();
}

export function resolveFontFolder() {
  const { fontFolder } = getEffectiveSettings();
  const abs = path.isAbsolute(fontFolder) ? fontFolder : path.resolve(ROOT_DIR, fontFolder);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return abs;
  }
  return path.resolve(ROOT_DIR, DEFAULT_FONT_FOLDER);
}

const FONT_FORMATS = {
  '.woff2': 'woff2',
  '.woff': 'woff',
  '.ttf': 'truetype',
  '.otf': 'opentype'
};

function inferWeight(filename) {
  const lower = filename.toLowerCase();
  if (lower.includes('extrabold') || lower.includes('black')) return 800;
  if (lower.includes('semibold') || lower.includes('demibold')) return 600;
  if (lower.includes('bold')) return 700;
  if (lower.includes('medium')) return 500;
  if (lower.includes('light')) return 300;
  return 400;
}

export function listFontFiles() {
  const dir = resolveFontFolder();
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && FONT_FORMATS[path.extname(e.name).toLowerCase()])
    .map((e) => {
      const ext = path.extname(e.name).toLowerCase();
      return {
        name: e.name,
        path: path.join(dir, e.name),
        format: FONT_FORMATS[ext],
        weight: inferWeight(e.name)
      };
    });
}

export function buildFontsCss() {
  const files = listFontFiles();
  if (files.length === 0) return '';
  // Prefer woff2 over ttf if same weight exists
  const byWeight = new Map();
  for (const f of files) {
    const prev = byWeight.get(f.weight);
    if (!prev || (f.format === 'woff2' && prev.format !== 'woff2')) {
      byWeight.set(f.weight, f);
    }
  }
  const rules = [];
  for (const f of byWeight.values()) {
    const url = `/api/fonts/file/${encodeURIComponent(f.name)}`;
    rules.push(`@font-face {
  font-family: 'ReelArabic';
  src: url('${url}') format('${f.format}');
  font-weight: ${f.weight};
  font-style: normal;
  font-display: swap;
}`);
  }
  return rules.join('\n\n');
}
