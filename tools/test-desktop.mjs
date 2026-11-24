import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-studio-userdata-'));
const MOCK_GH_PORT = 4412;
const APP_PORT = 4413;

let mockMode = 'available'; // 'available' | 'up_to_date' | 'error'
const fakeInstallerBytes = Buffer.from('MZ_FAKE_WINDOWS_NSIS_INSTALLER_PAYLOAD_FOR_TEST_'.repeat(2048));

const mockGithub = http.createServer((req, res) => {
  if (req.url === '/releases/latest') {
    if (mockMode === 'error') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'GitHub API temporary error' }));
      return;
    }
    const tag = mockMode === 'available' ? 'v9.9.9' : 'v1.0.0';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tag_name: tag,
      name: `Reel Studio ${tag}`,
      html_url: 'https://github.com/mohamedhassaneg096-creator/idea2video/releases',
      body: 'Release notes test',
      assets: [
        {
          name: `Reel-Studio-Setup-${tag.slice(1)}.exe`,
          browser_download_url: `http://127.0.0.1:${MOCK_GH_PORT}/download/Reel-Studio-Setup.exe`
        }
      ]
    }));
    return;
  }

  if (req.url === '/download/Reel-Studio-Setup.exe') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fakeInstallerBytes.length)
    });
    res.end(fakeInstallerBytes);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

process.env.REEL_STUDIO_DATA_DIR = tempUserData;
process.env.UPDATE_API_URL = `http://127.0.0.1:${MOCK_GH_PORT}/releases/latest`;
process.env.HOST = '127.0.0.1';
process.env.PORT = String(APP_PORT);

const { startServer } = await import('../server.mjs');
const { launchHeadlessBrowser } = await import('../src-server/renderer.mjs');

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

await new Promise((r) => mockGithub.listen(MOCK_GH_PORT, '127.0.0.1', r));
const appHandle = await startServer({ host: '127.0.0.1', port: APP_PORT });
let browser = null;

try {
  // 1. Verify /api/app/info and isolated userData dir
  const info = await fetchJson(`${appHandle.origin}/api/app/info`);
  assert.equal(info.repo, 'mohamedhassaneg096-creator/idea2video');
  assert.equal(info.dataDir, tempUserData);
  assert.ok(info.version);
  console.log('[test-desktop] /api/app/info OK:', info);

  // Verify settings write to isolated userData dir (not repo ./data)
  await fetchJson(`${appHandle.origin}/api/settings`, {
    method: 'PUT',
    body: JSON.stringify({ llmModel: 'desktop-test-model' })
  });
  assert.ok(fs.existsSync(path.join(tempUserData, 'settings.json')), 'Settings must be saved inside REEL_STUDIO_DATA_DIR');
  console.log('[test-desktop] Isolated REEL_STUDIO_DATA_DIR storage verified.');

  // 2. Verify updater states: up_to_date, error, available, download
  mockMode = 'up_to_date';
  const upToDate = await fetchJson(`${appHandle.origin}/api/update/check`, { method: 'POST' });
  assert.equal(upToDate.status, 'up_to_date');
  assert.ok(upToDate.message.includes('محدّث بالفعل'));

  mockMode = 'error';
  const errState = await fetchJson(`${appHandle.origin}/api/update/check`, { method: 'POST' });
  assert.equal(errState.status, 'error');
  assert.ok(errState.message.includes('خطأ'));

  mockMode = 'available';
  const availState = await fetchJson(`${appHandle.origin}/api/update/check`, { method: 'POST' });
  assert.equal(availState.status, 'available');
  assert.equal(availState.latestVersion, '9.9.9');
  assert.ok(availState.message.includes('يتوفر إصدار جديد'));

  const dlState = await fetchJson(`${appHandle.origin}/api/update/download-and-install`, {
    method: 'POST',
    body: JSON.stringify({ wait: true, launchInstaller: false })
  });
  assert.equal(dlState.status, 'done');
  assert.equal(dlState.progress, 100);
  assert.ok(dlState.downloadedPath && fs.existsSync(dlState.downloadedPath));
  assert.equal(fs.readFileSync(dlState.downloadedPath).length, fakeInstallerBytes.length);
  fs.unlinkSync(dlState.downloadedPath);
  console.log('[test-desktop] Updater state machine & download verified.');

  // 3. Browser UI test on Settings update panel + preserved workspace
  mockMode = 'available';
  browser = await launchHeadlessBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(appHandle.origin, { waitUntil: 'networkidle' });

  // Switch to Settings tab
  await page.click('button[data-view="settings"]');
  await page.waitForSelector('#app-current-version');
  const verText = await page.textContent('#app-current-version');
  assert.ok(verText.includes(info.version), `Expected version display, got ${verText}`);

  // Click Check for Updates
  await page.click('#btn-check-update');
  await page.waitForFunction(() => {
    const b = document.getElementById('update-status-banner');
    return b && !b.classList.contains('hidden') && b.textContent.includes('يتوفر إصدار جديد');
  });
  const availBadge = await page.textContent('#update-available-msg');
  assert.ok(availBadge.includes('9.9.9'), 'Expected available badge in Settings');

  const installDisabled = await page.isDisabled('#btn-install-update');
  assert.equal(installDisabled, false, 'Update button should be enabled when new version is available');

  // Verify Workspace tab still works and looks intact
  await page.click('button[data-view="workspace"]');
  assert.ok(await page.isVisible('#new-project-form'));
  console.log('[test-desktop] Browser UI Settings & Workspace verified.');

  console.log('[test-desktop] ALL DESKTOP & UPDATER TESTS PASSED!');
} finally {
  if (browser) await browser.close().catch(() => {});
  appHandle.server.close();
  mockGithub.close();
  fs.rmSync(tempUserData, { recursive: true, force: true });
}
