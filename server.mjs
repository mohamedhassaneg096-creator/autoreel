import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT_DIR,
  getPublicSettings,
  saveSettings,
  buildFontsCss,
  resolveFontFolder
} from './src-server/env.mjs';
import { loadIconLibrary } from './src-server/icons.mjs';
import { fetchElevenLabsVoices } from './src-server/voice.mjs';
import { convertUploadedAudioToMp3 } from './src-server/voice.mjs';
import { validateAndRepairStoryboard } from './src-server/storyboard.mjs';
import {
  STAGES,
  createProject,
  listProjects,
  loadProject,
  saveProject,
  deleteProject,
  writeProjectArtifact,
  readProjectArtifact,
  getProjectDir,
  addSSEClient,
  appendStageLog
} from './src-server/projects.mjs';
import { runStage, approveStage, cancelProjectRun } from './src-server/pipeline.mjs';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4301);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readBodyBuffer(req, maxBytes = 64 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('Request payload too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const buf = await readBodyBuffer(req, 4 * 1024 * 1024);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

function serveFileWithRange(req, res, filePath, contentType, downloadName = null) {
  if (!fs.existsSync(filePath)) {
    return sendError(res, 404, 'File not found');
  }
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

  const extraHeaders = {};
  if (downloadName) {
    extraHeaders['Content-Disposition'] = `inline; filename="${downloadName}"`;
  }

  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? Math.min(total - 1, parseInt(match[2], 10)) : total - 1;
      if (start >= total || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': contentType,
        ...extraHeaders
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    'Content-Length': total,
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  fs.createReadStream(filePath).pipe(res);
}

function serveStatic(res, absPath) {
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    return sendError(res, 404, 'Not found');
  }
  const ext = path.extname(absPath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(absPath).pipe(res);
}

function getLocalServerOrigin() {
  const connectHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  return `http://${connectHost}:${PORT}`;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
      const pathname = decodeURIComponent(url.pathname);
      const method = req.method || 'GET';

      // Static frontend routes
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return serveStatic(res, path.join(ROOT_DIR, 'web', 'index.html'));
      }
      if (method === 'GET' && (pathname === '/styles.css' || pathname === '/app.js')) {
        return serveStatic(res, path.join(ROOT_DIR, 'web', pathname.slice(1)));
      }
      if (method === 'GET' && pathname === '/render/render.html') {
        return serveStatic(res, path.join(ROOT_DIR, 'render', 'render.html'));
      }

      // Dynamic fonts API
      if (method === 'GET' && pathname === '/api/fonts/css') {
        const css = buildFontsCss();
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(css);
      }
      if (method === 'GET' && pathname.startsWith('/api/fonts/file/')) {
        const fileName = path.basename(pathname.slice('/api/fonts/file/'.length));
        const fontDir = resolveFontFolder();
        const target = path.join(fontDir, fileName);
        if (!target.startsWith(fontDir)) return sendError(res, 403, 'Forbidden');
        return serveStatic(res, target);
      }

      // Settings API
      if (method === 'GET' && pathname === '/api/settings') {
        return sendJson(res, 200, getPublicSettings());
      }
      if (method === 'PUT' && pathname === '/api/settings') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, saveSettings(body));
      }

      // Voices API (ElevenLabs)
      if (method === 'GET' && pathname === '/api/voices') {
        const voices = await fetchElevenLabsVoices();
        return sendJson(res, 200, { voices });
      }

      // Icons metadata API
      if (method === 'GET' && pathname === '/api/icons') {
        const lib = loadIconLibrary();
        const summary = Object.values(lib.icons).map((ic) => ({
          id: ic.id,
          source: ic.source,
          license: ic.license,
          tags: ic.tags
        }));
        return sendJson(res, 200, { licenses: lib.licenses, count: summary.length, icons: summary });
      }

      // Projects collection
      if (method === 'GET' && pathname === '/api/projects') {
        return sendJson(res, 200, { projects: listProjects() });
      }
      if (method === 'POST' && pathname === '/api/projects') {
        const body = await readJsonBody(req);
        if (!body.topic || !String(body.topic).trim()) {
          return sendError(res, 400, 'الموضوع مطلوب');
        }
        const project = createProject({
          topic: body.topic,
          durationSec: body.durationSec,
          voiceId: body.voiceId,
          voiceMode: body.voiceMode,
          approvals: body.approvals
        });
        if (body.autoStart) {
          const origin = getLocalServerOrigin();
          setImmediate(() => {
            runStage(project.id, 'script', { serverOrigin: origin }).catch(() => {});
          });
        }
        return sendJson(res, 201, { project });
      }

      // Project item routes: /api/projects/:id...
      const projMatch = pathname.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
      if (projMatch) {
        const projectId = projMatch[1];
        const sub = projMatch[2] || '';
        const project = loadProject(projectId);
        if (!project) return sendError(res, 404, 'المشروع غير موجود');

        if (method === 'GET' && sub === '') {
          const scriptText = readProjectArtifact(projectId, 'script.txt', false) || project.artifacts.scriptText || '';
          const alignedWords = readProjectArtifact(projectId, 'aligned_words.json', true) || [];
          const storyboard = readProjectArtifact(projectId, 'storyboard.json', true) || null;
          const icons = readProjectArtifact(projectId, 'icons.json', true) || {};
          return sendJson(res, 200, { project, scriptText, alignedWords, storyboard, icons });
        }

        if (method === 'DELETE' && sub === '') {
          cancelProjectRun(projectId);
          deleteProject(projectId);
          return sendJson(res, 200, { deleted: true });
        }

        if (method === 'PATCH' && sub === '') {
          const body = await readJsonBody(req);
          if (body.durationSec) project.durationSec = Number(body.durationSec);
          if (typeof body.voiceId === 'string') project.voiceId = body.voiceId;
          if (body.voiceMode === 'tts' || body.voiceMode === 'upload') project.voiceMode = body.voiceMode;
          if (body.approvals && typeof body.approvals === 'object') {
            for (const st of STAGES) {
              if (body.approvals[st] === 'auto' || body.approvals[st] === 'approval') {
                project.stages[st].mode = body.approvals[st];
              }
            }
          }
          saveProject(project);
          return sendJson(res, 200, { project });
        }

        // SSE stream
        if (method === 'GET' && sub === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          });
          res.write(`event: state\ndata: ${JSON.stringify(project)}\n\n`);
          addSSEClient(projectId, res);
          return;
        }

        // Cancel running stage
        if (method === 'POST' && sub === '/cancel') {
          const cancelled = cancelProjectRun(projectId);
          return sendJson(res, 200, { cancelled, project: loadProject(projectId) });
        }

        // Upload custom voice-over file
        if (method === 'POST' && sub === '/voice/upload') {
          const ct = req.headers['content-type'] || '';
          const projectDir = getProjectDir(projectId);
          let rawBuf;
          let ext = '.mp3';

          if (ct.includes('application/json')) {
            const body = await readJsonBody(req);
            if (!body.base64) return sendError(res, 400, 'Missing base64 audio');
            const cleanB64 = String(body.base64).replace(/^data:[^;]+;base64,/, '');
            rawBuf = Buffer.from(cleanB64, 'base64');
            ext = path.extname(body.filename || 'voice.mp3') || '.mp3';
          } else {
            rawBuf = await readBodyBuffer(req, 50 * 1024 * 1024);
            const fname = req.headers['x-filename'] || 'voice.mp3';
            ext = path.extname(String(fname)) || '.mp3';
          }

          const rawPath = path.join(projectDir, `uploaded_audio${ext}`);
          fs.writeFileSync(rawPath, rawBuf);
          const voiceMp3 = path.join(projectDir, 'voice.mp3');
          const conv = await convertUploadedAudioToMp3({ inputPath: rawPath, outputPath: voiceMp3 });

          const fresh = loadProject(projectId);
          fresh.voiceMode = 'upload';
          fresh.artifacts.hasAudio = true;
          fresh.artifacts.audioDuration = conv.duration;
          fresh.stages.voice.status = 'done';
          saveProject(fresh);
          appendStageLog(projectId, 'voice', `تم رفع ملف صوتي مخصص (${conv.duration.toFixed(2)} ثانية).`);
          return sendJson(res, 200, { project: loadProject(projectId) });
        }

        // Media files
        if (method === 'GET' && sub === '/media/voice.mp3') {
          return serveFileWithRange(req, res, path.join(getProjectDir(projectId), 'voice.mp3'), 'audio/mpeg');
        }
        if (method === 'GET' && sub === '/media/output.mp4') {
          return serveFileWithRange(req, res, path.join(getProjectDir(projectId), 'output.mp4'), 'video/mp4', `${projectId}.mp4`);
        }
        if (method === 'GET' && sub === '/media/contact_sheet.jpg') {
          return serveFileWithRange(req, res, path.join(getProjectDir(projectId), 'contact_sheet.jpg'), 'image/jpeg');
        }

        // Stage actions: /stages/:stage/:action?
        const stageMatch = sub.match(/^\/stages\/([^/]+)(\/(run|approve))?$/);
        if (stageMatch) {
          const stage = stageMatch[1];
          const action = stageMatch[3] || '';
          if (!STAGES.includes(stage)) return sendError(res, 400, 'مرحلة غير صالحة');

          if (method === 'POST' && action === 'run') {
            const origin = getLocalServerOrigin();
            setImmediate(() => {
              runStage(projectId, stage, { serverOrigin: origin }).catch(() => {});
            });
            return sendJson(res, 202, { started: stage, project: loadProject(projectId) });
          }

          if (method === 'POST' && action === 'approve') {
            const updated = await approveStage(projectId, stage, { serverOrigin: getLocalServerOrigin() });
            return sendJson(res, 200, { project: updated });
          }

          if (method === 'PUT' && action === '') {
            const body = await readJsonBody(req);
            if (stage === 'script') {
              if (typeof body.title === 'string') project.title = body.title.trim();
              if (Array.isArray(body.sources)) project.sources = body.sources;
              if (typeof body.scriptText === 'string') {
                project.artifacts.scriptText = body.scriptText.trim();
                writeProjectArtifact(projectId, 'script.txt', project.artifacts.scriptText);
              }
              saveProject(project);
              appendStageLog(projectId, 'script', 'تم حفظ تعديلات السكريبت يدوياً.');
              return sendJson(res, 200, { project: loadProject(projectId) });
            }
            if (stage === 'timing') {
              if (!Array.isArray(body.words)) return sendError(res, 400, 'words array required');
              const words = body.words.map((w, idx) => ({
                ...w,
                index: idx,
                start: Number(w.start) || 0,
                end: Math.max((Number(w.start) || 0) + 0.06, Number(w.end) || 0.1),
                weak: Boolean(w.weak)
              }));
              writeProjectArtifact(projectId, 'aligned_words.json', words);
              project.artifacts.wordCount = words.length;
              project.artifacts.weakWordCount = words.filter((w) => w.weak).length;
              saveProject(project);
              appendStageLog(projectId, 'timing', 'تم تحديث توقيتات الكلمات يدوياً.');
              return sendJson(res, 200, { project: loadProject(projectId), alignedWords: words });
            }
            if (stage === 'storyboard') {
              const alignedWords = readProjectArtifact(projectId, 'aligned_words.json', true) || [];
              const repaired = validateAndRepairStoryboard(body.storyboard, alignedWords);
              writeProjectArtifact(projectId, 'storyboard.json', repaired.storyboard);
              writeProjectArtifact(projectId, 'icons.json', repaired.icons);
              project.artifacts.sceneCount = repaired.storyboard.scenes.length;
              saveProject(project);
              appendStageLog(projectId, 'storyboard', 'تم حفظ وإصلاح الستوري بورد يدوياً.');
              return sendJson(res, 200, {
                project: loadProject(projectId),
                storyboard: repaired.storyboard,
                icons: repaired.icons
              });
            }
          }
        }
      }

      sendError(res, 404, 'Endpoint not found');
    } catch (err) {
      console.error('[server error]', err);
      if (!res.headersSent) {
        sendError(res, 500, err.message || 'Internal Server Error');
      }
    }
  });
}

// Start server when run directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Reel Studio v1 listening on http://${HOST}:${PORT}`);
  });
}
