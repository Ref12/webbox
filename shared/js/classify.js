// Roslyn classification names (Microsoft.CodeAnalysis.Classification.ClassificationTypeNames) -> our token types,
// plus helpers shared by the Monaco semantic-token provider and the history renderer.
export const TYPES = ['keyword', 'keywordControl', 'class', 'struct', 'interface', 'enum', 'delegate', 'typeParam', 'method', 'property',
  'field', 'local', 'parameter', 'event', 'namespace', 'constant', 'enumMember', 'label', 'string', 'stringEscape', 'number', 'comment',
  'operator', 'punct', 'preproc', 'xmlDoc', 'regex'];

/** Visual Studio Dark colours (hex without #) per token type: the Monaco theme rules for the semantic tokens and the .t-* classes of the transcript. */
export const VS_DARK = {
  keyword: '569cd6', keywordControl: 'd8a0df', class: '4ec9b0', struct: '4ec9b0', delegate: '4ec9b0', typeParam: '4ec9b0', interface: 'b8d7a3', enum: 'b8d7a3',
  method: 'dcdcdc', property: 'dcdcdc', field: 'dcdcdc', local: 'dcdcdc', event: 'dcdcdc', namespace: 'dcdcdc', constant: 'dcdcdc', enumMember: 'dcdcdc', label: 'dcdcdc',
  parameter: '9cdcfe', string: 'd69d85', regex: 'd69d85', stringEscape: 'ffd68f', number: 'b5cea8', comment: '57a64a', xmlDoc: '608b4e', operator: 'b4b4b4', punct: 'dcdcdc', preproc: '9b9b9b',
};

const EXACT = {
  'keyword': 'keyword', 'keyword - control': 'keywordControl', 'class name': 'class', 'record class name': 'class', 'module name': 'class',
  'struct name': 'struct', 'record struct name': 'struct', 'interface name': 'interface', 'enum name': 'enum', 'delegate name': 'delegate',
  'type parameter name': 'typeParam', 'method name': 'method', 'extension method name': 'method', 'property name': 'property',
  'field name': 'field', 'local name': 'local', 'parameter name': 'parameter', 'event name': 'event', 'namespace name': 'namespace',
  'constant name': 'constant', 'enum member name': 'enumMember', 'label name': 'label', 'string': 'string', 'string - verbatim': 'string',
  'string - escape character': 'stringEscape', 'number': 'number', 'comment': 'comment', 'operator': 'operator', 'operator - overloaded': 'operator',
  'punctuation': 'punct', 'preprocessor keyword': 'preproc', 'preprocessor text': 'preproc', 'excluded code': 'comment',
};
export function tokenType(roslyn) {
  if (EXACT[roslyn]) return EXACT[roslyn];
  if (roslyn.startsWith('xml doc comment')) return 'xmlDoc';
  if (roslyn.startsWith('regex')) return 'regex';
  return null;   // identifier, text, whitespace, static symbol...: default colour
}

/** Flatten possibly nested spans [{start,length,type}] into one token type per character (inner/shorter spans win). */
export function paint(length, spans, text) {
  const out = new Array(length).fill(null);
  const sorted = [...spans].sort((a, b) => b.length - a.length || a.start - b.start);
  for (const s of sorted) {
    const t = tokenType(s.type); if (!t) continue;
    if (t === 'operator' && text && /^[.,:]$/.test(text.substr(s.start, s.length))) continue;   // member-access dot etc.: default colour, like Visual Studio
    for (let i = s.start; i < s.start + s.length && i < length; i++) out[i] = t;
  }
  return out;
}

/** Runs of equal token type: [{start, end, type|null}] covering the whole text. */
export function runs(text, spans) {
  const p = paint(text.length, spans, text); const r = [];
  for (let i = 0; i < text.length;) {
    let j = i + 1; while (j < text.length && p[j] === p[i]) j++;
    r.push({ start: i, end: j, type: p[i] }); i = j;
  }
  return r;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** HTML for the history code blocks: <span class="t-class">…</span>. */
export function toHtml(text, spans) {
  return runs(text, spans).map((r) => { const s = esc(text.slice(r.start, r.end)); return r.type ? '<span class="t-' + r.type + '">' + s + '</span>' : s; }).join('');
}

/** Monaco semantic tokens (Uint32Array of deltaLine, deltaStart, length, type, modifiers); a token never spans lines. */
export function toSemanticTokens(text, spans) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineOf = (pos) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= pos) lo = m; else hi = m - 1; } return lo; };
  const data = []; let prevLine = 0, prevChar = 0;
  for (const r of runs(text, spans)) {
    if (!r.type) continue;
    const idx = TYPES.indexOf(r.type);
    for (let s = r.start; s < r.end;) {
      const ln = lineOf(s);
      const lineEnd = ln + 1 < starts.length ? starts[ln + 1] - 1 : text.length;   // index of the newline (or end)
      const stop = Math.min(r.end, lineEnd);
      if (stop > s) {
        const ch = s - starts[ln];
        data.push(ln - prevLine, ln === prevLine ? ch - prevChar : ch, stop - s, idx, 0);
        prevLine = ln; prevChar = ch;
      }
      s = stop === lineEnd ? stop + 1 : stop;
    }
  }
  return new Uint32Array(data);
}
