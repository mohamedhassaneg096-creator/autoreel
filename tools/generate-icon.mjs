import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const OUT_PNG = path.join(ROOT, 'assets', 'icon.png');
const OUT_ICO = path.join(ROOT, 'assets', 'icon.ico');

// Build a valid Windows multi-size .ico wrapping PNG images (Vista+ standard)
function buildIcoFromPngBuffers(entries) {
  const count = entries.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + count * dirEntrySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(count, 4);

  const dirBuffers = [];
  const dataBuffers = [];

  for (const { size, buf } of entries) {
    const dir = Buffer.alloc(dirEntrySize);
    dir.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 means 256)
    dir.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 means 256)
    dir.writeUInt8(0, 2); // color palette
    dir.writeUInt8(0, 3); // reserved
    dir.writeUInt16LE(1, 4); // planes
    dir.writeUInt16LE(32, 6); // bpp
    dir.writeUInt32LE(buf.length, 8); // size
    dir.writeUInt32LE(offset, 12); // offset
    dirBuffers.push(dir);
    dataBuffers.push(buf);
    offset += buf.length;
  }

  return Buffer.concat([header, ...dirBuffers, ...dataBuffers]);
}

function buildSvgHtml(size) {
  return `<!doctype html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${size}px;
    height: ${size}px;
    background: transparent;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
</head>
<body>
  <svg width="${size}" height="${size}" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1A222B" />
        <stop offset="100%" stop-color="#0B0F14" />
      </linearGradient>
      <linearGradient id="playGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#3FE0F0" />
        <stop offset="100%" stop-color="#1E9EAD" />
      </linearGradient>
      <radialGradient id="glowGrad" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#27B8C7" stop-opacity="0.28" />
        <stop offset="100%" stop-color="#27B8C7" stop-opacity="0" />
      </radialGradient>
    </defs>
    <!-- Dark rounded square -->
    <rect x="8" y="8" width="240" height="240" rx="54" fill="url(#bgGrad)" stroke="#27B8C7" stroke-opacity="0.35" stroke-width="4" />
    <!-- Subtle inner glow -->
    <circle cx="128" cy="128" r="88" fill="url(#glowGrad)" />
    <!-- Subtle technical ring -->
    <circle cx="128" cy="128" r="74" fill="none" stroke="#27B8C7" stroke-opacity="0.22" stroke-width="2" />
    <!-- Crisp cyan play triangle (optically centered) -->
    <path d="M 103 82 C 103 75.5 110.2 71.6 115.8 75.1 L 178.5 119.1 C 183.4 122.5 183.4 129.8 178.5 133.2 L 115.8 177.2 C 110.2 180.7 103 176.8 103 170.3 Z" fill="url(#playGrad)" />
  </svg>
</body>
</html>`;
}

async function run() {
  fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const sizes = [16, 32, 48, 64, 128, 256];
    const icoEntries = [];
    for (const sz of sizes) {
      const page = await browser.newPage({
        viewport: { width: sz, height: sz },
        deviceScaleFactor: 1
      });
      await page.setContent(buildSvgHtml(sz));
      const buf = await page.screenshot({ type: 'png', omitBackground: true });
      icoEntries.push({ size: sz, buf });
      if (sz === 256) {
        fs.writeFileSync(OUT_PNG, buf);
      }
      await page.close();
    }
    fs.writeFileSync(OUT_ICO, buildIcoFromPngBuffers(icoEntries));
    console.log(`Generated ${OUT_PNG} and ${OUT_ICO}`);
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
