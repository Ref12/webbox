# Azure DevOps pull request experience: what we studied and what we copy

Everything here comes from screenshots taken with headless Chromium (`tests/azdo-capture.mjs`, `azdo-interact.mjs`, `azdo-interact2.mjs`)
of the public `dnceng-public/public/dotnet-public-wiki` repository, at 1600×1000 (`*-desktop.png`) and 390×844 (`*-phone.png`),
in `docs/reference/`. The pages are small (one to four files, mostly added files plus one real edit, commit `cd6039e6`, `Home.md`
−9 +31), so edit behaviour comes from the commit page and the compare page. I did not find a bigger public Azure DevOps PR with several edits;
big-PR behaviour (virtualization, lazy loading) is therefore our own design, tested on dotnet/runtime#135064 (6 files) and by unit tests.

## The pages

| Capture | What it shows |
| --- | --- |
| `pr-files-desktop` / `-phone` | PR 5, **Files** tab. Header (title, state badge, "X proposes to merge a into b"), tabs Overview / Files / Updates / Commits, a toolbar (**All Changes** picker, **Filter**, "1 changed file", **Inline** toggle + dropdown, full-screen), the tree on the left and the diff cards on the right. |
| `pr-overview-*`, `pr-updates-*`, `pr-commits-*` | Overview: description, checks, reviewers, comments. **Updates**: a timeline, one card per push ("pushed 1 commit", commit title/hash/author/time). **Commits**: a flat commit list. |
| `pr-files-allchanges-menu` | The iteration picker: "All Changes" plus one row per update (number, title, date) with checkboxes; the hint says Shift-click selects a range. |
| `compare-files-*` | Branch compare: "Comparing af56d96f to 4728a89a" (branch/commit pickers, swap), Commits / Files tabs, 4 added files stacked, tree with a **+** badge on every file. |
| `commit-*` | Single commit, **Files** / **Details** tabs, "Parent 1 → This commit" picker, **Browse Files**. The only page with a real edit: red/green lines, collapsed context, word marks. |
| `*-side-by-side` | After clicking the layout toggle: old on the left, new on the right, **hatched filler** where one side has no line. |
| `commit-collapsed` / `-expanded` | The chevron at the left of a file header collapses the card to its header and back. |
| `commit-context-expanded` | Clicking a "…" separator reveals the hidden unchanged lines. |
| `commit-view-full` | **View** opens that one file in a full-file diff: single file, sticky header with ↑ ↓ buttons (previous/next change), a layout toggle, and a coloured **overview strip** in the scrollbar showing where the changes are. |
| `*-filter-typed` | **Filter** opens a popover: "Filter results", a search box, suggestions "Keyword: /Home.md" and "Keyword". It filters the tree and the cards. |
| `commit-phone`, `commit-phone-filter` | Phone: the left nav and the file tree are gone; the cards stack in one inline column; Filter opens a full-screen panel. |

## Parts, and what we copy

* **File tree** (left, ~300 px). Folder rows with a chevron, file rows with a type icon and a small badge (**+** added, edited, deleted, renamed). Folders are
  sorted before files. Copy: tree on the left, folders first, single-child folders joined into one path (`src/tools/illink`), badges **A / M / D / R**
  with colours, `+n −n` counts per file and per folder, a filter. The selected file is highlighted; scrolling the right side moves the highlight (our `cur` marker).
  Phone: AzDO hides the tree entirely. We make it a **drawer** (☰) instead, as asked.
* **Diff cards.** Each file is a white card with a shadow: chevron, icon, bold name with `+13` / `−9 +31`, the path in small grey, and a **View** button at the right.
  Copy: stacked cards (all files) or one file at a time, the same header facts, **Reviewed** checkbox and **View** button in the header, an external link to GitHub.
* **Full-file diff with expandable context.** Unchanged runs are collapsed to a separator; **View** shows the whole file. We compute the diff in the browser
  from both full file versions, so the context is real: each separator offers **↑ 20**, **↓ 20** and **Show all**, and the toolbar/each file can switch to the full file.
* **Inline vs side-by-side.** A segmented toggle (AzDO: a toggle button + dropdown). Inline: two line-number columns, +/− sign, red and green rows, darker **word-level** marks.
  Side-by-side: two panes, hatched filler for the missing side. Copy both; we also remember the choice and put it in the URL (`m=split`).
* **Per-file collapse.** The chevron collapses a card to its header. Copy, plus "Collapse all" and the key `c`. Collapsed files keep the header (and sticky behaviour) so the
  Reviewed checkbox is still reachable.
* **Reviewed checkboxes.** AzDO has a per-file "Reviewed" state (signed-in only; the public pages only show a root checkbox). We implement per-file checkboxes, a tick in the tree,
  and "n reviewed" in the toolbar, stored in localStorage per PR **and head SHA** (a new push resets it, as in AzDO where a new iteration marks files as changed).
* **Update / iteration picker.** "All Changes" ▾ lists iterations; click one for its changes, Shift-click for a range. GitHub has commits instead of iterations, so the picker lists commits:
  *All changes* (merge base → head), *one commit* (parent → commit) or *a range* (parent of the first → last). The choice is in the URL (`c=abc1234..def5678`).
  The AzDO **Updates** tab (a timeline of pushes) is covered by this picker plus our **Commits** tab; the commit page's "Parent 1 → This commit" is the single-commit case.
* **Overview / Commits tabs.** Overview: description, stats and the conversation. Commits: the list, each with "View changes" (opens that commit in Files).
* **Filter.** Case-insensitive path substring; filters tree and diff; opens all folders while active. (AzDO's keyword suggestions are not needed for a path filter.)
* **Full view ("View").** The button toggles that file between "changes with 3 lines of context" and the whole file. AzDO opens a separate single-file page with a change overview strip;
  we keep it in place (it is still virtualized) and add next/previous change navigation (`n`/`p`, ↑/↓ buttons). The overview strip is not copied.
* **Keyboard.** The AzDO diff has ↑ ↓ change navigation buttons in the full-file view and tab/arrow navigation in the tree. We add `j`/`k` (file), `n`/`p` (change), `r`, `c`, `s`, `f`, `a`, `/`, `t`, `?`.
* **Comments.** None of the captured pages has a comment thread (the public PRs have none; `Home.md` was the only real edit and nobody commented on it), so the thread look is from the AzDO conventions we saw elsewhere on those pages (cards with a soft shadow, avatar + name + time, a status pill at the top, a reply box at the bottom) rather than from a screenshot of a thread. v2 copies: **boxes between the lines** the thread refers to (in every view mode), a header with the status (**Active / Resolved / Pending / Outdated**) and a chevron to collapse, a **reply** box, **Resolve / Unresolve**, a hover **+** in the gutter that opens an inline composer (Write / Preview, multi-line by shift-click or drag), and AzDO's *Comments* list as a side panel with jump-to. Resolved threads start collapsed. GitHub has no "Won't fix / Closed" states, so the status is just active or resolved. Outdated threads (their lines are gone) are listed per file under a collapsible "Outdated comments" line.

## Deliberately different

* We style it with GitHub-neutral colours and a dark theme; AzDO's left product navigation is omitted (the app is one page).
* GitHub PRs have no iterations/policies/votes: the header shows state, author, branches and a link to GitHub.
* Long lines: inline scrolls sideways; side-by-side **wraps each long line inside its pane** (rows grow), so nothing is clipped and there is no sideways scroll.
* Review comments post straight away (**Comment**) or collect into a pending review (**Add to review**, then **Finish review** with Comment / Approve / Request changes), as on GitHub; AzDO's per-reviewer votes do not exist here.
