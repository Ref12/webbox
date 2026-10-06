// Checks the site works under a sub-path like GitHub Pages (/webbox/fuget/). Usage: node subpath.mjs <dirContainingWebbox>
import { chromium } from 'playwright-core'; import { spawn } from 'node:child_process'; import path from 'node:path'; import fs from 'node:fs';
const root = path.resolve(process.argv[2]);
const s = spawn(process.execPath, ['../serve.mjs', root, '8126'], { stdio: 'inherit' }); await new Promise((r) => setTimeout(r, 800));
const exe = process.env.CHROME_PATH || ['/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] }); const p = await b.newPage();
await p.goto('http://localhost:8126/webbox/fuget/#/Newtonsoft.Json/13.0.3/lib/net6.0/Newtonsoft.Json/Newtonsoft.Json.Linq.JObject');
await p.waitForFunction(() => window.__ready || window.__metrics?.error || window.__metrics?.lastError, null, { timeout: 120000 });
const m = await p.evaluate(() => window.__metrics); console.log('sub-path first view', m.marks.firstView, 'ms', m.error || m.lastError || 'ok');
await b.close(); s.kill(); process.exit(m.error || m.lastError ? 1 : 0);
