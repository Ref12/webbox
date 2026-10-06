// C# syntax colouring. A small regex tokenizer gives instant colours (member signatures, first paint of decompiled code); when Monaco
// has loaded from the CDN, decompiled code is re-coloured with Monaco's C# grammar (monaco.editor.colorize), as in the REPL.

const KEYWORDS = new Set(('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var async await get set init value when where yield record nint nuint required file scoped partial dynamic').split(' '));
const CONTROL = new Set('if else for foreach while do switch case break continue return throw try catch finally goto yield await using lock'.split(' '));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(@?\$?@?"(?:[^"\\\n]|\\.|"")*"|'(?:[^'\\\n]|\\.)+')|(\b0[xX][0-9a-fA-F_]+[uUlL]*\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFdDmMuUlL]*\b)|([A-Za-z_][A-Za-z0-9_]*)|(#[a-z]+[^\n]*)/g;

/** Returns HTML (spans with classes t-comment, t-string, t-number, t-kw, t-ctl, t-type, t-pre). */
export function toHtml(code) {
  let out = '', last = 0, m;
  RE.lastIndex = 0;
  while ((m = RE.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [text, comment, str, num, ident, pre] = m;
    let cls = comment ? 't-comment' : str ? 't-string' : num ? 't-number' : pre ? 't-pre' : null;
    if (ident) {
      if (CONTROL.has(ident)) cls = 't-ctl';
      else if (KEYWORDS.has(ident)) cls = 't-kw';
      else if (/^[A-Z][A-Za-z0-9]*$/.test(ident) && /^\s*(?:[<?\[]|[A-Za-z_@]|$)/.test(code.slice(m.index + text.length, m.index + text.length + 3)) && !/\.\s*$/.test(code.slice(Math.max(0, m.index - 2), m.index))) cls = 't-type';
      else if (/^I[A-Z]/.test(ident)) cls = 't-type';
    }
    out += cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text);
    last = m.index + text.length;
  }
  return out + esc(code.slice(last));
}

// ---- Monaco, lazily, only when decompiled code is shown ----
const MONACO = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs';
let monacoPromise = null;
export function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MONACO + '/loader.js';
    s.onerror = () => reject(new Error('monaco loader'));
    s.onload = () => {
      window.require.config({ paths: { vs: MONACO } });
      window.require(['vs/editor/editor.main'], () => { window.monaco.editor.setTheme('vs-dark'); resolve(window.monaco); }, reject);
    };
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('monaco timeout')), 10000);
  });
  monacoPromise.catch(() => {});
  return monacoPromise;
}

/** Monaco-coloured HTML for code, or null when Monaco is unavailable. */
export async function monacoHtml(code) {
  try {
    const monaco = await loadMonaco();
    return await monaco.editor.colorize(code, 'csharp', { tabSize: 4 });
  } catch { return null; }
}
