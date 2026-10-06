// A small syntax highlighter: per-language token regexes, line by line, with block comments carried across lines.
// Loaded on demand by the viewer. Tokens are {c: className|null, s: text}.

const KW = {
  c: 'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while yield record init required get set value when with and or not func let function import export from of typeof instanceof delete void undefined interface type declare readonly keyof extends implements package final synchronized throws super fn mut impl pub use mod crate match loop where trait dyn move go chan defer select range map nil iota auto template typename constexpr nullptr inline unsigned signed',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self cls print',
  sh: 'if then else elif fi for while do done case esac in function return exit local export set unset echo cd source true false',
  yaml: 'true false null yes no on off',
  json: 'true false null',
  sql: 'select from where and or not insert into values update set delete create table alter drop index join left right inner outer on as group by order having limit null is in like distinct union all case when then else end primary key foreign references default',
};
const set = s => new Set(s.split(' '));
const SETS = Object.fromEntries(Object.entries(KW).map(([k, v]) => [k, set(v)]));

const LANGS = {
  c: { kw: 'c', line: '//', block: ['/*', '*/'], strings: ['"', "'", '`'] },
  py: { kw: 'py', line: '#', strings: ['"""', "'''", '"', "'"] },
  sh: { kw: 'sh', line: '#', strings: ['"', "'"] },
  yaml: { kw: 'yaml', line: '#', strings: ['"', "'"], keys: true },
  json: { kw: 'json', strings: ['"'], keys: true },
  css: { line: null, block: ['/*', '*/'], strings: ['"', "'"], css: true },
  html: { markup: true },
  md: { md: true },
  sql: { kw: 'sql', line: '--', block: ['/*', '*/'], strings: ["'", '"'], ci: true },
};
const EXT = {
  js: 'c', mjs: 'c', cjs: 'c', jsx: 'c', ts: 'c', tsx: 'c', cs: 'c', java: 'c', go: 'c', c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', cxx: 'c', rs: 'c', swift: 'c', kt: 'c', scala: 'c', dart: 'c', php: 'c', cshtml: 'html', razor: 'html',
  py: 'py', rb: 'py', toml: 'sh', ps1: 'sh', sh: 'sh', bash: 'sh', zsh: 'sh', props: 'html', targets: 'html',
  yml: 'yaml', yaml: 'yaml', json: 'json', jsonc: 'json', css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', csproj: 'html', vbproj: 'html', fsproj: 'html', xaml: 'html', svg: 'html', vue: 'html', config: 'html', resx: 'html',
  md: 'md', markdown: 'md', sql: 'sql',
};

export function langFor(path) {
  const base = path.split('/').pop();
  if (/^(Dockerfile|Makefile)$/.test(base)) return 'sh';
  const m = base.match(/\.([A-Za-z0-9]+)$/);
  return m ? EXT[m[1].toLowerCase()] || null : null;
}

const NUM = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[a-zA-Z]*)/;
const IDENT = /^[A-Za-z_$@][\w$]*/;

function tokenizeCode(L, line, st) {
  const out = [];
  let i = 0;
  const push = (c, s) => { if (s) out.push({ c, s }); };
  const kws = L.kw ? SETS[L.kw] : null;
  if (st.block) {
    const e = line.indexOf(st.block);
    if (e < 0) return [{ c: 'cm', s: line }];
    push('cm', line.slice(0, e + st.block.length)); i = e + st.block.length; st.block = null;
  }
  if (st.str) { // multi-line triple quoted / template string
    const e = line.indexOf(st.str);
    if (e < 0) return [{ c: 'st', s: line }];
    push('st', line.slice(0, e + st.str.length)); i = e + st.str.length; st.str = null;
  }
  let plain = '';
  const flush = () => { push(null, plain); plain = ''; };
  while (i < line.length) {
    const rest = line.slice(i);
    if (L.line && rest.startsWith(L.line)) { flush(); push('cm', rest); break; }
    if (L.block && rest.startsWith(L.block[0])) {
      flush();
      const e = line.indexOf(L.block[1], i + L.block[0].length);
      if (e < 0) { push('cm', rest); st.block = L.block[1]; break; }
      push('cm', line.slice(i, e + L.block[1].length)); i = e + L.block[1].length; continue;
    }
    const q = L.strings && L.strings.find(s => rest.startsWith(s));
    if (q) {
      flush();
      let j = i + q.length;
      while (j < line.length && !line.startsWith(q, j)) j += line[j] === '\\' ? 2 : 1;
      if (j >= line.length) { push('st', rest); if (q.length === 3 || q === '`') st.str = q; break; }
      const s = line.slice(i, j + q.length); i = j + q.length;
      const isKey = L.keys && /^\s*:/.test(line.slice(i));
      push(isKey ? 'ky' : 'st', s); continue;
    }
    let m;
    if ((m = rest.match(NUM)) && !/\w/.test(line[i - 1] || '')) { flush(); push('nu', m[0]); i += m[0].length; continue; }
    if ((m = rest.match(IDENT))) {
      const w = m[0];
      const key = L.ci ? w.toLowerCase() : w;
      if (kws && kws.has(key)) { flush(); push('kw', w); }
      else if (/^[A-Z][a-z]/.test(w) && L.kw === 'c') { flush(); push('ty', w); }
      else if (L.keys && /^\s*:/.test(line.slice(i + w.length))) { flush(); push('ky', w); }
      else plain += w;
      i += w.length; continue;
    }
    plain += line[i++];
  }
  flush();
  return out;
}

function tokenizeMarkup(line, st) {
  const out = [];
  let i = 0;
  if (st.block) {
    const e = line.indexOf('-->');
    if (e < 0) return [{ c: 'cm', s: line }];
    out.push({ c: 'cm', s: line.slice(0, e + 3) }); i = e + 3; st.block = null;
  }
  const re = /<!--|<\/?[A-Za-z][\w:.-]*|\/?>|[A-Za-z_:][\w:.-]*(?==)|"[^"]*"|'[^']*'/g;
  re.lastIndex = i;
  let m, last = i;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ c: null, s: line.slice(last, m.index) });
    const s = m[0];
    if (s === '<!--') {
      const e = line.indexOf('-->', m.index);
      if (e < 0) { out.push({ c: 'cm', s: line.slice(m.index) }); st.block = true; last = line.length; break; }
      out.push({ c: 'cm', s: line.slice(m.index, e + 3) }); re.lastIndex = last = e + 3; continue;
    }
    out.push({ c: s[0] === '<' || s === '>' || s === '/>' ? 'kw' : s[0] === '"' || s[0] === "'" ? 'st' : 'ky', s });
    last = re.lastIndex;
  }
  if (last < line.length) out.push({ c: null, s: line.slice(last) });
  return out;
}

function tokenizeMd(line, st) {
  if (/^\s*(```|~~~)/.test(line)) { st.fence = !st.fence; return [{ c: 'cm', s: line }]; }
  if (st.fence) return [{ c: 'st', s: line }];
  if (/^#{1,6}\s/.test(line)) return [{ c: 'kw', s: line }];
  const out = [];
  const re = /`[^`]+`|\[[^\]]*\]\([^)]*\)|^\s*(?:[-*+]|\d+\.)\s/g;
  let last = 0, m;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ c: null, s: line.slice(last, m.index) });
    out.push({ c: m[0][0] === '`' ? 'st' : 'ty', s: m[0] }); last = re.lastIndex;
  }
  if (last < line.length) out.push({ c: null, s: line.slice(last) });
  return out;
}

/** Tokens for every line of a file ([] of token arrays), or null for an unknown language / huge file. */
export function tokenizeLines(lang, lines, maxLines = 30000) {
  const L = lang && LANGS[lang];
  if (!L || lines.length > maxLines) return null;
  const st = {};
  return lines.map(line => {
    if (line.length > 2000) return [{ c: null, s: line }];
    return L.markup ? tokenizeMarkup(line, st) : L.md ? tokenizeMd(line, st) : tokenizeCode(L, line, st);
  });
}
