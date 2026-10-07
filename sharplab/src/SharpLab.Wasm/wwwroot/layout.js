// Layout view: for every type declared in the code, the memory layout measured on this page's runtime (Mono wasm32) and the modelled CoreCLR x64 layout.
// Rows select the field in the editor. The table text follows ObjectLayoutInspector's output (https://github.com/SergeyTeplyakov/ObjectLayoutInspector, MIT, Sergey Teplyakov).
const COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#b07aa1', '#76b7b2', '#edc948', '#af7aa1', '#ff9da7'];
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

function flat(slots, out = []) { for (const s of slots) { out.push(s); if (s.nested) flat(s.nested, out); } return out; }

function bar(l, select) {
  const box = el('div', 'lbar');
  const total = l.overhead + (l.kind === 'class' ? l.size - l.overhead : l.size);
  const seg = (w, cls, label, title, color, onclick) => {
    const s = el('div', 'lseg ' + cls, label); s.style.flexGrow = String(Math.max(w, 1)); s.style.flexBasis = '0'; s.title = title;
    if (color) s.style.background = color; if (onclick) { s.onclick = onclick; s.style.cursor = 'pointer'; } box.appendChild(s);
  };
  if (l.kind === 'class') seg(l.overhead, 'hdr', 'header', 'object header + method table / vtable pointer: ' + l.overhead + ' bytes');
  let i = 0;
  for (const s of l.slots) {
    if (s.kind === 'padding') seg(s.size, 'pad', '', 'padding ' + s.size + ' bytes: ' + s.cause);
    else { const c = COLORS[i++ % COLORS.length]; seg(s.size, 'fld' + (s.isRef ? ' ref' : ''), s.size >= 4 ? s.name : '', s.type + ' ' + s.name + ' (' + s.size + ' bytes at ' + s.offset + ')', c, () => select(s)); }
  }
  return box;
}

function table(l, select) {
  const t = el('table', 'ltab');
  const head = el('tr'); for (const h of ['offset', 'size', 'field', 'type', '']) head.appendChild(el('th', '', h)); t.appendChild(head);
  if (l.kind === 'class') {
    const r = el('tr', 'hdr'); r.append(el('td', '', '-' + l.overhead + '…-1'), el('td', '', String(l.overhead)), el('td', '', 'object header + method table'), el('td', ''), el('td', ''));
    r.children[2].colSpan = 1; t.appendChild(r);
  }
  const add = (s, depth) => {
    const r = el('tr', s.kind);
    const range = s.size === 1 ? String(s.offset) : s.offset + '–' + (s.offset + s.size - 1);
    r.appendChild(el('td', 'num', range)); r.appendChild(el('td', 'num', String(s.size)));
    if (s.kind === 'padding') { const c = el('td', '', 'padding'); r.appendChild(c); r.appendChild(el('td', 'dim', '')); r.appendChild(el('td', 'dim', s.cause || '')); }
    else {
      const c = el('td', 'name', s.name); c.style.paddingLeft = (8 + depth * 14) + 'px'; r.appendChild(c);
      r.appendChild(el('td', 'type', s.type));
      r.appendChild(el('td', 'dim', [s.overlap ? 'overlaps another field' : '', s.note || ''].filter(Boolean).join('; ')));
      if (s.span) { r.classList.add('click'); r.onclick = () => select(s); }
    }
    t.appendChild(r);
    if (s.nested) for (const n of s.nested) add(n, depth + 1);
  };
  for (const s of l.slots) add(s, 0);
  return t;
}

/** host: container element; data: parsed JSON from the runtime's Layout(); select(span): selects the span in the editor. */
export function renderLayout(host, data, state, select) {
  host.textContent = '';
  const intro = el('div', 'lintro');
  intro.append('Memory layout of every type in your code. ', el('b', '', 'Measured'), ' = read from the runtime running this page (' + data.runtimeName + ', ' + data.pointerSize * 8 + '-bit); ', el('b', '', 'CoreCLR x64'), ' = what the desktop .NET runtime does, computed from the type metadata (a model: Mono lays out some types differently, and the model can differ from the real runtime, mostly for large nested structs, Int128/Vector fields and Pack on derived classes). Format and idea: ');
  const a = el('a', '', 'ObjectLayoutInspector'); a.href = 'https://github.com/SergeyTeplyakov/ObjectLayoutInspector'; a.target = '_blank'; a.rel = 'noopener'; intro.append(a, ' (MIT, © Sergey Teplyakov).');
  host.appendChild(intro);
  const mode = el('div', 'lmode');
  for (const [k, label] of [['measured', 'Measured · ' + data.runtimeName + ' ' + data.pointerSize * 8 + '-bit'], ['modelled', 'CoreCLR x64 (modelled)']]) {
    const b = el('button', state.layoutRuntime === k ? 'on' : '', label);
    b.onclick = () => { state.layoutRuntime = k; renderLayout(host, data, state, select); }; mode.appendChild(b);
  }
  host.appendChild(mode);
  if (!data.available || !data.types.length) { host.appendChild(el('div', 'dim lnote', data.note || 'Nothing to show.')); return; }
  for (const ty of data.types) {
    const l = state.layoutRuntime === 'modelled' ? ty.modelled : ty.measured;
    const card = el('section', 'lcard');
    const h = el('h3'); const nm = el('span', 'tn', ty.name); if (ty.span) { nm.classList.add('click'); nm.onclick = () => select({ span: ty.span }); }
    h.append(nm);
    if (l) h.append(el('span', 'dim', '  ' + l.kind + ' · ' + l.size + ' bytes · ' + l.paddings + ' padding (' + (l.size ? Math.round(l.paddings * 100 / l.size) : 0) + '%) · ' + l.layoutKind + (l.pack ? ' pack ' + l.pack : '')));
    card.appendChild(h);
    if (ty.error) card.appendChild(el('div', 'bad', ty.error));
    if (l) {
      card.appendChild(bar(l, select)); card.appendChild(table(l, select));
      for (const n of l.notes) card.appendChild(el('div', 'dim lnote', n));
      const d = el('details'); d.appendChild(el('summary', '', 'Text (ObjectLayoutInspector format)')); d.appendChild(el('pre', 'ltext', state.layoutRuntime === 'modelled' ? ty.modelledText : ty.measuredText)); card.appendChild(d);
    }
    host.appendChild(card);
  }
}
