// Message protocol between the page and a runtime worker (see runtime-worker.js). Plain JS, no DOM: unit-tested in tests/js/protocol.test.mjs.
//   page -> worker   { id, op, args }
//   worker -> page   { id, ok: true, result } | { id, ok: false, error }        the answer to a request
//                    { event: 'out', id, text }                                  streamed Console output of request <id>
//                    { event: <name>, ... }                                      anything else (status, badge, metrics, ready)
// Cancelling a running request means terminating the worker: the page rejects every pending request with a CancelledError and starts a new one.

export class CancelledError extends Error {
  constructor(reason = 'cancelled') { super(reason); this.name = 'CancelledError'; }
}

/** Page side. spawn() returns a Worker-like object: { postMessage, terminate, addEventListener('message'|'error') }. */
export class RuntimeClient {
  constructor(spawn, { onEvent = () => {}, name = 'runtime' } = {}) {
    this.spawn = spawn; this.onEvent = onEvent; this.name = name;
    this.nextId = 1; this.pending = new Map(); this.worker = null; this.generation = 0;
  }
  get running() { return this.pending.size > 0; }
  start() {
    const gen = ++this.generation;
    const w = (this.worker = this.spawn());
    w.addEventListener('message', (e) => { if (gen === this.generation) this.#message(e.data); });
    w.addEventListener('error', (e) => { if (gen === this.generation) this.#crashed(e.message || 'worker error'); });
    return this;
  }
  /** Sends a request; resolves with the result. onOut receives streamed output chunks. */
  request(op, args = {}, { onOut } = {}) {
    if (!this.worker) throw new Error(this.name + ' worker is not started');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onOut, op });
      this.worker.postMessage({ id, op, args });
    });
  }
  /** Kills the worker (a running loop cannot be interrupted any other way) and rejects everything in flight. */
  terminate(reason = 'stopped') {
    this.generation++;
    try { this.worker?.terminate(); } catch { /* already gone */ }
    this.worker = null;
    const err = new CancelledError(reason);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
  restart(reason) { this.terminate(reason); return this.start(); }
  #crashed(message) {
    const err = new Error(this.name + ' worker crashed: ' + message);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.onEvent({ event: 'crashed', message });
  }
  #message(m) {
    if (m.event === 'out') { this.pending.get(m.id)?.onOut?.(m.text); return; }
    if (m.event) { this.onEvent(m); return; }
    const p = this.pending.get(m.id);
    if (!p) return;   // answer for a request that was cancelled
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.result); else p.reject(Object.assign(new Error(m.error), { remote: true }));
  }
}

/** Worker side. scope: the worker global ({ postMessage, addEventListener }); handlers: { op: async (args, ctx) => result }. ctx.out(text) streams output, ctx.emit(event, data) posts an event. */
export function serve(scope, handlers) {
  scope.addEventListener('message', async (e) => {
    const { id, op, args } = e.data || {};
    if (id === undefined) return;
    const ctx = {
      out: (text) => scope.postMessage({ event: 'out', id, text }),
      emit: (event, data = {}) => scope.postMessage({ ...data, event }),
    };
    try {
      if (!handlers[op]) throw new Error('unknown op ' + op);
      scope.postMessage({ id, ok: true, result: await handlers[op](args ?? {}, ctx) });
    } catch (err) {
      scope.postMessage({ id, ok: false, error: String(err?.message ?? err) });
    }
  });
}

/** Coalesces many tiny writes into few messages: the first write goes out at once, later ones are buffered for at most intervalMs (or until flush()). */
export function batcher(send, intervalMs = 30, clock = () => performance.now(), schedule = setTimeout) {
  let buf = '', last = -Infinity, timer = null;
  const flush = () => { if (timer) { clearTimeout?.(timer); timer = null; } if (buf) { const t = buf; buf = ''; last = clock(); send(t); } };
  const write = (text) => {
    buf += text;
    if (clock() - last >= intervalMs) flush();
    else if (!timer) timer = schedule(() => { timer = null; flush(); }, intervalMs);
  };
  return { write, flush };
}

/** A submission that has to be replayed after a restart, in order: the page keeps the successful ones. */
export class SessionLog {
  constructor() { this.codes = []; }
  add(code) { this.codes.push(code); return this.codes.length - 1; }
  reset() { this.codes = []; }
  get length() { return this.codes.length; }
}
