import { chromium } from 'playwright-core';
import fs from 'node:fs';
const out = new URL('../docs/reference/', import.meta.url).pathname;
const B='https://dev.azure.com/dnceng-public/public/_git/dotnet-public-wiki';
const pages = {
  'pr-files': B+'/pullrequest/5?_a=files',
  'pr-overview': B+'/pullrequest/5?_a=overview',
  'pr-updates': B+'/pullrequest/5?_a=updates',
  'pr-commits': B+'/pullrequest/5?_a=commits',
  'compare-files': B+'/branchCompare?baseVersion=GC4728a89a4e2f5cfdfecd0e216d864e649d9cb28a&targetVersion=GCaf56d96fdbd7c26e9fc94336b6f50dcc6ceff484&_a=files',
  'commit': B+'/commit/cd6039e649dcf41c410d9e970d391165cf9b8124',
};
const br = await chromium.launch({ executablePath:'/usr/bin/chromium', args:['--no-sandbox'] });
const only = process.argv[2];
for (const [name,url] of Object.entries(pages)) {
  if (only && only!==name) continue;
  for (const [vn,vp] of [['desktop',{width:1600,height:1000}],['phone',{width:390,height:844}]]) {
    const ctx = await br.newContext({ viewport:vp, isMobile: vn==='phone', deviceScaleFactor:1 });
    const p = await ctx.newPage();
    await p.goto(url,{waitUntil:'domcontentloaded'}).catch(e=>console.log(name,e.message));
    await p.waitForTimeout(9000);
    await p.screenshot({path: out+name+'-'+vn+'.png'});
    if (vn==='desktop') {
      const labels = await p.evaluate(()=>[...document.querySelectorAll('button,[role=tab],[role=button],a[role=menuitem],input')].map(e=>(e.getAttribute('aria-label')||e.innerText||e.placeholder||'').trim().slice(0,50)).filter(Boolean));
      console.log(name, JSON.stringify([...new Set(labels)]));
    }
    await ctx.close();
  }
}
await br.close();
