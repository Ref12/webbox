import test from 'node:test';
import assert from 'node:assert/strict';
import { rContext, completeR, createNuGetClient, orderVersions, NUGET_AUTOCOMPLETE, NUGET_FLAT } from '../../src/CsRepl.Wasm/wwwroot/rcomplete.js';

// a fake nuget.org: the autocomplete service and the flat container
function fakeApi() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const json = (o, status = 200) => ({ ok: status === 200, status, json: async () => o });
    if (url.startsWith(NUGET_AUTOCOMPLETE)) {
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      return json({ data: ['Newtonsoft.Json', 'Newtonsoft.Json.Bson', 'Humanizer.Core', 'Serilog'].filter((n) => n.toLowerCase().includes(q)) });
    }
    if (url.startsWith(NUGET_FLAT)) {
      const id = decodeURIComponent(url.slice(NUGET_FLAT.length).split('/')[0]);
      if (id === 'newtonsoft.json') return json({ versions: ['12.0.3', '13.0.1', '13.0.2-beta1', '13.0.3', '13.0.4-rc.1'] });
      return json({}, 404);
    }
    throw new Error('unexpected ' + url);
  };
  return { fetchImpl, calls };
}
const at = (text) => { const i = text.indexOf('|'); return [text.replace('|', ''), i]; };
const ctx = (marked) => { const [t, i] = at(marked); return rContext(t, i); };

test('rContext finds the place inside #r "..."', () => {
  assert.deepEqual(ctx('#r "|'), { kind: 'prefix', partial: '', start: 4 });
  assert.deepEqual(ctx('#r "Sys|'), { kind: 'prefix', partial: 'Sys', start: 4 });
  assert.deepEqual(ctx('#r "nuget: |'), { kind: 'package', partial: '', start: 11 });
  assert.deepEqual(ctx('#r "nuget:Newt|"'), { kind: 'package', partial: 'Newt', start: 10 });
  assert.deepEqual(ctx('#r "NuGet: Newtonsoft.Json, |'), { kind: 'version', id: 'Newtonsoft.Json', partial: '', start: 28 });
  assert.deepEqual(ctx('x\n  #r "nuget: A,13.|'), { kind: 'version', id: 'A', partial: '13.', start: 17 });
  for (const no of ['var s = "|', '#r|', '#r |', '#r "x" |', '#r "x"|', '// #r "|', 'Console.WriteLine("#r |', '#load "|']) assert.equal(ctx(no), null, no);
});

test('versions: newest first, stable unless a pre-release is being typed', () => {
  const all = ['12.0.3', '13.0.1', '13.0.2-beta1', '13.0.3', '13.0.4-rc.1'];
  assert.deepEqual(orderVersions(all, ''), ['13.0.3', '13.0.1', '12.0.3']);
  assert.deepEqual(orderVersions(all, '13.0.'), ['13.0.3', '13.0.1']);
  assert.deepEqual(orderVersions(all, '13.0.4-'), ['13.0.4-rc.1']);
  assert.deepEqual(orderVersions(['1.0.0-a', '1.0.0-b'], ''), ['1.0.0-b', '1.0.0-a']);   // only pre-releases exist
});

test('#r " offers nuget: and the framework assemblies, filtered by what is typed', async () => {
  const { fetchImpl, calls } = fakeApi();
  const services = { nuget: createNuGetClient(fetchImpl), assemblies: () => ['System.Net.Http', 'System.Text.Json', 'System.Linq'] };
  let [t, i] = at('#r "|');
  let r = await completeR(t, i, services);
  assert.deepEqual(r.items.map((x) => x.label), ['nuget: ', 'System.Net.Http', 'System.Text.Json', 'System.Linq']);
  assert.equal(r.items[0].insertText, 'nuget: ');
  [t, i] = at('#r "System.T|');
  r = await completeR(t, i, services);
  assert.deepEqual(r.items.map((x) => x.label), ['System.Text.Json']);
  assert.deepEqual(r.items[0].start, 4);
  [t, i] = at('#r "nu|');
  assert.deepEqual((await completeR(t, i, services)).items.map((x) => x.label), ['nuget: ']);
  assert.equal(calls.length, 0, 'no network for these');
});

test('package names come from the autocomplete API and insert "Id, "', async () => {
  const { fetchImpl, calls } = fakeApi();
  const services = { nuget: createNuGetClient(fetchImpl), assemblies: () => [] };
  const [t, i] = at('#r "nuget: newt|');
  const r = await completeR(t, i, services);
  assert.deepEqual(r.items.map((x) => x.label), ['Newtonsoft.Json', 'Newtonsoft.Json.Bson']);
  assert.equal(r.items[0].insertText, 'Newtonsoft.Json, ');
  assert.equal(r.items[0].start, 11);
  assert.ok(calls[0].includes('q=newt') && calls[0].includes('prerelease=false'), calls[0]);
  await completeR(t, i, services);
  assert.equal(calls.length, 1, 'same query is cached');
});

test('versions of the chosen package, newest first; the replaced range starts after the comma', async () => {
  const { fetchImpl, calls } = fakeApi();
  const services = { nuget: createNuGetClient(fetchImpl), assemblies: () => [] };
  const text = '#r "nuget: Newtonsoft.Json, 13.|';
  const [t, i] = at(text);
  const r = await completeR(t, i, services);
  assert.deepEqual(r.items.map((x) => x.label), ['13.0.3', '13.0.1']);
  assert.equal(r.items[0].detail, 'Newtonsoft.Json (latest)');
  assert.equal(t.slice(r.items[0].start, i), '13.');
  assert.ok(calls[0].endsWith('/newtonsoft.json/index.json'), calls[0]);
});

test('API failures give no items and are not cached', async () => {
  let n = 0;
  const bad = async () => { n++; if (n === 1) throw new Error('offline'); return { ok: true, status: 200, json: async () => ({ data: ['Serilog'] }) }; };
  const services = { nuget: createNuGetClient(bad), assemblies: () => [] };
  const [t, i] = at('#r "nuget: ser|');
  assert.deepEqual((await completeR(t, i, services)).items, []);
  assert.deepEqual((await completeR(t, i, services)).items.map((x) => x.label), ['Serilog']);
  const missing = createNuGetClient(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  assert.deepEqual(await missing.versions('nope'), []);
  assert.equal(await completeR('var x = "', 9, services), null);
});
