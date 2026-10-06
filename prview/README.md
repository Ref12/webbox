# PR viewer

Review a GitHub pull request the way Azure DevOps shows it, and **comment on it**: inline threads, replies, resolve, batched reviews. Static page, no build, no server: the browser talks to the GitHub API directly.

## Signing in = adding a GitHub token

There is no OAuth and no proxy: the page talks only to api.github.com and raw.githubusercontent.com. Without a token it works read-only for public repositories (60 API requests/hour per IP). To **comment, review, open private repositories** and get **5,000/hour**, click **Sign in** (or the dimmed **+** in the gutter, or ⚙ Settings) and paste a personal access token:

1. Open https://github.com/settings/personal-access-tokens/new (fine-grained token).
2. Name and expiry; **Repository access**: the repositories you review (or all).
3. **Repository permissions: Pull requests = Read and write, Contents = Read-only.**
4. **Generate token**, copy `github_pat_…`, paste it in the dialog, **Save token**.

A **classic** token also works: `public_repo` (public repositories) or `repo` (private ones too). The token is checked against `GET /user`; the avatar and login then show top right. It is kept only in this browser's `localStorage` (`prview.token`), sent only to api.github.com, and removed by **Sign out** (avatar menu or ⚙ Settings).

## Using it

* Open `prview/#/<owner>/<repo>/pull/<n>` or paste a github.com PR URL into the box (`https://github.com/o/r/pull/5/files`, `o/r#5`, and this page's own links all work).
* **Signed out:** public repositories only, 60 API requests/hour per IP (the header shows "API 55/60"). **Signed in with a token** (avatar and login top right, **Sign out** in its menu): private repositories, commenting, **5,000/hour**.

### Home: lists of PRs (`prview/#/`)

* **For me** (signed in): *Review requested*, *Authored by me*, *Assigned to me*, *Mentioned* (`is:pr is:open review-requested:@me`, `author:@me`, `assignee:@me`, `mentions:@me`).
* **A repo**: `owner/repo` (or its URL), **Open / Closed / Merged / All**, a **filter box** (title search) and paging. Works signed out for public repos (open list: the pulls API; filters and other states: the search API, 10 requests/minute anonymous).
* **Recent**: PRs you opened in the viewer (localStorage, last 30).
* Each row: title, number, repo, author, updated time, state, and, signed in, the **review state** (Approved / Changes requested / Review required) and **checks** (passed / failed / running). They come in the same GraphQL request, so they cost nothing extra; signed out they are not shown.

### The diff

* **Data.** PR, files, commits, review comments, and the merge base (compare call); file contents of both versions come from raw.githubusercontent.com for anonymous use (no API quota) or the contents API when signed in; they load lazily as files scroll into view. The diff is computed in the browser (Myers, `lib/diff.js`), so unchanged regions can be shown in full and expanded (↑20 / ↓20 / all), with word-level marks.
* **One file at a time is the default**, on desktop and phone: the selected file fills the diff pane (opening a PR shows the first file, or the `f=` file). Next / previous file: `j` / `k`, the **‹ n / N ›** buttons in the toolbar, a **horizontal swipe** on the phone, or pick one in the tree (the drawer on a phone). **⚙ Settings → All files stacked** (desktop and phone) switches to the stacked view; it is remembered in `localStorage` (`prview.view`). `a` toggles for the session.
* **Layout.** Left: file tree (folders joined, A/M/D/R badges, +/− counts, filter). Right: one file (or, by setting, all stacked); inline or side-by-side; per-file collapse; sticky file header; **Reviewed** per file (localStorage, per PR and head SHA); **View** = the whole file; syntax highlighting. Commit picker: *All changes*, one commit, or a range (Shift-click). Tabs: Files, Overview, Commits.
* **Long lines.** Inline scrolls sideways. Side-by-side **wraps long lines inside their own pane** (rows get taller), so nothing is clipped and there is no sideways scroll.
* **URL state.** `#/o/r/pull/5?f=<file>&c=<sha7>[..<sha7>]&m=split&v=all&x=1` (`v=one` is the default and is left out unless the stacked setting is on; `v=all` stacks, `v=one` forces one file). Changing `c=` or `f=` in the address bar while that PR is open applies it **without reloading the PR**; opening a link with `f=` shows that file (stacked: scrolls to it and holds it there while the files around it load).
* **Big PRs.** Tree and diff pane are virtualized; files fetch when near the viewport (4 at a time); binary/generated/huge files are skipped with a **Load anyway** link. **Phone** (≤ 800 px): the tree is a drawer, opened by the **file-explorer icon** (a folder with two items on tree lines, an inline SVG in `currentColor`) or `t`.

### Comments

* **Threads are boxes between the lines** they refer to, in every mode (inline, side-by-side, all files stacked, one file, full files): status pill (Active / Resolved / Pending / Outdated), collapse chevron, every comment with avatar, login, time and a link to GitHub, a **reply** box, **Resolve / Unresolve**. Resolved threads start collapsed. Multi-line threads sit under their last line.
* **Outdated** comments (their lines are no longer in the diff) are in a collapsible **Outdated comments (n)** list at the top of each file.
* **Comments panel** (💬 in the toolbar, or `m`): every thread, grouped by file, filter *All / Active / Resolved / Outdated / Pending*, click to jump (it switches to *All changes* if needed, shows the file, scrolls to the line and opens the box, and flashes it; works in one-file mode too).
* **Signed out** the comment points are still visible: a dimmed **+** in the gutter (tooltip / tap: *Add a GitHub token to comment*) and an *Add a GitHub token to reply* button in threads; both open the token dialog.
* **Add a comment** (signed in, *All changes* selected): hover a line, click the **+** in the gutter (or press `c`). **Shift-click** another + or **drag** from one + to another for several lines. An inline composer opens between the lines: **Write / Preview** (Markdown), **± Suggest** (quotes the lines as a `suggestion` block), **Comment** (posts now: `POST /repos/{o}/{r}/pulls/{n}/comments` with `commit_id`, `path`, `line`, `side`, `start_line`/`start_side`), **Add to review** (kept as *pending*), Ctrl+Enter posts, Esc cancels. Only lines inside the diff hunks get a + (GitHub refuses the others); GitHub's error is shown in the box and your text is kept.
* **Batched review.** Pending comments (stored in localStorage per PR and head SHA, so they survive a reload) show in their place with a dashed border, editable and deletable. **Finish review (n)** asks for a summary and **Comment / Approve / Request changes** and sends one `POST …/pulls/{n}/reviews` with all comments. The same button, labelled **Review**, approves or requests changes with no pending comments.
* **Reply** posts `…/comments/{id}/replies`. **Resolve/Unresolve** uses GraphQL `resolveReviewThread` / `unresolveReviewThread` (the thread ids and resolved states come from one `reviewThreads` query when signed in; signed out threads are read-only and show no Resolve).
* **Safe rendering.** Comment bodies go through a small Markdown renderer (`lib/render.js`) that escapes everything first: bold/italic/strike, code, fences and suggestions, quotes, lists, headings, `http(s)` links (new tab, `noopener`). Raw HTML, images and `javascript:` links are shown as text, never as elements.
* Comments show only in *All changes*: their positions refer to the PR head. While a single commit or a range is selected the toolbar says so, and the panel still lists them.

## Keys

| Key | |
| --- | --- |
| `j` / `k` | next / previous file |
| `n` / `p` | next / previous change (moves on to the next file at the end) |
| `c` | **comment on the line under the pointer** (or the first changed line in view); signed out: opens the token dialog |
| `m` | comments panel |
| `r` | mark the current file reviewed |
| `x` | collapse / expand the current file (was `c` in v1) |
| `s` | inline ⇄ side-by-side |
| `f` | changes only ⇄ full files |
| `a` | one file ⇄ all files stacked (the setting is in ⚙ Settings) |
| `/` | filter files |
| `t` | show / hide the tree (phone drawer) |
| `?` | help |
| in a comment box | `Ctrl+Enter` post, `Esc` cancel |

## Files

| | |
| --- | --- |
| `index.html`, `style.css`, `app.js` | the app (state, virtual lists, rendering, comments UI) |
| `lib/diff.js` | line diff, word diff, row layout with collapsible context |
| `lib/tree.js` | file tree building, flattening for the virtual list |
| `lib/url.js` | PR URL and route parsing |
| `lib/github.js` | REST + GraphQL client, rate-limit and write errors, search/list queries, binary/generated detection |
| `lib/auth.js` | the stored token and user (localStorage) |
| `lib/signin.js` | the add-a-token and settings dialogs |
| `lib/home.js` | the PR lists |
| `lib/threads.js` | grouping comments into threads, hunks (where a + may appear), pending comments |
| `lib/highlight.js` | small lazy syntax highlighter |
| `lib/render.js` | escaping, highlighted line + word marks, safe Markdown |
| `manifest.webmanifest`, `sw.js`, `icons/` | installable (same pattern as speech-test) |
| `docs/azdo-notes.md`, `docs/reference/` | the Azure DevOps study and its screenshots |
| `docs/screenshots/` | our viewer, from the e2e run |

## Tests (`tests/`)

```
cd prview/tests && npm install
node --test unit.test.mjs unit-v2.test.mjs   # diff, tree, URL, highlighter; token session, threads, API request shapes, lists, Markdown safety
node --test e2e.test.mjs e2e-v2.test.mjs e2e-v3.test.mjs     # headless Chromium (/usr/bin/chromium) against tests/fixtures/*.json, no network
node smoke.mjs                               # LIVE, read-only, anonymous: opens dotnet/runtime#135064 and lists dotnet/runtime PRs (a handful of API requests)
node record-fixture.mjs o/r#n                # re-record a fixture from the live API
```

The e2e fixture is a recording of the real API responses for dotnet/runtime#135064 (6 files, 3 commits, a multi-line live thread, a three-comment thread and an outdated one; resolved state comes from the mocked GraphQL answer); any unrecorded request fails the test. `e2e-v3` covers the one-file default, the stacked setting, file navigation, the phone drawer and tree icon, and the signed-out comment hint. (Most older tests seed `prview.view="all"` through the harness; `start({ view: null })` gives the real default.) `e2e-v2` adds mocks (`harness.mjs`: `h.on(method, regex, fn)`) for everything that writes or needs a login: `/user` (token sign-in), GraphQL (review threads, resolve, PR search), the comment / reply / review POSTs. **No test posts to GitHub**; the live smoke never signs in.
No GitHub Pages change is needed: every folder is published as it is.
