// Input history for the REPL: Ctrl+Up / Ctrl+Down cycle through earlier submissions.
// The text being typed is stashed when navigation starts and comes back, exactly, when you go Down past the newest entry.
export class History {
  constructor() { this.items = []; this.pos = null; this.stash = ''; }

  /** A submission was run (or attempted): remember it and leave navigation mode. */
  add(code) {
    if (code.trim() && this.items[this.items.length - 1] !== code) this.items.push(code);
    this.reset();
  }
  reset() { this.pos = null; this.stash = ''; }
  get navigating() { return this.pos !== null; }

  /** Ctrl+Up. `current` = what the input box holds now. Returns the text to put in the box, or null for "nothing to do". */
  prev(current) {
    if (this.items.length === 0) return null;
    if (this.pos === null) { this.stash = current; this.pos = this.items.length - 1; }
    else if (this.pos > 0) this.pos--;
    else return null;                      // already at the oldest entry
    return this.items[this.pos];
  }

  /** Ctrl+Down. Past the newest entry the stashed text is restored. */
  next() {
    if (this.pos === null) return null;    // not navigating: nothing to do
    if (this.pos < this.items.length - 1) return this.items[++this.pos];
    const s = this.stash; this.reset();
    return s;
  }
}
