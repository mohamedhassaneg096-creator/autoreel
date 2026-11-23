import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MOCK_PORT = 4399;
const TEST_PORT = 4311;

process.env.HOST = '127.0.0.1';
process.env.PORT = String(TEST_PORT);
process.env.LLM_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
process.env.ELEVENLABS_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.DEEPGRAM_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;

const { createMockServer } = await import('./mock-apis.mjs');
const { createServer } = await import('../server.mjs');
const { getProjectDir } = await import('../src-server/projects.mjs');

const mockServer = createMockServer();
const appServer = createServer();

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function waitForCondition(fn, timeoutMs = 90000, intervalMs = 350) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function run() {
  await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));
  await new Promise((r) => appServer.listen(TEST_PORT, '127.0.0.1', r));

  const base = `http://127.0.0.1:${TEST_PORT}`;
  console.log(`[e2e] Mock APIs on :${MOCK_PORT}, Reel Studio on :${TEST_PORT}`);

  try {
    // 1. Settings masking check
    const savedSettings = await fetchJson(`${base}/api/settings`, {
      method: 'PUT',
      body: JSON.stringify({
        llmApiKey: 'test-secret-key-4321',
        elevenLabsApiKey: 'el-secret-9876',
        deepgramApiKey: 'dg-secret-5555'
      })
    });
    assert.equal(savedSettings.llmApiKeyMasked, '••••••••4321');
    assert.equal(savedSettings.elevenLabsApiKeyMasked, '••••••••9876');
    assert.equal(savedSettings.deepgramApiKeyMasked, '••••••••5555');
    assert.ok(!JSON.stringify(savedSettings).includes('test-secret-key'));
    console.log('[e2e] Settings key masking passed.');

    // 2. Load voices check
    const voicesRes = await fetchJson(`${base}/api/voices`);
    assert.ok(Array.isArray(voicesRes.voices) && voicesRes.voices.length >= 2);
    console.log('[e2e] ElevenLabs /v1/voices check passed.');

    // 3. Create 10s project with script approval gate + auto for rest
    const created = await fetchJson(`${base}/api/projects`, {
      method: 'POST',
      body: JSON.stringify({
        topic: 'إزاي الأشعة السينية بتشوف عضمك؟',
        durationSec: 10,
        voiceMode: 'tts',
        approvals: {
          script: 'approval',
          voice: 'auto',
          timing: 'auto',
          storyboard: 'auto',
          render: 'auto'
        },
        autoStart: true
      })
    });
    const projectId = created.project.id;
    console.log(`[e2e] Created project ${projectId}`);

    // Connect SSE listener to verify real-time events
    const sseEvents = new Set();
    const sseAbort = new AbortController();
    fetch(`${base}/api/projects/${projectId}/events`, { signal: sseAbort.signal })
      .then(async (res) => {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          for (const line of buf.split('\n')) {
            if (line.startsWith('event:')) {
              sseEvents.add(line.slice(6).trim());
            }
          }
          buf = '';
        }
      })
      .catch(() => {});

    // 4. Wait for script stage to reach 'review'
    const scriptData = await waitForCondition(async () => {
      const d = await fetchJson(`${base}/api/projects/${projectId}`);
      if (d.project.stages.script.status === 'error') {
        throw new Error(`Script error: ${d.project.stages.script.error}`);
      }
      return d.project.stages.script.status === 'review' ? d : null;
    });

    assert.ok(!scriptData.scriptText.includes('<think>'), 'Script must not contain <think> tags');
    assert.ok(scriptData.scriptText.includes('X-rays') || scriptData.scriptText.includes('Calcium'));
    console.log('[e2e] Script stage reached review (<think> stripped). Approving...');

    // 5. Approve script -> voice -> timing -> storyboard -> render
    await fetchJson(`${base}/api/projects/${projectId}/stages/script/approve`, { method: 'POST' });

    const finalData = await waitForCondition(async () => {
      const d = await fetchJson(`${base}/api/projects/${projectId}`);
      for (const st of ['script', 'voice', 'timing', 'storyboard', 'render']) {
        if (d.project.stages[st].status === 'error') {
          throw new Error(`Stage ${st} failed: ${d.project.stages[st].error}`);
        }
      }
      return d.project.stages.render.status === 'done' ? d : null;
    }, 180000);

    for (const st of ['script', 'voice', 'timing', 'storyboard', 'render']) {
      assert.equal(finalData.project.stages[st].status, 'done', `Stage ${st} must be done`);
    }
    console.log('[e2e] All 5 pipeline stages completed!');

    // 6. Verify SSE events
    for (const ev of ['state', 'llm_chunk', 'render_progress', 'preview_frame']) {
      assert.ok(sseEvents.has(ev), `Expected SSE event "${ev}", saw: ${[...sseEvents].join(', ')}`);
    }
    console.log('[e2e] SSE events verified:', [...sseEvents].join(', '));

    // 7. Verify output.mp4 with ffprobe
    const projDir = getProjectDir(projectId);
    const mp4Path = path.join(projDir, 'output.mp4');
    const sheetPath = path.join(projDir, 'contact_sheet.jpg');
    assert.ok(fs.existsSync(mp4Path), 'output.mp4 must exist');
    assert.ok(fs.existsSync(sheetPath), 'contact_sheet.jpg must exist');

    const { stdout: probeRaw } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_streams',
      '-show_format',
      '-of', 'json',
      mp4Path
    ]);
    const probe = JSON.parse(probeRaw);
    const vStream = probe.streams.find((s) => s.codec_type === 'video');
    const aStream = probe.streams.find((s) => s.codec_type === 'audio');
    assert.equal(vStream.width, 1080);
    assert.equal(vStream.height, 1920);
    assert.equal(vStream.codec_name, 'h264');
    assert.equal(vStream.pix_fmt, 'yuv420p');
    assert.equal(aStream.codec_name, 'aac');
    const dur = parseFloat(probe.format.duration);
    assert.ok(dur >= 6 && dur <= 15, `Expected ~10s test reel, got ${dur}s`);
    console.log(`[e2e] Verified MP4: ${vStream.width}x${vStream.height} ${vStream.codec_name}/${vStream.pix_fmt}, ${aStream.codec_name}, ${dur.toFixed(2)}s`);

    // 8. Verify Deepgram upload timing + LCS path
    const voiceBuf = fs.readFileSync(path.join(projDir, 'voice.mp3'));
    const upRes = await fetch(`${base}/api/projects/${projectId}/voice/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'custom.mp3' },
      body: voiceBuf
    });
    assert.equal(upRes.status, 200);
    await fetchJson(`${base}/api/projects/${projectId}/stages/timing/run`, { method: 'POST' });
    const dgData = await waitForCondition(async () => {
      const d = await fetchJson(`${base}/api/projects/${projectId}`);
      return d.project.stages.timing.status === 'done' ? d : null;
    });
    assert.ok(dgData.alignedWords.length > 10);
    assert.ok(dgData.alignedWords.some((w) => w.weak), 'Expected weak words flagged when Deepgram differs from script');
    console.log(`[e2e] Deepgram upload + LCS alignment verified (${dgData.alignedWords.length} words, weak=${dgData.project.artifacts.weakWordCount}).`);

    sseAbort.abort();
    console.log('[e2e] ALL E2E CHECKS PASSED!');
    console.log(`[e2e] Test video: ${mp4Path}`);
    console.log(`[e2e] Contact sheet: ${sheetPath}`);
  } finally {
    appServer.close();
    mockServer.close();
  }
}

run().catch((err) => {
  console.error('[e2e] FAILED:', err);
  process.exit(1);
});
