// Build-time settings. tools/stage.mjs rewrites this file when the site is staged (content hashes); the values below are the dev defaults.
export const BUILD = 'dev';
export const MANIFESTS = { ref: 'ref/manifest.json', lazy: 'lazy/manifest.json' };
export const DOTNET = { st: './_framework/dotnet.js', aot: './aot/_framework/dotnet.js' };
// Which runtime build: relink (default) or the opt-in AOT build (bigger download, faster compile and run): ?aot=1 / ?aot=0, else the remembered toggle.
export const wantAot = () => { try { const q = new URLSearchParams(location.search).get('aot'); return q !== null ? q === '1' : localStorage.getItem('webbox-aot') === '1'; } catch { return false; } };
// Binaries are fetched as <file>.br and decoded in the worker (br.js); the plain file is the fallback (and what ?nobr=1 uses).
export const BROTLI = true;
