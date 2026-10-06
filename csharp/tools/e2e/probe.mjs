import { chromium } from 'playwright-core'; import { spawn } from 'node:child_process';
const s = spawn(process.execPath, ['../cf-sim.mjs', '../../../_cf_site', '8132'], { stdio: 'ignore' }); await new Promise(r => setTimeout(r, 800));
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
for (const w of ['', '1']) { const p = await b.newPage(); p.on('console', m => /MONO_WASM|rror/.test(m.text()) && console.log('  [c]', m.text().slice(0, 160))); await p.goto('http://localhost:8132/csharp/mtprobe.html' + (w ? '?w=1' : ''));
  try { await p.waitForFunction(() => window.result !== 'pending', null, { timeout: 60000 }); } catch {} console.log(w ? 'in worker:' : 'main thread:', await p.evaluate(() => window.result)); }
await b.close(); s.kill();