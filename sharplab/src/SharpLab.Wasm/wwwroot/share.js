// Share links: the code and the options are packed into the URL fragment, like SharpLab's (#v2:...), but with the platform's
// CompressionStream (raw deflate) + base64url instead of lz-string. Only options that differ from the defaults are stored.
// Fragment format:  v1:<base64url(deflate-raw(JSON))>   JSON = { c: code, g?: config, o?: 0|1 optimize, l?: langVersion, d?: decompile level, t?: tab }
export const DEFAULTS = Object.freeze({ code: '', configuration: 'release', optimize: true, langVersion: 'latest', level: 2, tab: 'cs' });
export const PREFIX = 'v1:';

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const deflate = (b) => pipe(b, new CompressionStream('deflate-raw'));
export const inflate = (b) => pipe(b, new DecompressionStream('deflate-raw'));

export function toBase64Url(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64Url(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const u8 = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
  return u8;
}

/** state = { code, configuration, optimize, langVersion, level, tab }; returns the fragment text WITHOUT the leading '#'. */
export async function encodeShare(state) {
  const s = { ...DEFAULTS, ...state };
  const o = { c: s.code };
  if (s.configuration !== DEFAULTS.configuration) o.g = s.configuration;
  if (s.optimize !== DEFAULTS.optimize) o.o = s.optimize ? 1 : 0;
  if (s.langVersion !== DEFAULTS.langVersion) o.l = s.langVersion;
  if (s.level !== DEFAULTS.level) o.d = s.level;
  if (s.tab !== DEFAULTS.tab) o.t = s.tab;
  return PREFIX + toBase64Url(await deflate(new TextEncoder().encode(JSON.stringify(o))));
}

/** Parses a fragment (with or without the leading '#'). Returns a full state, or null when it is not a valid share link. */
export async function decodeShare(fragment) {
  try {
    const f = String(fragment || '').replace(/^#/, '');
    if (!f.startsWith(PREFIX)) return null;
    const o = JSON.parse(new TextDecoder().decode(await inflate(fromBase64Url(f.slice(PREFIX.length)))));
    if (typeof o?.c !== 'string') return null;
    const level = Number.isInteger(o.d) && o.d >= 1 && o.d <= 3 ? o.d : DEFAULTS.level;
    return {
      code: o.c,
      configuration: o.g === 'debug' ? 'debug' : 'release',
      optimize: o.o === undefined ? DEFAULTS.optimize : o.o === 1,
      langVersion: typeof o.l === 'string' ? o.l : DEFAULTS.langVersion,
      level,
      tab: typeof o.t === 'string' ? o.t : DEFAULTS.tab,
    };
  } catch { return null; }
}
