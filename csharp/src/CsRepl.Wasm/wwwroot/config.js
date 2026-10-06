// Build-time settings. tools/stage.mjs rewrites this file when the site is staged (content hashes, delivery target); the values below are the dev defaults.
export const BUILD = 'dev';
export const MANIFESTS = { ref: 'ref/manifest.json', lazy: 'lazy/manifest.json' };
// Where the .NET runtime lives. mt/ is the experimental multithreaded build (?threads=1), staged next to the normal one.
export const DOTNET = { st: './_framework/dotnet.js', mt: './mt/_framework/dotnet.js', aot: './aot/_framework/dotnet.js' };
// Which runtime build: relink (default) or the opt-in AOT build (bigger download, faster compile and run): ?aot=1 / ?aot=0, else the remembered toggle.
export const wantAot = () => { try { const q = new URLSearchParams(location.search).get('aot'); return q !== null ? q === '1' : localStorage.getItem('webbox-aot') === '1'; } catch { return false; } };
// true only on GitHub Pages, which cannot send Content-Encoding for precompressed files: big binaries are fetched as .br and decoded in the worker (br.js).
export const BROTLI = false;
// null: every binary is fetched as .br (Pages). Else only these paths (relative to the app, set by stage.mjs for files over Cloudflare's 25 MiB asset limit).
export const BROTLI_ONLY = null;
