// PWA check: node pwa.mjs <url of launcher, ending in />  [--apps]  (installability via CDP + console errors + csharp isolation)
import {chromium} from 'playwright-core';
const url=process.argv[2], apps=process.argv.includes('--apps');
const ctx=await chromium.launchPersistentContext('/tmp/pwa-prof-'+Date.now(),{executablePath:'/usr/bin/chromium',args:['--no-sandbox']});const b=ctx;const pg=await ctx.newPage();const errs=[];
pg.on('console',m=>{if(m.type()==='error')errs.push(m.text())});pg.on('pageerror',e=>errs.push(String(e)));
await pg.goto(url);await pg.evaluate(()=>navigator.serviceWorker.ready);await pg.reload();
const cdp=await ctx.newCDPSession(pg);
const man=await pg.evaluate(async()=>{const l=document.querySelector('link[rel=manifest]').href;return {l,j:await (await fetch(l)).json(),ctl:!!navigator.serviceWorker.controller,sw:(await navigator.serviceWorker.getRegistrations()).map(r=>r.scope)}});
const inst=await cdp.send('Page.getInstallabilityErrors');const appId=await cdp.send('Page.getAppId').catch(e=>String(e));
console.log(JSON.stringify({manifest:man.l,scope:man.j.scope,start:man.j.start_url,controlled:man.ctl,swScopes:man.sw,installErrors:inst.installabilityErrors,appId}));
const links=await pg.$$eval('a',as=>as.map(a=>[a.getAttribute('href'),a.target,a.rel]));console.log(JSON.stringify(links.filter(l=>/^https?:/.test(l[0]))));
if(apps){for(const a of ['csharp/','fuget/','sharplab/']){const p=await ctx.newPage();const e=[];p.on('console',m=>{if(m.type()==='error')e.push(m.text())});p.on('pageerror',x=>e.push(String(x)));
 await p.goto(new URL(a,url).href,{waitUntil:'load'});await p.waitForTimeout(8000);console.log(a,'isolated',await p.evaluate(()=>crossOriginIsolated),'ctl',await p.evaluate(()=>!!navigator.serviceWorker.controller),'errors',JSON.stringify(e));await p.close();}}
console.log('launcher errors',JSON.stringify(errs));await b.close();