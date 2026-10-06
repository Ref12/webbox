// The small copy icon (code blocks, and now output / return value / error blocks): copies the block's plain text.
export const COPY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
export const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** Copy text: the async clipboard, else a hidden textarea + execCommand (non-secure contexts, older phones). Returns true when it worked. */
export async function copyText(text, doc = document, nav = globalThis.navigator) {
  try { await nav.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = doc.createElement('textarea'); ta.value = text; doc.body.appendChild(ta); ta.select();
    const ok = doc.execCommand('copy'); ta.remove(); return !!ok;
  } catch { return false; }
}

/** Adds the copy button to `box` (an element with position: relative). `text` is a string or a function giving it. The button copies plain text, never HTML. */
export function addCopyButton(box, text, { title = 'Copy', doc = document, nav = globalThis.navigator, onCopied } = {}) {
  const btn = doc.createElement('button');
  btn.className = 'copy'; btn.type = 'button'; btn.title = title; btn.setAttribute('aria-label', title); btn.innerHTML = COPY_SVG;
  btn.onclick = async () => {
    const value = typeof text === 'function' ? text() : text;
    if (!(await copyText(value, doc, nav))) return;
    btn.classList.add('done'); btn.innerHTML = CHECK_SVG; onCopied?.(value);
    setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = COPY_SVG; }, 1200);
  };
  box.appendChild(btn);
  return btn;
}
