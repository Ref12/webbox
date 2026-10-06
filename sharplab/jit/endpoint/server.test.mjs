import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jitEnv, runJit, filterListings } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dll = fs.readFileSync(path.join(here, 'testdata', 'Add.dll'));   // class A { Add, Main, Sum } compiled by SharpLab.Core

test('environment: full opts by default, MinOpts when optimize is off, filter is validated', () => {
  const on = jitEnv({ method: 'Sum' });
  assert.equal(on.DOTNET_JitDisasm, 'Sum'); assert.equal(on.DOTNET_TieredCompilation, '0'); assert.equal(on.DOTNET_JITMinOpts, undefined);
  assert.equal(jitEnv({ optimize: false }).DOTNET_JITMinOpts, '1');
  assert.throws(() => jitEnv({ method: 'x; rm -rf /' }));
  assert.throws(() => jitEnv({ method: '' }) && jitEnv({ method: 'a'.repeat(300) }));
});

test('listings of runtime methods are dropped, the assembly\'s own (also generic and nested) are kept', () => {
  const text = '; Assembly listing for method System.RuntimeType+ListBuilder`1[System.__Canon]:Add(System.__Canon):this (FullOpts)\n code1\n; Assembly listing for method A:Add(int,int):int (FullOpts)\n code2\n; Assembly listing for method A+Inner:F():int (FullOpts)\n code3\n; Assembly listing for method G`1[int]:M():int (FullOpts)\n code4\n; Assembly listing for method AB:X():int (FullOpts)\n code5\n';
  const out = filterListings(text, ['A', 'A+Inner', 'G`1']);
  assert.match(out, /code2/); assert.match(out, /code3/); assert.match(out, /code4/);
  assert.doesNotMatch(out, /code1|code5/);
});

const runner = process.env.JIT_RUNNER || path.join(here, 'JitRunner', 'bin', 'Release', 'net10.0', 'JitRunner.dll');
test('end to end with a real JIT (skipped when JitRunner is not built)', { skip: !fs.existsSync(runner) }, async () => {
  const r = await runJit(dll, { method: 'Sum', optimize: true });
  assert.equal(r.code, 0, r.err);
  assert.match(r.text, /Assembly listing for method A:Sum\(int\[\]\):int/);
  assert.match(r.text, /FullOpts/);
  assert.doesNotMatch(r.text, /A:Add|RuntimeType/);                       // the filter selects one method
  const min = await runJit(dll, { method: 'Sum', optimize: false });
  assert.match(min.text, /MinOpts/);
});
