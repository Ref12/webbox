// usage: node run-browser.mjs <webdir-url> ; measures TTFO in headless chromium
import { chromium } from 'playwright-core';
const url=process.argv[2]||'http://127.0.0.1:8099/';
const b=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const pg=await b.newPage(); pg.on('console',m=>console.log('[console]',m.text().slice(0,200))); pg.on('pageerror',e=>console.log('[err]',String(e).slice(0,300)));
const t0=Date.now(); await pg.goto(url); await pg.evaluate(()=>{window.startVM()});
let last='';
while(Date.now()-t0<+(process.env.TIMEOUT||900)*1000){
  await new Promise(r=>setTimeout(r,3000));
  const t=await pg.evaluate(()=>screenText()); 
  if(t!==last){last=t;console.log('--- t='+((Date.now()-t0)/1000)+'s\n'+t.trim().split('\n').slice(-8).join('\n'));}
  if(/Total bytes of code/.test(t)){console.log('TTFO_s',(Date.now()-t0)/1000);break;}
}
await b.close();
