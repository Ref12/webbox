// Brotli decoding in the page. GitHub Pages cannot serve precompressed .br with Content-Encoding (and does not compress
// .wasm/.dll/.bin reliably), so big binaries are shipped as <file>.br (plain bytes to the server) and decoded here with a
// 200 KB WebAssembly decoder (vendor/brotli-dec-wasm, MIT OR Apache-2.0). Browsers have no DecompressionStream('brotli') yet.
let decoder = null;
async function load() {
  const mod = await import('./vendor/brotli_dec_wasm.js');
  const r = await fetch(new URL('./vendor/brotli_dec_wasm_bg.wasm', import.meta.url));
  if (!r.ok) throw new Error('brotli decoder: HTTP ' + r.status);
  await mod.default(new Uint8Array(await r.arrayBuffer()));
  return mod;
}
export async function brotliDecode(bytes) {
  const mod = await (decoder ||= load().catch((e) => { decoder = null; throw e; }));
  return mod.decompress(bytes);
}
