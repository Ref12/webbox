// Deep links: #/<id>/<version>/<lib|ref>/<tfm>/<assembly>/<namespace or type full name>?tab=docs|decompiled|diff|deps&m=<member doc id>&base=<version>
// A search is #/?q=<text>. Pure functions (unit-tested with `node --test`).

const enc = (s) => encodeURIComponent(s).replace(/%60/g, '`');   // keep generic arity (List`1) readable

export function parse(hash) {
  let h = String(hash || '').replace(/^#/, '');
  const qi = h.indexOf('?');
  const query = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '');
  if (qi >= 0) h = h.slice(0, qi);
  const seg = h.split('/').filter((s) => s.length).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const r = { id: seg[0] || '', version: seg[1] || '', kind: '', tfm: '', asm: seg[4] || '', name: seg.slice(5).join('/'), tab: query.get('tab') || 'docs', member: query.get('m') || '', base: query.get('base') || '', q: query.get('q') || '' };
  if (seg[2] === 'lib' || seg[2] === 'ref') { r.kind = seg[2]; r.tfm = seg[3] || ''; }
  else if (seg[2]) { r.kind = ''; }
  r.dir = r.kind && r.tfm ? r.kind + '/' + r.tfm : '';
  return r;
}

export function format(r) {
  if (!r.id) return r.q ? '#/?q=' + encodeURIComponent(r.q) : '#/';
  const parts = [r.id, r.version];
  if (r.dir || (r.kind && r.tfm)) {
    const dir = r.dir || r.kind + '/' + r.tfm;
    parts.push(...dir.split('/'));
    if (r.asm) { parts.push(r.asm); if (r.name) parts.push(r.name); }
  }
  let s = '#/' + parts.filter((p) => p !== undefined && p !== '').map(enc).join('/');
  const q = new URLSearchParams();
  if (r.tab && r.tab !== 'docs') q.set('tab', r.tab);
  if (r.member) q.set('m', r.member);
  if (r.base) q.set('base', r.base);
  const qs = q.toString().replace(/%3A/gi, ':').replace(/%60/g, '`');
  return qs ? s + '?' + qs : s;
}

/** Which type (exact full name) or namespace a route's last segment names, given the assembly's types. */
export function resolveName(types, name) {
  if (!name) return { type: null, ns: null };
  const t = types.find((x) => x.fullName === name);
  if (t) return { type: t, ns: t.namespace };
  if (types.some((x) => x.namespace === name || x.namespace.startsWith(name + '.'))) return { type: null, ns: name };
  return { type: null, ns: null };
}

/** The version listed just before `version` (older), or the newest older stable one; '' when it is the first. */
export function previousVersion(versions, version) {
  const i = versions.indexOf(version);
  if (i <= 0) return '';
  const pre = version.includes('-');
  for (let j = i - 1; j >= 0; j--) if (pre || !versions[j].includes('-')) return versions[j];
  return versions[i - 1];
}
