import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeaders, compressible } from '../../tools/cf-sim.mjs';
test('_headers: splat rules combine, Content-Type replaced, exact paths', () => {
  const f = parseHeaders('# c\n/csharp/*\n  Cross-Origin-Opener-Policy: same-origin\n/csharp/_framework/*\n  Cache-Control: immutable\n/csharp/_framework/*.wasm\n  Content-Type: application/wasm\n/csharp/\n  Cache-Control: no-cache\n');
  assert.deepEqual(f('/csharp/_framework/a.wasm'), { 'cross-origin-opener-policy': 'same-origin', 'cache-control': 'immutable', 'content-type': 'application/wasm' });
  assert.deepEqual(f('/csharp/'), { 'cross-origin-opener-policy': 'same-origin', 'cache-control': 'no-cache' });
  assert.deepEqual(f('/keyvault/'), {});
});
test('compressible types', () => { assert.ok(compressible('application/wasm')); assert.ok(compressible('text/javascript; charset=utf-8')); assert.ok(!compressible('application/octet-stream')); });
