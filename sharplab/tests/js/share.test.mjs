import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeShare, decodeShare, DEFAULTS, toBase64Url, fromBase64Url, deflate } from '../../src/SharpLab.Wasm/wwwroot/share.js';

const code = 'using System;\nclass A { static void Main() { Console.WriteLine("héllo \u{1F600}"); } }\r\n';

test('round trip keeps code and options, including unicode and CRLF', async () => {
  const st = { code, configuration: 'debug', optimize: false, langVersion: '12', level: 3, tab: 'layout', layoutRuntime: 'modelled' };
  const frag = await encodeShare(st);
  assert.match(frag, /^v1:[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeShare('#' + frag), st);
});

test('defaults are omitted and restored', async () => {
  const frag = await encodeShare({ code: 'x' });
  const st = await decodeShare(frag);
  assert.deepEqual(st, { ...DEFAULTS, code: 'x' });
  assert.ok(frag.length < 40, frag);
});

test('large code is compressed well below its size and stays url-safe', async () => {
  const big = Array.from({ length: 400 }, (_, i) => 'public int Method' + i + '(int a) { return a + ' + i + '; }').join('\n');
  const frag = await encodeShare({ code: big });
  assert.ok(frag.length < big.length / 4, frag.length + ' vs ' + big.length);
  assert.equal((await decodeShare(frag)).code, big);
});

test('invalid fragments return null', async () => {
  for (const f of ['', '#', 'v1:', 'v1:!!!', 'v1:AAAA', 'v2:abc', '#nope', 'v1:' + toBase64Url(new TextEncoder().encode('not deflate')), undefined]) assert.equal(await decodeShare(f), null, String(f));
});

test('an out-of-range decompile level falls back to the default', async () => {
  const frag = 'v1:' + toBase64Url(await deflate(new TextEncoder().encode(JSON.stringify({ c: 'x', d: 9 }))));
  assert.equal((await decodeShare(frag)).level, DEFAULTS.level);
});

test('base64url helpers round trip every byte value', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(fromBase64Url(toBase64Url(all)), all);
  assert.ok(!/[+/=]/.test(toBase64Url(all)));
});

test('a link made by an earlier build still decodes (format pinned)', async () => {
  // v1 of the format; if this fails the format changed and old links broke
  const st = await decodeShare('v1:q1ZKVrJSSs5JLC5WcFSoVqiNyVPSUUpXslJKSU0qTVfSUUpRsjKuBQA');
  assert.deepEqual(st, { code: 'class A { }\n', configuration: 'debug', optimize: true, langVersion: 'latest', level: 3, tab: 'cs', layoutRuntime: 'measured' });
});
