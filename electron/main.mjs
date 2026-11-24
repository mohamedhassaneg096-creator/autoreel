import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, shell } from 'electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Enforce single-instance desktop app
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Keep all settings, API keys, and projects in the OS userData folder so app updates never overwrite them
const userDataDir = path.join(app.getPath('userData'), 'data');
process.env.REEL_STUDIO_DATA_DIR = userDataDir;
globalThis.__REEL_STUDIO_DESKTOP__ = true;

let mainWindow = null;
let serverHandle = null;
let pipelineModule = null;
let isShuttingDown = false;

function getWindowIconPath() {
  if (process.platform === 'win32') {
    return path.join(ROOT_DIR, 'assets', 'icon.ico');
  }
  return path.join(ROOT_DIR, 'assets', 'icon.png');
}

function registerDesktopCaptureBridge() {
  globalThis.__REEL_STUDIO_CAPTURE_RENDERER__ = async ({
    serverOrigin,
    payload,
    totalFrames,
    fps,
    signal,
    onFrame
  }) => {
    const renderWin = new BrowserWindow({
      width: 1080,
      height: 1920,
      show: false,
      frame: false,
      useContentSize: true,
      enableLargerThanScreen: true,
      backgroundColor: '#0C1014',
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        zoomFactor: 1.5
      }
    });

    const cleanup = () => {
      if (!renderWin.isDestroyed()) {
        renderWin.destroy();
      }
    };

    const onAbort = () => cleanup();
    if (signal) {
      if (signal.aborted) {
        cleanup();
        throw new DOMException('Render aborted', 'AbortError');
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      renderWin.setContentSize(1080, 1920);
      await renderWin.loadURL(`${serverOrigin}/render/render.html`);
      renderWin.webContents.setZoomFactor(1.5);
      await renderWin.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      await renderWin.webContents.executeJavaScript(`window.setRenderData(${JSON.stringify(payload)}); true;`);

      for (let frame = 0; frame < totalFrames; frame++) {
        if (signal?.aborted) {
          throw new DOMException('Render aborted', 'AbortError');
        }
        const t = frame / fps;
        await renderWin.webContents.executeJavaScript(
          `window.drawFrame(${t}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));`
        );
        let image = await renderWin.webContents.capturePage();
        const size = image.getSize();
        if (size.width !== 1080 || size.height !== 1920) {
          image = image.resize({ width: 1080, height: 1920 });
        }
        const frameBuffer = image.toJPEG(93);
        await onFrame(frame, t, frameBuffer);
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      cleanup();
    }
  };
}

async function shutdownGracefully() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  try {
    if (pipelineModule && typeof pipelineModule.cancelAllRuns === 'function') {
      pipelineModule.cancelAllRuns();
    }
  } catch {
    // ignore
  }

  if (serverHandle && serverHandle.server) {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      serverHandle.server.close(done);
      if (typeof serverHandle.server.closeAllConnections === 'function') {
        serverHandle.server.closeAllConnections();
      }
      setTimeout(done, 1200);
    });
    serverHandle = null;
  }
}

async function createMainWindow(origin) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'Reel Studio',
    backgroundColor: '#0C1014',
    icon: getWindowIconPath(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 2500);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin !== origin) {
        shell.openExternal(url);
      }
    } catch {
      // ignore invalid URLs
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(origin);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerDesktopCaptureBridge();

  const serverMod = await import('../server.mjs');
  pipelineModule = await import('../src-server/pipeline.mjs');

  globalThis.__REEL_STUDIO_QUIT_FOR_UPDATE__ = async () => {
    await shutdownGracefully();
    app.exit(0);
  };

  serverHandle = await serverMod.startServer({
    host: '127.0.0.1',
    port: Number(process.env.PORT || 4301),
    fallbackEphemeral: true
  });

  await createMainWindow(serverHandle.origin);
}).catch(async (err) => {
  console.error('[Reel Studio desktop startup error]', err);
  await shutdownGracefully();
  app.exit(1);
});

app.on('window-all-closed', async () => {
  await shutdownGracefully();
  app.quit();
});

app.on('before-quit', async (event) => {
  if (!isShuttingDown) {
    event.preventDefault();
    await shutdownGracefully();
    app.quit();
  }
});
