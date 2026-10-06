// Pure helpers for the Syntax view (unit-tested in tests/js): mapping between editor offsets and the syntax tree JSON from SyntaxTreeModel.
// Node: { k, t: node|token|trivia, s, e, fs, fe, c?: [...] }. s/e = span, fs/fe = full span (with trivia).

/** Child indices from the root down to the deepest element whose full span covers [start, end]; [] = the root. */
export function findPath(root, start, end = start) {
  const path = [];
  let node = root;
  for (;;) {
    const kids = node.c;
    if (!kids) break;
    let next = -1;
    for (let i = 0; i < kids.length && next < 0; i++) {
      const c = kids[i];
      const ok = start === end
        ? (start >= c.fs && start < c.fe) || (i === kids.length - 1 && start === c.fe && c.fe === node.fe)   // caret at the very end of the text
        : start >= c.fs && end <= c.fe;
      if (ok) next = i;
    }
    if (next < 0) break;
    path.push(next);
    node = kids[next];
  }
  return path;
}

export function nodeAt(root, path) { let n = root; for (const i of path) n = n.c[i]; return n; }

/** The {start, end} to select in the editor for a tree element. */
export function selectionOf(n) { return { start: n.s, end: n.e }; }

/** Tokens and trivia of a node in source order (flattened), useful for tests and a text export of the tree. */
export function* walk(n, depth = 0) {
  yield { n, depth };
  if (n.c) for (const c of n.c) yield* walk(c, depth + 1);
}

/** Token children list ordering: leading trivia, then the token itself conceptually; the tree shows trivia as children of the token. */
export function label(n) {
  if (n.t === 'node') return n.k;
  const v = n.v ?? '';
  return n.k + ' ' + JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v);
}
