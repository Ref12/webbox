# Regions

A playable Queens/Meowdoku-style region-placement puzzle. Static, no build step, no dependencies, no network calls (a small service worker caches the folder for offline play).

Rules: n×n grid, n connected colour regions; one marker in every row, column and region; markers may not touch, even diagonally (distant markers on a diagonal are fine).

- `index.html`, `app.js`, `app.css`, `sw.js`: the app. `#<board id>` in the URL opens a board.
- `boards/`: the 29-board bank (5..9.json) and its README (format, grading), copied unedited from Ref12/langapp `langapp/region-puzzle-bank` (7967076a).
- `lib/`: `rules`, `logic` (no-guess solver), `validate` copied from the bank's `src/core/games/regions`; `schema.mjs` is a zod-free stand-in with the same exports and strictness (the original needs zod); `play.mjs` is the UI's state helpers (violations, auto-✕, hint).
- The bank is validated (`validateBank`) at startup; the console logs the board count.
- Hint: runs the solver's deduction from the empty board and reveals the first forced marker you have not placed (or flags markers that are wrong).
- Colour challenge: near shades of one hue plus a glyph per region (shapes, or HSK 1 characters 我 你 他 好 是 的 不 人 学 生 老 师). Presentation only.
- Controls: tap cycles empty → ✕ → marker; long-press and drag (or "Drag ✕") paints ✕; arrows, space/x, u (undo), h (hint), n (next).
- Test: `node regions/test.mjs`.
