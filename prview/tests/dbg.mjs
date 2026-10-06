import { start, PR } from './harness.mjs';
const LINK='src/tools/illink/src/ILLink.Tasks/LinkTask.cs';
for (const qs of ['', '&m=split', '&v=one', '&v=one&m=split', '&x=1']) {
  const h = await start(); const p = h.page;
  await p.goto(h.base + PR + '?f=' + LINK + qs);
  await p.waitForSelector('.row');
  await p.waitForTimeout(3500);
  console.log(qs, await p.evaluate(() => { const s = window.__prview.state; const d = document.querySelector('#diff'); return { top: d.scrollTop, sel: s.selected, heads: [...document.querySelectorAll('#win .fh')].map(x => x.dataset.path.split('/').pop()), threads: document.querySelectorAll('#win .thread').length, ci: [...(s.cIndex.get('LINK')?.R?.keys() || [])], shown: s.commentsShown, nthreads: s.threads.length, view: s.view, status: s.fl.find(f=>f.filename.endsWith('LinkTask.cs')).st.status, rows: document.querySelectorAll('#win .row').length }; }));
  await h.close();
}
