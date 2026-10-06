import { chromium } from 'playwright-core';
const out = new URL('../docs/reference/', import.meta.url).pathname;
const B='https://dev.azure.com/dnceng-public/public/_git/dotnet-public-wiki';
const pages = {
  'pr-files': B+'/pullrequest/5?_a=files',
  'compare-files': B+'/branchCompare?baseVersion=GC4728a89a4e2f5cfdfecd0e216d864e649d9cb28a&targetVersion=GCaf56d96fdbd7c26e9fc94336b6f50dcc6ceff484&_a=files',
  'commit': B+'/commit/cd6039e649dcf41c410d9e970d391165cf9b8124',
};
const br = await chromium.launch({ executablePath:'/usr/bin/chromium', args:['--no-sandbox'] });
const log=(...a)=>console.log(...a);
for (const [name,url] of Object.entries(pages)) {
  const ctx = await br.newContext({ viewport:{width:1600,height:1000} });
  const p = await ctx.newPage(); p.setDefaultTimeout(6000);
  await p.goto(url,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(8000);
  const shot = async s => { await p.waitForTimeout(1200); await p.screenshot({path: out+name+'-'+s+'.png'}); };
  const step = async (s, fn) => { try { await fn(); await shot(s); log(name, s, 'ok'); } catch(e){ log(name, s, 'FAIL', e.message.split('\n')[0]); } };
  await step('side-by-side', async()=>{ await p.locator('button[aria-label*="mode"], button:has-text("Inline")').first().click(); });
  await step('mode-dropdown', async()=>{ await p.locator('button[aria-label="More actions"]').first().click(); log(name,'actions', JSON.stringify(await p.locator('.ms-ContextualMenu-item, [role=menuitemcheckbox], [role=menuitem]').allInnerTexts())); });
  await p.keyboard.press('Escape');
  await step('collapsed', async()=>{ await p.locator('[aria-expanded=true][aria-label*="ollapse"], button[aria-label*="ollapse"]').first().click(); });
  await step('expanded', async()=>{ await p.locator('button[aria-label*="xpand"]').first().click(); });
  await step('filter-open', async()=>{ await p.locator('button:has-text("Filter")').first().click(); });
  await step('filter-typed', async()=>{ await p.keyboard.type('Home'); });
  await p.keyboard.press('Escape');
  await step('view', async()=>{ await p.locator('a:has-text("View"), button:has-text("View")').first().click(); await p.waitForTimeout(4000); });
  if (name==='commit') { await step('file-url', async()=>{ log(p.url()); }); }
  await ctx.close();
}
await br.close();
