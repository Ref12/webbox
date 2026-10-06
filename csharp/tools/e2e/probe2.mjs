import { chromium } from 'playwright-core'; import { spawn } from 'node:child_process';
const s = spawn(process.execPath, ['../cf-sim.mjs', '../../../_cf_site', '8132'], { stdio: 'ignore' }); await new Promise(r => setTimeout(r, 800));
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
for (const mt of [false, true]) { const p = await b.newPage(); p.on('console', m => /MONO_WASM|rror/.test(m.text()) && console.log('  [c]', m.text().slice(0, 160)));
  await p.goto('http://localhost:8132/csharp/mtprobe2.html'); await p.waitForFunction(() => window.result === 'ready');
  const t = Date.now(); try { console.log(mt ? 'threaded:' : 'single:', JSON.stringify(await Promise.race([p.evaluate((m) => window.run(m), mt), new Promise((_, rj) => setTimeout(() => rj(new Error('timeout 150s')), 150000))])), 'total ms', Date.now() - t); } catch (e) { console.log(mt ? 'threaded:' : 'single:', 'ERR', e.message.slice(0, 200)); } }
await b.close(); s.kill();