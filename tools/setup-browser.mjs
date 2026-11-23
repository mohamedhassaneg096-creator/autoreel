import { execSync } from 'node:child_process';
import fs from 'node:fs';

function hasSystemChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);
  return candidates.some((p) => fs.existsSync(p));
}

console.log('[setup] Installing Playwright Chromium...');
try {
  execSync('npx playwright install chromium', { stdio: 'inherit' });
  console.log('[setup] Playwright Chromium installed successfully.');
} catch (err) {
  console.warn('[setup] Playwright Chromium download failed:', err.message);
  if (hasSystemChrome()) {
    console.log('[setup] System Chrome detected — renderer will fall back to system Chrome channel.');
    process.exit(0);
  }
  console.warn('[setup] Continuing: system Chrome channel will be used at runtime if available.');
}
