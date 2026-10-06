// Renders the app icons (a diff glyph) with headless Chromium: node make-icons.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const out = new URL('../icons/', import.meta.url).pathname; fs.mkdirSync(out, { recursive: true });
const br = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
for (const [name, size, maskable] of [['icon-192', 192, false], ['icon-512', 512, false], ['maskable-512', 512, true]]) {
  const p = await br.newPage({ viewport: { width: size, height: size } });
  const pad = maskable ? size * 0.16 : size * 0.06, r = maskable ? 0 : size * 0.2;
  await p.setContent('<body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0f6cbd" rx="' + r / size * 100 + '"/><g transform="translate(' + pad / size * 100 + ' ' + pad / size * 100 + ') scale(' + (1 - 2 * pad / size) + ')"><rect x="18" y="24" width="64" height="20" rx="3" fill="#fde7e9"/><rect x="18" y="56" width="64" height="20" rx="3" fill="#e7f5e6"/><path d="M28 34h20" stroke="#a4262c" stroke-width="5" stroke-linecap="round"/><path d="M28 66h20M38 56v20" stroke="#107c10" stroke-width="5" stroke-linecap="round" transform="translate(0 0)"/><path d="M58 34h14M58 66h14" stroke="#7a7574" stroke-width="5" stroke-linecap="round"/></g></svg></body>');
  await p.screenshot({ path: out + name + '.png', omitBackground: true });
}
await br.close();
