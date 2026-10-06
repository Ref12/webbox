// boots interactive-shell VM image in headless chromium, then compiles dlls via base64 over the pty.
// usage: node run-interactive.mjs <url> <dll1> <Method1> [<dll2> <Method2> ...]   (run from dir containing node_modules/playwright-core)
import { chromium } from 'playwright-core'; import fs from 'node:fs';
const [url,...rest]=process.argv.slice(2);
const b=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const pg=await b.newPage(); pg.on('pageerror',e=>console.log('[err]',String(e).slice(0,300)));
const now=()=>Date.now(); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const t0=now(); await pg.goto(url); await pg.evaluate(()=>{window.startVM()});
const text=()=>pg.evaluate(()=>screenText());
async function until(re,max=900000){const s=now();for(;;){const t=await text();if(re.test(t))return now()-s;if(now()-s>max)throw new Error('timeout '+re+'\n'+t.slice(-1500));await sleep(100);}}
const out={};
out.boot_to_prompt_ms=await until(/[#$] $/m)+ (now()-t0 - 0) *0; out.boot_to_prompt_ms=now()-t0;
console.log('prompt after',out.boot_to_prompt_ms,'ms');
out.compiles=[];
let n=0;
for(let i=0;i<rest.length;i+=2){
  const dll=fs.readFileSync(rest[i]).toString('base64'), m=rest[i+1]; n++;
  const s=now(); const tag='END'+n+'MARK';
  const chunks=dll.match(/.{1,1000}/g); let cmd='rm -f /t.b64\n'; for(const c of chunks) cmd+='printf %s '+c+' >> /t.b64\n';
  if(process.env.SKIPUP) cmd='';
  else cmd+='base64 -d /t.b64 > /app/app.dll; ';
  cmd+=` DOTNET_JitDisasm=${m} dotnet /app/app.dll; echo E${'ND'}${n}MARK\n`;
  await pg.evaluate(c=>xterm.paste(c.replace(/\n/g,'\r')),cmd);
  // wait for the echoed marker on its own line (not the command line)
  await until(new RegExp('^END'+n+'MARK','m'));
  const ms=now()-s; out.compiles.push({dll:rest[i],method:m,ms}); console.log('compile',m,ms,'ms');
}
const t=await text(); console.log(t.split('\n').filter(l=>l.trim()).slice(-40).join('\n'));
fs.writeFileSync(process.env.OUT||'interactive.json',JSON.stringify(out,null,1));
await b.close();
