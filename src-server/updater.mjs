import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_VERSION, GITHUB_REPO } from './env.mjs';

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com'
]);

const state = {
  status: 'idle', // idle | checking | up_to_date | available | downloading | done | error
  currentVersion: APP_VERSION,
  latestVersion: null,
  releaseName: null,
  releaseNotes: '',
  releaseUrl: `https://github.com/${GITHUB_REPO}/releases`,
  assetName: null,
  downloadUrl: null,
  progress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  downloadedPath: null,
  message: '',
  error: null,
  checkedAt: null
};

let activeDownloadPromise = null;

export function normalizeVersion(ver) {
  return String(ver || '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0];
}

export function compareSemver(a, b) {
  const pa = normalizeVersion(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function getReleaseApiUrl() {
  if (process.env.UPDATE_API_URL) {
    return process.env.UPDATE_API_URL;
  }
  return `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
}

function isAllowedDownloadUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (process.env.UPDATE_API_URL) {
    try {
      const apiOrigin = new URL(process.env.UPDATE_API_URL).origin;
      if (parsed.origin === apiOrigin) return true;
    } catch {
      // ignore
    }
  }

  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (ALLOWED_DOWNLOAD_HOSTS.has(host)) return true;
  if (host.endsWith('.githubusercontent.com')) return true;
  return false;
}

function pickWindowsInstallerAsset(assets = []) {
  if (!Array.isArray(assets)) return null;
  const exeAssets = assets.filter(
    (a) => a && typeof a.name === 'string' && a.name.toLowerCase().endsWith('.exe') && !a.name.toLowerCase().endsWith('.blockmap')
  );
  if (exeAssets.length === 0) return null;
  const preferred = exeAssets.find((a) => /setup|installer|reel/i.test(a.name));
  return preferred || exeAssets[0];
}

export function getUpdateStatus() {
  return { ...state };
}

export async function checkForUpdates() {
  state.status = 'checking';
  state.error = null;
  state.message = 'جاري التحقق من وجود تحديثات...';

  const apiUrl = getReleaseApiUrl();
  try {
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': `Reel-Studio/${APP_VERSION}`,
        'Accept': 'application/vnd.github+json'
      }
    });

    if (res.status === 404) {
      state.status = 'up_to_date';
      state.latestVersion = APP_VERSION;
      state.checkedAt = new Date().toISOString();
      state.message = 'التطبيق محدّث بالفعل (لا توجد إصدارات أحدث منشورة بعد).';
      return getUpdateStatus();
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
    }

    const release = await res.json();
    const tag = normalizeVersion(release.tag_name || release.name || '');
    if (!tag) {
      throw new Error('لم يتم العثور على رقم إصدار صالح في GitHub Release');
    }

    state.latestVersion = tag;
    state.releaseName = release.name || `v${tag}`;
    state.releaseNotes = release.body || '';
    state.releaseUrl = release.html_url || `https://github.com/${GITHUB_REPO}/releases`;
    state.checkedAt = new Date().toISOString();

    const asset = pickWindowsInstallerAsset(release.assets);
    state.assetName = asset ? asset.name : null;
    state.downloadUrl = asset ? asset.browser_download_url : null;

    if (compareSemver(tag, APP_VERSION) > 0) {
      state.status = 'available';
      state.message = `يتوفر إصدار جديد: v${tag}`;
    } else {
      state.status = 'up_to_date';
      state.message = 'التطبيق محدّث بالفعل.';
    }

    return getUpdateStatus();
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
    state.checkedAt = new Date().toISOString();
    state.message = `خطأ أثناء التحقق من التحديثات: ${err.message}`;
    return getUpdateStatus();
  }
}

export async function downloadAndInstallUpdate({ launchInstaller = true } = {}) {
  if (activeDownloadPromise) {
    return activeDownloadPromise;
  }

  activeDownloadPromise = (async () => {
    try {
      if (!state.downloadUrl || state.status === 'idle' || state.status === 'error') {
        const checked = await checkForUpdates();
        if (checked.status === 'error') {
          return checked;
        }
        if (checked.status === 'up_to_date') {
          return checked;
        }
      }

      if (!state.downloadUrl) {
        throw new Error('لم يتم العثور على ملف التثبيت (.exe) في الإصدار الجديد.');
      }

      if (!isAllowedDownloadUrl(state.downloadUrl)) {
        throw new Error('رابط التنزيل غير موثوق.');
      }

      state.status = 'downloading';
      state.progress = 0;
      state.downloadedBytes = 0;
      state.totalBytes = 0;
      state.error = null;
      state.message = 'جاري تنزيل التحديث... (0%)';

      const res = await fetch(state.downloadUrl, {
        headers: { 'User-Agent': `Reel-Studio/${APP_VERSION}` },
        redirect: 'follow'
      });

      if (!res.ok) {
        throw new Error(`فشل تنزيل التحديث (HTTP ${res.status})`);
      }
      if (!isAllowedDownloadUrl(res.url || state.downloadUrl)) {
        throw new Error('تمت إعادة التوجيه إلى رابط غير موثوق.');
      }

      const contentLen = parseInt(res.headers.get('content-length') || '0', 10);
      state.totalBytes = Number.isFinite(contentLen) && contentLen > 0 ? contentLen : 0;

      const safeFileName = path.basename(state.assetName || `Reel-Studio-Setup-${state.latestVersion || 'latest'}.exe`)
        .replace(/[^a-zA-Z0-9._-]/g, '_');
      const destPath = path.join(os.tmpdir(), safeFileName);
      const partPath = `${destPath}.part`;

      const fileStream = fs.createWriteStream(partPath);
      try {
        if (!res.body) {
          throw new Error('استجابة التنزيل فارغة');
        }
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            await new Promise((resolve, reject) => {
              const ok = fileStream.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
              if (!ok) {
                fileStream.once('drain', resolve);
              }
            });
            state.downloadedBytes += value.length;
            if (state.totalBytes > 0) {
              state.progress = Math.min(99, Math.round((state.downloadedBytes / state.totalBytes) * 100));
              state.message = `جاري تنزيل التحديث... (${state.progress}%)`;
            } else {
              const mb = (state.downloadedBytes / (1024 * 1024)).toFixed(1);
              state.message = `جاري تنزيل التحديث... (${mb} MB)`;
            }
          }
        }
        await new Promise((resolve, reject) => {
          fileStream.end((err) => (err ? reject(err) : resolve()));
        });
      } catch (err) {
        fileStream.destroy();
        try { fs.unlinkSync(partPath); } catch {}
        throw err;
      }

      fs.renameSync(partPath, destPath);
      state.downloadedPath = destPath;
      state.progress = 100;
      state.status = 'done';
      state.message = 'تم تنزيل التحديث بنجاح! جاري التثبيت وإعادة التشغيل...';

      if (launchInstaller && process.platform === 'win32') {
        setTimeout(() => {
          try {
            const child = spawn(destPath, [], {
              detached: true,
              stdio: 'ignore',
              windowsHide: false
            });
            child.unref();
          } catch (spawnErr) {
            state.status = 'error';
            state.error = spawnErr.message;
            state.message = `تعذّر تشغيل ملف التحديث: ${spawnErr.message}`;
            return;
          }
          if (typeof globalThis.__REEL_STUDIO_QUIT_FOR_UPDATE__ === 'function') {
            globalThis.__REEL_STUDIO_QUIT_FOR_UPDATE__().catch(() => {});
          }
        }, 450);
      }

      return getUpdateStatus();
    } catch (err) {
      state.status = 'error';
      state.error = err.message;
      state.message = `خطأ أثناء التحديث: ${err.message}`;
      return getUpdateStatus();
    } finally {
      activeDownloadPromise = null;
    }
  })();

  return activeDownloadPromise;
}
