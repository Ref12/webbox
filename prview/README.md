# PR viewer

Review a GitHub pull request the way Azure DevOps shows it. Static page, no build, no server: the browser talks to the GitHub REST API directly.

* Open `prview/#/<owner>/<repo>/pull/<n>` or paste a github.com PR URL into the box (`https://github.com/o/r/pull/5/files`, `o/r#5`, and this page's own links all work).
* **Public repositories need no sign-in.** GitHub allows 60 API requests per hour per IP without a token; the page shows the remaining count ("API 55/60") and explains it when the limit is hit.
  A **token** (⚙ Settings; fine-grained, *Pull requests: read* and *Contents: read*) raises that to 5,000 and opens private repositories. It is stored only in this browser's `localStorage` and sent only to api.github.com.
* **Data.** PR, files, commits, review comments, and the merge base (5 requests). File contents of both versions come from raw.githubusercontent.com for public repos (no API quota) or the contents API with a token; they load lazily as files scroll into view.
  The diff is computed in the browser (Myers, `lib/diff.js`), so unchanged regions can be shown in full and expanded (↑20 / ↓20 / all), with word-level marks inside changed lines.
* **Layout.** Left: file tree (folders joined, A/M/D/R badges, +/− counts, filter). Right: all files stacked or one at a time; inline or side-by-side; per-file collapse; sticky file header; **Reviewed** per file (localStorage, per PR and head SHA); **View** = the whole file; syntax highlighting (lazy-loaded `lib/highlight.js`).
  Commit picker: *All changes*, one commit, or a range (Shift-click). Tabs: Files, Overview, Commits. Existing review comments are shown at their lines (read only; posting is not implemented).
* **Big PRs.** The tree and the diff pane are virtualized (only the visible rows exist in the DOM); files are fetched only when near the viewport (4 at a time); binary and generated files (lock files, `*.min.js`, `*.designer.cs`, `dist/`…) and very large ones are skipped with a **Load anyway** link.
* **Phone** (≤ 800 px): the tree is a drawer (☰ or `t`).
* External links open in a new tab (`target=_blank`, `rel=noopener`).

## Keys

| Key | |
| --- | --- |
| `j` / `k` | next / previous file |
| `n` / `p` | next / previous change (moves on to the next file at the end) |
| `r` | mark the current file reviewed |
| `c` | collapse / expand the current file |
| `s` | inline ⇄ side-by-side |
| `f` | changes only ⇄ full files |
| `a` | all files stacked ⇄ one file |
| `/` | filter files |
| `t` | show / hide the tree (phone) |
| `?` | help |

URL state: `#/o/r/pull/5?f=<file>&c=<sha7>[..<sha7>]&m=split&v=one&x=1` (file, commits, side-by-side, one-file view, full files) and `/commits`, `/overview` tabs.

## Files

| | |
| --- | --- |
| `index.html`, `style.css`, `app.js` | the app (state, virtual lists, rendering) |
| `lib/diff.js` | line diff, word diff, row layout with collapsible context |
| `lib/tree.js` | file tree building, flattening for the virtual list |
| `lib/url.js` | PR URL and route parsing |
| `lib/github.js` | REST client, rate-limit errors, binary/generated detection |
| `lib/highlight.js` | small lazy syntax highlighter |
| `lib/render.js` | escaping, highlighted line + word marks, small markdown |
| `manifest.webmanifest`, `sw.js`, `icons/` | installable (same pattern as speech-test) |
| `docs/azdo-notes.md`, `docs/reference/` | the Azure DevOps study and its screenshots |
| `docs/screenshots/` | our viewer, from the e2e run |

## Tests (`tests/`)

```
cd prview/tests && npm install
node --test unit.test.mjs        # diff, tree, URL parsing, highlighter
node --test e2e.test.mjs         # headless Chromium (/usr/bin/chromium) against tests/fixtures/*.json, no network
node smoke.mjs                   # live: opens dotnet/runtime#135064 anonymously (a few API requests)
node record-fixture.mjs o/r#n    # re-record a fixture from the live API
```

The e2e fixture is a recording of the real API responses for dotnet/runtime#135064 (6 files, 3 commits, review comments); any unrecorded request fails the test.
No GitHub Pages change is needed: every folder is published as it is.
