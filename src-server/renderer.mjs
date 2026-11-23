import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { generateWhooshWav, generateTickWav } from './sfx.mjs';
import { probeAudioDuration } from './voice.mjs';

const execFileAsync = promisify(execFile);

export async function launchHeadlessBrowser() {
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--font-render-hinting=none'
  ];

  // 1. Try Playwright bundled Chromium
  try {
    return await chromium.launch({ headless: true, args: launchArgs });
  } catch (err1) {
    // 2. Fallback to system Chrome channel
    try {
      return await chromium.launch({ headless: true, channel: 'chrome', args: launchArgs });
    } catch (err2) {
      // 3. Fallback to explicit system executable paths
      const candidates = [
        process.env.CHROME_PATH,
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
      ].filter(Boolean);
      for (const exe of candidates) {
        if (fs.existsSync(exe)) {
          return await chromium.launch({ headless: true, executablePath: exe, args: launchArgs });
        }
      }
      throw new Error(`Failed to launch Chromium or Chrome fallback: ${err1.message} / ${err2.message}`);
    }
  }
}

async function buildMixedAudio({ voicePath, cutTimes, workDir, totalDuration, signal }) {
  const whooshPath = path.join(workDir, 'sfx_whoosh.wav');
  const tickPath = path.join(workDir, 'sfx_tick.wav');
  const mixedAudioPath = path.join(workDir, 'mixed_audio.wav');

  generateWhooshWav(whooshPath);
  generateTickWav(tickPath);

  // Build ffmpeg filter_complex mixing voice + soft whoosh/tick on scene cuts, normalized to -14 LUFS
  const args = ['-y', '-i', voicePath];
  const validCuts = cutTimes.filter((t) => t > 0.15 && t < totalDuration - 0.1);

  if (validCuts.length === 0) {
    // Voice only, padded to totalDuration and normalized to -14 LUFS
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', voicePath,
      '-af', `apad=whole_dur=${totalDuration.toFixed(3)},loudnorm=I=-14:TP=-1.5:LRA=11`,
      '-ar', '48000',
      '-ac', '2',
      mixedAudioPath
    ], { signal });
    return mixedAudioPath;
  }

  // Add one whoosh + one tick input
  args.push('-i', whooshPath, '-i', tickPath);

  const filterParts = [];
  filterParts.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${totalDuration.toFixed(3)}[voice]`);

  const mixLabels = ['[voice]'];
  // Use asplit on whoosh [1:a] and tick [2:a] for each cut
  const wSplits = validCuts.map((_, i) => `[w${i}]`).join('');
  const tSplits = validCuts.map((_, i) => `[t${i}]`).join('');
  filterParts.push(`[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.30,asplit=${validCuts.length}${wSplits}`);
  filterParts.push(`[2:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.22,asplit=${validCuts.length}${tSplits}`);

  validCuts.forEach((cutSec, i) => {
    const wMs = Math.max(0, Math.round((cutSec - 0.08) * 1000));
    const tMs = Math.max(0, Math.round(cutSec * 1000));
    filterParts.push(`[w${i}]adelay=${wMs}|${wMs}[wd${i}]`);
    filterParts.push(`[t${i}]adelay=${tMs}|${tMs}[td${i}]`);
    mixLabels.push(`[wd${i}]`, `[td${i}]`);
  });

  filterParts.push(
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[outa]`
  );

  args.push(
    '-filter_complex', filterParts.join(';'),
    '-map', '[outa]',
    '-ar', '48000',
    '-ac', '2',
    mixedAudioPath
  );

  await execFileAsync('ffmpeg', args, { signal });
  return mixedAudioPath;
}

export async function generateContactSheet({ videoPath, outputPath, totalDuration, cols = 4, rows = 2 }) {
  const count = cols * rows;
  const interval = Math.max(0.25, totalDuration / count);
  const fpsVal = (1 / interval).toFixed(4);
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-vf', `fps=${fpsVal},scale=270:480,tile=${cols}x${rows}:padding=8:color=#0C1014`,
    '-frames:v', '1',
    '-q:v', '3',
    outputPath
  ]);
  return outputPath;
}

export async function renderProjectVideo({
  projectDir,
  serverOrigin,
  title,
  durationSec,
  words,
  storyboard,
  icons,
  onProgress,
  onPreviewFrame,
  onLog,
  signal
}) {
  const fps = 30;
  const voicePath = path.join(projectDir, 'voice.mp3');
  if (!fs.existsSync(voicePath)) {
    throw new Error('voice.mp3 not found; run voice stage first.');
  }

  const audioDur = await probeAudioDuration(voicePath);
  const lastWordEnd = words.length ? words[words.length - 1].end : 0;
  const totalDuration = Math.max(audioDur || 0, lastWordEnd + 0.35, durationSec ? Math.min(durationSec, Math.max(audioDur, lastWordEnd + 0.35)) : 10);
  const totalFrames = Math.max(30, Math.ceil(totalDuration * fps));

  // Scene cut timestamps for SFX
  const cutTimes = (storyboard.scenes || [])
    .slice(1)
    .map((sc) => (words[sc.at] ? words[sc.at].start : 0))
    .filter((t) => t > 0);

  if (onLog) onLog(`تجهيز الصوت والمؤثرات (${cutTimes.length} انتقالات) وضبط المستوى على -14 LUFS...`);
  const mixedAudioPath = await buildMixedAudio({
    voicePath,
    cutTimes,
    workDir: projectDir,
    totalDuration,
    signal
  });

  const outputVideoPath = path.join(projectDir, 'output.mp4');
  const contactSheetPath = path.join(projectDir, 'contact_sheet.jpg');

  if (onLog) onLog(`تشغيل Chromium (720×1280 @1.5x → 1080×1920) لتصوير ${totalFrames} إطاراً...`);

  const browser = await launchHeadlessBrowser();
  let ffmpegProc = null;

  const onAbort = () => {
    if (ffmpegProc && !ffmpegProc.killed) {
      ffmpegProc.kill('SIGKILL');
    }
    browser.close().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      throw new DOMException('Render aborted', 'AbortError');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const context = await browser.newContext({
      viewport: { width: 720, height: 1280 },
      deviceScaleFactor: 1.5
    });
    const page = await context.newPage();

    const renderUrl = `${serverOrigin}/render/render.html`;
    await page.goto(renderUrl, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    await page.evaluate((payload) => {
      window.setRenderData(payload);
    }, {
      title,
      duration: totalDuration,
      words,
      storyboard,
      icons
    });

    // Spawn ffmpeg stdin MJPEG pipe + mixed audio -> H.264 yuv420p MP4
    ffmpegProc = spawn('ffmpeg', [
      '-y',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-r', String(fps),
      '-i', '-',
      '-i', mixedAudioPath,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-crf', '18',
      '-movflags', '+faststart',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-shortest',
      outputVideoPath
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    let ffmpegStderr = '';
    ffmpegProc.stderr.on('data', (chunk) => {
      ffmpegStderr += chunk.toString();
      if (ffmpegStderr.length > 4000) ffmpegStderr = ffmpegStderr.slice(-4000);
    });

    const ffmpegExitPromise = new Promise((resolve, reject) => {
      ffmpegProc.on('error', reject);
      ffmpegProc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${ffmpegStderr.slice(-300)}`));
      });
    });

    for (let frame = 0; frame < totalFrames; frame++) {
      if (signal?.aborted) {
        throw new DOMException('Render aborted', 'AbortError');
      }

      const t = frame / fps;
      await page.evaluate((timeSec) => window.drawFrame(timeSec), t);
      const frameBuffer = await page.screenshot({ type: 'jpeg', quality: 93 });

      const canContinue = ffmpegProc.stdin.write(frameBuffer);
      if (!canContinue) {
        await new Promise((res) => ffmpegProc.stdin.once('drain', res));
      }

      if (frame === 0 || frame % 12 === 0 || frame === totalFrames - 1) {
        const percent = Math.round(((frame + 1) / totalFrames) * 100);
        if (onProgress) {
          onProgress({ frame: frame + 1, totalFrames, percent, timeSec: Number(t.toFixed(2)) });
        }
        if (onPreviewFrame) {
          onPreviewFrame({
            frame: frame + 1,
            totalFrames,
            timeSec: Number(t.toFixed(2)),
            dataUrl: `data:image/jpeg;base64,${frameBuffer.toString('base64')}`
          });
        }
      }
    }

    ffmpegProc.stdin.end();
    await ffmpegExitPromise;

    if (onLog) onLog('توليد لوحة المعاينة (contact_sheet.jpg)...');
    await generateContactSheet({
      videoPath: outputVideoPath,
      outputPath: contactSheetPath,
      totalDuration
    });

    if (onLog) onLog(`اكتمل الريندر (${totalFrames} إطار، ${totalDuration.toFixed(2)} ثانية، 1080×1920).`);
    return {
      outputVideoPath,
      contactSheetPath,
      totalFrames,
      duration: totalDuration
    };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
}
