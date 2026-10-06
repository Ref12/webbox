import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RuntimeClient, CancelledError, serve, batcher, SessionLog } from '../../src/CsRepl.Wasm/wwwroot/protocol.js';

// an in-memory "worker": the client posts to handlers served by serve(), answers come back through the same message plumbing
function fakeWorld(handlers) {
  const toWorker = new EventEmitter(), toPage = new EventEmitter();
  const scope = { postMessage: (m) => queueMicrotask(() => toPage.emit('message', { data: m })), addEventListener: (t, f) => toWorker.on(t, f) };
  serve(scope, handlers);
  const w = { terminated: false, postMessage: (m) => queueMicrotask(() => { if (!w.terminated) toWorker.emit('message', { data: m }); }), terminate() { w.terminated = true; },
    addEventListener: (t, f) => toPage.on(t, f), crash: (message) => toPage.emit('error', { message }) };
  return w;
}

test('request/response with ids and unknown ops', async () => {
  const c = new RuntimeClient(() => fakeWorld({ add: async ({ a, b }) => a + b }), {}).start();
  assert.equal(await c.request('add', { a: 1, b: 2 }), 3);
  await assert.rejects(c.request('nope'), /unknown op nope/);
  assert.equal(c.running, false);
});

test('concurrent requests are matched by id', async () => {
  const c = new RuntimeClient(() => fakeWorld({ slow: () => new Promise((r) => setTimeout(() => r('slow'), 20)), fast: async () => 'fast' })).start();
  const [a, b] = await Promise.all([c.request('slow'), c.request('fast')]);
  assert.deepEqual([a, b], ['slow', 'fast']);
});

test('streamed output reaches onOut before the result', async () => {
  const c = new RuntimeClient(() => fakeWorld({ run: async (_, ctx) => { ctx.out('a'); ctx.out('b'); return 'done'; } })).start();
  const got = [];
  assert.equal(await c.request('run', {}, { onOut: (t) => got.push(t) }), 'done');
  assert.deepEqual(got, ['a', 'b']);
});

test('events go to onEvent', async () => {
  const ev = [];
  const c = new RuntimeClient(() => fakeWorld({ go: async (_, ctx) => { ctx.emit('badge', { text: 'x' }); return 1; } }), { onEvent: (e) => ev.push(e) }).start();
  await c.request('go');
  assert.deepEqual(ev, [{ text: 'x', event: 'badge' }]);
});

test('terminate rejects what is pending with CancelledError and ignores late answers', async () => {
  let release; const gate = new Promise((r) => (release = r));
  const first = fakeWorld({ hang: () => gate });
  const second = fakeWorld({ hang: async () => 'fresh' });
  const workers = [first, second];
  const c = new RuntimeClient(() => workers.shift()).start();
  const p = c.request('hang');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(c.running, true);
  c.terminate('stopped');
  await assert.rejects(p, (e) => e instanceof CancelledError && e.message === 'stopped');
  assert.equal(first.terminated, true);
  assert.equal(c.running, false);
  release('late');   // the dead worker answers after all: must not touch the new generation
  c.start();
  assert.equal(await c.request('hang'), 'fresh');
});

test('restart gives a working worker; requests before start throw', async () => {
  const c = new RuntimeClient(() => fakeWorld({ ping: async () => 'pong' }));
  assert.throws(() => c.request('ping'), /not started/);
  c.start(); assert.equal(await c.request('ping'), 'pong');
  c.restart(); assert.equal(await c.request('ping'), 'pong');
});

test('a crashed worker rejects pending requests and reports the event', async () => {
  const ev = []; let w;
  const c = new RuntimeClient(() => (w = fakeWorld({ hang: () => new Promise(() => {}) })), { onEvent: (e) => ev.push(e) }).start();
  const p = c.request('hang');
  w.crash('boom');
  await assert.rejects(p, /crashed: boom/);
  assert.equal(ev[0].event, 'crashed');
});

test('batcher: first write is immediate, a burst is coalesced, flush drains', () => {
  let t = 0; const timers = []; const sent = [];
  const b = batcher((x) => sent.push(x), 30, () => t, (f) => (timers.push(f), timers.length));
  b.write('a');                    // immediate
  t = 5; b.write('b'); b.write('c');   // buffered
  assert.deepEqual(sent, ['a']);
  t = 40; timers.shift()();        // timer fires
  assert.deepEqual(sent, ['a', 'bc']);
  t = 41; b.write('d'); b.flush();
  assert.deepEqual(sent, ['a', 'bc', 'd']);
});

test('SessionLog keeps order and resets', () => {
  const l = new SessionLog(); l.add('a'); l.add('b');
  assert.deepEqual(l.codes, ['a', 'b']); assert.equal(l.length, 2);
  l.reset(); assert.equal(l.length, 0);
});
