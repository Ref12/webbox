// Build-time settings. tools/stage.mjs rewrites this file when the site is staged (content hashes, delivery target); the values below are the dev defaults.
export const BUILD = 'dev';
export const MANIFESTS = { ref: 'ref/manifest.json', lazy: 'lazy/manifest.json' };
// Where the .NET runtime lives. mt/ is the experimental multithreaded build (?threads=1), staged next to the normal one.
export const DOTNET = { st: './_framework/dotnet.js', mt: './mt/_framework/dotnet.js' };
// true only on GitHub Pages, which cannot send Content-Encoding for precompressed files: big binaries are fetched as .br and decoded in the worker (br.js).
export const BROTLI = false;
