// REPL commands: lines that are not C# but are handled by the page, like the dotnet-csi / Visual Studio C# Interactive ones.
// A command is a whole submission (one line): #help, #clear (or just: clear), #reset, #load "https://...".
// #r "..." is a C# script directive: Roslyn parses it and ReplSession handles it; here it is only coloured (directiveSpans).
// Pure functions + a handler that talks to the page through a small "host" object, so all of it is unit-tested without a DOM.

export const HELP_TEXT = [
  'Commands (type one on its own, then Enter):',
  '  #help                     this list',
  '  #clear  |  clear          clear the transcript; variables, usings and references stay (#reset forgets them too)',
  '  #reset                    forget the session state: variables, methods, types, usings and references',
  '  #load "https://host/x.csx"   fetch a script from a URL (the server must allow CORS, e.g. raw.githubusercontent.com) and run it',
  '',
  'Directives (inside a submission):',
  '  #r "nuget: Package, 1.2.3"   reference a NuGet package (version optional = latest stable); completion inside the quotes',
  '  #r "System.Net.Http"          reference a framework assembly',
  '',
  'Keys: Enter run (when the code is complete) · Shift+Enter new line · Ctrl+Enter run anyway · Ctrl+↑/↓ history · Tab accept completion',
].join('\n');

const NAMES = ['help', 'clear', 'reset', 'load'];
const KEYWORD = 'preprocessor keyword';

/**
 * Is this whole submission a REPL command? null = no (it is C#). Otherwise { kind, arg?, error?, spans } where spans are
 * Roslyn-style classification spans (start/length/type) for colouring it as a preprocessor directive.
 * A bare `clear` is a command too (as in the csi shell), which means a variable called `clear` cannot be evaluated on its own: write `(clear)`.
 */
export function parseCommand(code) {
  if (typeof code !== 'string' || code.includes('\n')) return null;
  const t = code.trim();
  const lead = code.length - code.trimStart().length;
  if (t === 'clear') return { kind: 'clear', spans: [{ start: lead, length: 5, type: KEYWORD }] };
  const m = /^#([a-z]+)(?:[ \t]+(.*))?$/.exec(t);
  if (!m || !NAMES.includes(m[1])) return null;
  const kind = m[1], rest = (m[2] ?? '').trim();
  const spans = [{ start: lead, length: 1 + kind.length, type: KEYWORD }];
  if (kind === 'load') {
    const q = /^"([^"]*)"$/.exec(rest);
    if (!q) return { kind, error: '#load expects a quoted URL, e.g. #load "https://raw.githubusercontent.com/user/repo/main/script.csx"', spans };
    spans.push({ start: lead + t.indexOf('"'), length: rest.length, type: 'string' });
    const u = normalizeLoadUrl(q[1]);
    return u.error ? { kind, error: u.error, spans } : { kind, arg: u.url, spans };
  }
  if (rest && !rest.startsWith('//')) return { kind, error: '#' + kind + ' takes no arguments', spans };
  return { kind, spans };
}

/** #load works with URLs only (a browser has no file system); GitHub page URLs are turned into their raw form. */
export function normalizeLoadUrl(url) {
  let u;
  try { u = new URL(url.trim()); } catch { return { error: '#load needs an absolute http(s) URL (a browser has no file system), got "' + url + '"' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: '#load needs an http(s) URL, got "' + url + '"' };
  let m;
  if (u.hostname === 'github.com' && (m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname))) return { url: 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3] };
  if (u.hostname === 'gist.github.com' && (m = /^\/([^/]+)\/([0-9a-f]+)\/?$/i.exec(u.pathname))) return { url: 'https://gist.githubusercontent.com/' + m[1] + '/' + m[2] + '/raw' };
  return { url: u.href };
}

/** Classification spans for the directive lines in `text`: a whole-submission command, or each `#r "..."` line of C#. Added to Roslyn's spans (which blank #r lines). */
export function directiveSpans(text) {
  const c = parseCommand(text);
  if (c) return c.spans;
  const spans = [];
  const re = /^([ \t]*)(#r)([ \t]+)("(?:[^"\\\r\n]|\\.)*"?)/gm;
  for (let m; (m = re.exec(text));) {
    const start = m.index + m[1].length;
    spans.push({ start, length: 2, type: KEYWORD });
    spans.push({ start: start + 2 + m[3].length, length: m[4].length, type: 'string' });
  }
  return spans;
}

/**
 * Runs a parsed command. host = { clearTranscript(), resetSession(), print(text), error(text), loadScript(url) -> Promise }.
 * Returns what happened, for tests: 'help' | 'clear' | 'reset' | 'load' | 'error'.
 */
export async function handleCommand(cmd, host) {
  if (cmd.error) { host.error(cmd.error); return 'error'; }
  switch (cmd.kind) {
    case 'help': host.print(HELP_TEXT); return 'help';
    case 'clear': host.clearTranscript(); return 'clear';
    case 'reset': host.resetSession(); return 'reset';
    case 'load': await host.loadScript(cmd.arg); return 'load';
  }
  return 'error';
}
