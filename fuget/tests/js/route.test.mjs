import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, format, resolveName, previousVersion } from '../../src/Fuget.Wasm/wwwroot/route.js';

const LINK = '#/Newtonsoft.Json/13.0.3/lib/net6.0/Newtonsoft.Json/Newtonsoft.Json.Linq.JObject';
test('parses the documented deep link', () => {
  const r = parse(LINK);
  assert.deepEqual([r.id, r.version, r.dir, r.asm, r.name, r.tab], ['Newtonsoft.Json', '13.0.3', 'lib/net6.0', 'Newtonsoft.Json', 'Newtonsoft.Json.Linq.JObject', 'docs']);
});
test('format round-trips, including tab, member and base', () => {
  const r = { id: 'A.B', version: '1.0.0', dir: 'ref/net8.0', asm: 'A.B', name: 'A.B.List`1', tab: 'diff', member: 'M:A.B.List`1.Add(`0)', base: '0.9.0' };
  const h = format(r);
  assert.equal(h, '#/A.B/1.0.0/ref/net8.0/A.B/A.B.List`1?tab=diff&m=M:A.B.List`1.Add%28`0%29&base=0.9.0');
  const p = parse(h);
  for (const k of Object.keys(r)) assert.equal(p[k], r[k], k);
});
test('partial routes and searches', () => {
  assert.equal(parse('#/Serilog').version, '');
  assert.equal(format({ id: 'Serilog', version: '' }), '#/Serilog');
  assert.equal(parse('#/?q=json%20net').q, 'json net');
  assert.equal(format({ id: '', q: 'json net' }), '#/?q=json%20net');
  assert.equal(parse('').id, '');
});
test('resolves type vs namespace', () => {
  const types = [{ fullName: 'A.B.C', namespace: 'A.B' }, { fullName: 'A.D.E', namespace: 'A.D' }];
  assert.equal(resolveName(types, 'A.B.C').type, types[0]);
  assert.equal(resolveName(types, 'A.D').ns, 'A.D');
  assert.equal(resolveName(types, 'A').ns, 'A');
  assert.deepEqual(resolveName(types, 'Nope'), { type: null, ns: null });
});
test('previous version skips prereleases for a stable version', () => {
  const vs = ['1.0.0', '1.1.0-beta', '1.1.0', '2.0.0'];
  assert.equal(previousVersion(vs, '2.0.0'), '1.1.0');
  assert.equal(previousVersion(vs, '1.1.0'), '1.0.0');
  assert.equal(previousVersion(vs, '1.0.0'), '');
});
