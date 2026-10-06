// HTML string helpers for the viewer (escaping, highlighted lines with word marks, small markdown, dates).

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** tokens [{c,s}] + word ranges [[start,end]] (character offsets into the line) -> html. cls is the mark class. */
export function lineHtml(tokens, ranges, cls = 'wd') {
  let out = '', pos = 0, r = 0;
  for (const t of tokens) {
    const end = pos + t.s.length;
    let inner = '', p = pos;
    while (p < end) {
      while (ranges && r < ranges.length && ranges[r][1] <= p) r++;
      const rg = ranges && r < ranges.length ? ranges[r] : null;
      if (rg && rg[0] <= p) { const e = Math.min(end, rg[1]); inner += '<mark class="' + cls + '">' + esc(t.s.slice(p - pos, e - pos)) + '</mark>'; p = e; }
      else { const e = rg ? Math.min(end, rg[0]) : end; inner += esc(t.s.slice(p - pos, e - pos)); p = e; }
    }
    out += t.c ? '<span class="t-' + t.c + '">' + inner + '</span>' : inner;
    pos = end;
  }
  return out;
}

const URL_RE = /(https?:\/\/[^\s<)]+)/g;
export function externalLink(url, text) { return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(text ?? url) + '</a>'; }

function inline(s) {
  // s is raw text: escape pieces ourselves so links and code can be built safely
  const parts = [];
  const re = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<)]+)|\*\*([^*\n]+)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    parts.push(esc(s.slice(last, m.index)));
    if (m[1] !== undefined) parts.push('<code>' + esc(m[1]) + '</code>');
    else if (m[2] !== undefined) parts.push(externalLink(m[3], m[2]));
    else if (m[4] !== undefined) parts.push(externalLink(m[4]));
    else parts.push('<b>' + esc(m[5]) + '</b>');
    last = re.lastIndex;
  }
  parts.push(esc(s.slice(last)));
  return parts.join('');
}

/** Just enough markdown for PR text and review comments: fences, suggestions, code, bold, links, paragraphs, lists, headings. */
export function mdLite(text) {
  const lines = String(text || '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const out = [];
  let i = 0, para = [];
  const flush = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      flush();
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push('<pre class="' + (fence[1] === 'suggestion' ? 'suggestion' : 'code') + '">' + (fence[1] === 'suggestion' ? '<i>Suggested change</i>\n' : '') + esc(body.join('\n')) + '</pre>');
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { flush(); out.push('<h4>' + inline(h[2]) + '</h4>'); i++; continue; }
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) { flush(); out.push('<div class="li">• ' + inline(li[1]) + '</div>'); i++; continue; }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line); i++;
  }
  flush();
  return out.join('');
}

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  const u = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [2592000, 'month'], [31536000, 'year']];
  let best = [1, 'second'];
  for (const x of u) if (s >= x[0]) best = x;
  const n = Math.floor(s / best[0]);
  return n + ' ' + best[1] + (n === 1 ? '' : 's') + ' ago';
}

export const shortSha = s => String(s || '').slice(0, 7);
