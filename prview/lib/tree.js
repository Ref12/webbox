// File tree for a PR: nested folders, single-child folders collapsed into one path, change badges, filter.

export const STATUS = {
  added: { badge: 'A', label: 'Added' }, removed: { badge: 'D', label: 'Deleted' },
  modified: { badge: 'M', label: 'Edited' }, renamed: { badge: 'R', label: 'Renamed' },
  copied: { badge: 'C', label: 'Copied' }, changed: { badge: 'M', label: 'Edited' }, unchanged: { badge: 'M', label: 'Edited' },
};

export function buildTree(files) {
  const root = { type: 'dir', name: '', path: '', children: [], files: 0, add: 0, del: 0 };
  for (const f of files) {
    const parts = f.filename.split('/');
    let dir = root;
    root.files++; root.add += f.additions || 0; root.del += f.deletions || 0;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let next = dir.children.find(c => c.type === 'dir' && c.path === path);
      if (!next) { next = { type: 'dir', name: parts[i], path, children: [], files: 0, add: 0, del: 0 }; dir.children.push(next); }
      next.files++; next.add += f.additions || 0; next.del += f.deletions || 0;
      dir = next;
    }
    dir.children.push({ type: 'file', name: parts[parts.length - 1], path: f.filename, file: f });
  }
  const finish = d => {
    d.children.sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name, 'en', { numeric: true }) : x.type === 'dir' ? -1 : 1));
    for (let i = 0; i < d.children.length; i++) {
      let c = d.children[i];
      if (c.type !== 'dir') continue;
      while (c.children.length === 1 && c.children[0].type === 'dir') { // a/ -> b/ -> c.txt  =>  a/b/
        const only = c.children[0];
        c = { ...only, name: c.name + '/' + only.name };
      }
      d.children[i] = c;
      finish(c);
    }
  };
  finish(root);
  return root;
}

/** Visible rows [{node, depth}]; collapsed is a Set of dir paths; a filter shows only matching files (case-insensitive path substring) and opens every folder. */
export function flattenTree(root, { collapsed = new Set(), filter = '' } = {}) {
  const q = filter.trim().toLowerCase();
  const rows = [];
  const matches = n => n.type === 'file' ? n.path.toLowerCase().includes(q) : n.children.some(matches);
  const walk = (d, depth) => {
    for (const c of d.children) {
      if (q && !matches(c)) continue;
      rows.push({ node: c, depth });
      if (c.type === 'dir' && (q || !collapsed.has(c.path))) walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** Files in the order the tree shows them (what next/previous file walks). */
export function orderedFiles(root) {
  const out = [];
  const walk = d => { for (const c of d.children) c.type === 'file' ? out.push(c.file) : walk(c); };
  walk(root);
  return out;
}
