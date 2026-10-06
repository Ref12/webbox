// Build-time settings. tools/stage.mjs rewrites this file when the site is staged (content hashes); the values below are the dev defaults.
export const BUILD = 'dev';
export const MANIFESTS = { ref: 'ref/manifest.json', lazy: 'lazy/manifest.json' };
export const DOTNET = { st: './_framework/dotnet.js' };
// Binaries are fetched as <file>.br and decoded in the worker (br.js); the plain file is the fallback (and what ?nobr=1 uses).
export const BROTLI = true;
