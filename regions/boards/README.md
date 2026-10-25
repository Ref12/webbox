# Region-placement puzzle bank

An original, offline-generated bank for a **separate** Queens/Meowdoku-style
region-placement game. This is not character Sudoku, Mahjong or Memory. It
contains no UI, artwork, vocabulary mapping, persistence or routing.

## Rules

Each supported board is an `n` by `n` grid, with `n` nonempty, orthogonally
connected regions. Place exactly one marker in every row, column and region.
Markers may not touch, even diagonally. **Distant markers on the same diagonal
are legal**: these are not chess queens. Color is a presentation choice for each
region ID, not part of the logical rules.

## Initial inventory

| Size | Easy | Medium | Hard | Recipe seed (hex) | Last accepted attempt |
| --- | ---: | ---: | ---: | --- | ---: |
| 5 | 2 | 2 | 2 | `72656705` | 572 |
| 6 | 2 | 2 | 2 | `72656706` | 601 |
| 7 | 2 | 2 | 2 | `72656707` | 336 |
| 8 | 2 | 2 | 2 | `72656708` | 2564 |
| 9 | 2 | 2 | 1 | `72656709` | 4343 |
| Total | 10 | 10 | 9 | | |

All **29** boards have exactly one solution, a replayable no-guess proof, and no
duplicates up to square rotation/reflection and region recoloring. The original
9x9 request for two Hard boards achieved only one within 5,000 attempts; its
published quota is deliberately one. An unmet quota is an error, never permission
to relabel a puzzle or publish an incomplete bank.

## Consumer contract

`index.ts` exports `regionPuzzleBanks`, the flat `regionPuzzles` array, and
`toRegionPuzzleDefinition(puzzle)`. The latter returns only
`{ id, size, regions, difficulty }`, with an independent region array, for UI
state. Select puzzles by `size` and `difficulty`; do not derive difficulty from
size. `src/core/games/regions/types.ts` exports the inferred TypeScript contracts.

Each `<size>.json` shard is a strict versioned bank:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1`; record-format changes require explicit migration/versioning |
| `rulesVersion` | `regions-no-touch-v1` |
| `generatorVersion` | `region-growth-v1` |
| `solverVersion` | `region-logic-v1` |
| `recipe` | Board size, uint32 seed, exact per-tier quotas and bounded `maxAttempts` |
| `puzzles` | Records sorted by tier, then generation attempt |

Every puzzle contains:

| Field | Meaning |
| --- | --- |
| `id` | `regions-v1-<size>-<8-digit-hex-seed>-<attempt>` |
| `size` | Integer 5 through 9; larger sizes are deliberately unsupported |
| `regions` | Flat row-major array of exactly `size * size` integers in `0..size-1` |
| `attempt` | One-based candidate number for direct deterministic reproduction |
| `difficulty` | `easy`, `medium`, or `hard`, as defined below |
| `solution` | Array of column indices, one for each row in row order |
| `trace` | Structured, ordered deductions with witnesses and eliminated cell indices |

Cell indices are zero-based: `cell = row * size + column`. A house is
`{ kind: "row" | "column" | "region", index }`. Region labels use first-seen
row-major numbering and imply neither marker position nor teaching order.
There are no prefilled markers; singleton regions are legitimate footholds.

The strict Zod schemas live in `src/core/games/regions/schema.mjs`.
`index.ts` performs structural parsing, not expensive proof/search checks on
page load. Offline `validateBank` and `validatePuzzle` add connectivity,
uniqueness, solution, trace, provenance, ordering and quota checks.
The rule/solver functions accept an exact `{ size, regions }` board object;
extract these two fields from a puzzle rather than passing metadata to the
strict board parser.

Proofs and answers are local data and remain inspectable in the bundle. The
solution-free projection is an application boundary, not an anti-cheat measure.
Future hint UI must account for the player's current state before presenting
the canonical empty-board trace; that adaptation is not implemented here.

## Logical grading and proof format

The solver starts with every cell as a candidate, never reads the stored answer,
and never branches on a speculative placement. A placement automatically removes
its peers in the same row, column or region and the eight surrounding cells.
Each deduction removes at least one candidate, bounding traces by `size * size`.

| Tier | Available deductions | Admission requirement |
| --- | --- | --- |
| Easy | `single`: the sole candidate in a row, column or region | Singles finish |
| Medium | Singles; `confinement`: every candidate of one house lies in a second house; `adjacency`: a cell touches every remaining candidate of one house | Easy stalls, Medium finishes |
| Hard | Medium rules; `pair` and `triple`: two/three disjoint source houses have candidates in exactly two/three target houses of another family | Medium stalls, Hard finishes |

Confinement removes candidates from the target house outside the source.
Adjacency removes common touching neighbors outside the source, not chess
diagonals. Sets reserve their target houses for their source houses and remove
candidates outside the sources. Sets apply between rows, columns and regions.

These are **solver-relative technique tiers**, not calibrated human ratings or
claims that no alternative simpler human argument exists. All nine published
Hard boards use a pair; none requires a triple in its canonical trace. Triple
logic has a separate deterministic, nonunique test fixture, which is deliberately
not admitted to the bank. Boards that stall at every tier are rejected.

Trace steps are strict discriminated records:

| `technique` | Witness fields, in addition to `eliminated` |
| --- | --- |
| `single` | `house`, `cell` |
| `confinement` | `source`, `target` |
| `adjacency` | `source` |
| `pair`, `triple` | `sources`, `targets` (two or three houses respectively) |

`eliminated` lists **all** currently justified eliminations in ascending order.
For a single it excludes the placed cell itself, which is recorded in `cell`.
`replayTrace` validates every witness and elimination against its evolving
candidate state; it does not merely compare the final answer. Incomplete traces,
extra steps, unsupported techniques, stale houses and forged eliminations fail.
The bank validator also requires the versioned solver's exact canonical trace.

Exact uniqueness checking is a separate row-by-row backtracking search. A
reported count of zero or one is exhaustive; two means **at least two**, not
an exact total. Its default budget is 1,000,000 nodes per board.
`SearchLimitError` means uniqueness is unknown, never unique. Generation fails
rather than interpreting a budget-exhausted search as evidence.

## Reproduce and check

Run from the repository root with its existing installed dependencies. No
package manifest changes, new dependencies or global tools are needed.

### Generate your own quantity

```powershell
# Generate exactly 100 size-7 puzzles, each automatically categorized.
node scripts\region-puzzles.mjs --count 100 --size 7 --seed 42 --output .\my-region-puzzles.json

# Generate only puzzles whose verified difficulty is Hard.
node scripts\region-puzzles.mjs --count 10 --size 7 --difficulty hard --seed 42 --max-attempts 100000 --output .\hard-region-puzzles.json

# Verify connectivity, uniqueness, grades, proofs AND reproduce the saved recipe.
node scripts\region-puzzles.mjs --check --output .\my-region-puzzles.json

# Show all CLI options.
node scripts\region-puzzles.mjs --help
```

| Option | Meaning |
| --- | --- |
| `--count N` | Required for custom generation; exact positive total, not a per-tier count |
| `--size N` | Required with `--count`; one board size from 5 through 9 |
| `--output FILE.json` | Required with `--count`; output file, with missing parent directories created |
| `--difficulty any\|easy\|medium\|hard` | Defaults to `any`: accept and categorize any verified tier; a specific tier filters candidates without changing their grade |
| `--seed N` | Reproducible uint32 seed in decimal or `0x` hexadecimal; defaults to `0x72656700 + size` |
| `--max-attempts N` | Defaults to `max(5000, count * 1000)`, capped at 4,294,967,295; explicit positive budget override |
| `--check --output FILE.json` | Read-only validation and byte-for-byte regeneration using the file's saved recipe; omit generation options |

There is no longer a 20-per-tier or 60-total bank limit. Choose the count you
need; the tool either produces **exactly** that many verified, symmetry-distinct
puzzles or exits unsuccessfully with achieved counts, rejections and a suggested
next action. `any` does not promise a balanced mix or even a puzzle in every tier.
Hard puzzles are rarer and may need a larger attempt budget. To target counts
in different tiers, run separate commands with `--difficulty`, or use
`generateBank` with explicit per-tier quotas from JavaScript.

Every output puzzle has `difficulty`, `solution` and a replayable logical `trace`.
Puzzles are sorted by difficulty then attempt, and the CLI prints counts by
category, seed, last accepted attempt and output path. Progress goes to stderr
at the start, every 1,000 attempts and the end; it is not part of the JSON.
The exact **achieved** tier counts are stored as `recipe.quotas`. Because the
collector accepts the first eligible distinct candidates, these resolved quotas
reproduce the same bank with the existing `generateBank(recipe)` API. There is
no new record format, grading algorithm or puzzle identity scheme.

Custom output must be outside `src\data\region-puzzles` to protect the published
bank. An existing custom output file is replaced only after the entire requested
bank succeeds and validates. A generation shortfall leaves it untouched; no
partial bank is written. Custom checks never write or repair the file.
Generation replaces rather than appends, and custom files are not automatically
imported by the app. Reusing size and seed reproduces/overlaps the same candidate
stream; use different seeds for different runs, but note that deduplication is
within each bank, not a guarantee of uniqueness across separately generated files.

"Arbitrary count" means user-selected, not infinite: supported sizes have finite
sets of distinct puzzles, and requested counts must fit the attempt budget.
Counts/budgets are bounded by the uint32 attempt stream (1 through
4,294,967,295); going further would repeat seeds. Runtime and available memory
also limit practical batches: this tool validates and serializes a whole bank
in memory, not as a resumable stream. Increase `--max-attempts`, change the seed
or reduce/filter the request if its budget cannot be met. These operational
limits never relax uniqueness or no-guess difficulty requirements.

### Published bank and development checks

```powershell
# Regenerate all five shards.
node scripts\region-puzzles.mjs

# Regenerate just one size.
node scripts\region-puzzles.mjs --size 5

# Read-only semantic validation plus byte-for-byte deterministic regeneration.
node scripts\region-puzzles.mjs --check
node scripts\region-puzzles.mjs --size 9 --check

# Existing Vitest runner, scoped to this feature.
npm test -- scripts\region-puzzles.test.ts

# Scoped type checking, including the JavaScript modules and consumer.
.\node_modules\.bin\tsc --noEmit --allowJs --checkJs --strict --skipLibCheck --resolveJsonModule --target ES2020 --module ESNext --moduleResolution Bundler src\core\games\regions\types.ts src\data\region-puzzles\index.ts scripts\region-puzzles.mjs scripts\region-puzzles.test.ts
```

Published-bank generation is a few seconds on the authoring machine; custom
runtime depends on count, size and difficulty. Deterministic **attempt and node
budgets**, not wall-clock timing, govern the work. The CLI rejects invalid,
unknown, duplicate and conflicting arguments. `--check` writes nothing.
Generation completes and validates every requested shard in memory before
writing any; each output file is then replaced via a temporary file and rename.
Temporary files are cleaned up on write/rename errors. File replacement is
atomic per shard, not a multi-file filesystem transaction.

`scripts/region-puzzles-generator.mjs` contains the published recipes and the
`generateCandidate(size, seed, attempt)`, `generateBank(recipe)` and
`generatePuzzles({ size, count, seed?, difficulty?, maxAttempts? })` APIs.
The bank APIs also accept an optional second `{ onProgress }` argument; omit it
for pure, silent generation. Recipes retain exact per-tier quotas, including
zeros for excluded tiers. The original published recipes and all five JSON
shards remain byte-identical.
Candidates start with a seeded, non-touching column permutation. Regions grow
from those markers by attaching orthogonal frontier cells with uneven seeded
growth rates, then receive canonical labels. Growth preserves connectivity and
at least one solution; it does **not** promise uniqueness. Exact counting and
logical grading filter the result after growth, and symmetry keys filter repeats.

The integer-operation Mulberry32 PRNG has no clock or `Math.random` dependency.
Each attempt derives an independent seed from size, base seed and attempt.
Canonical traversal, inference order, output order and JSON serialization are
fixed. Changes to the algorithm, published recipes or tie-breaking require a
generator-version change; grading/proof changes require a solver-version change.
Selecting a new custom size, seed, quota or count uses the existing generator.
Regenerate all affected shards and review changed identities before persisting
player progress against a new bank. Do not silently reuse an ID for changed
puzzle content.

The scoped suite independently enumerates complete column permutations to
confirm all 29 published solutions, checks deduction soundness on multi-solution
fixtures, exercises all five techniques, corrupts proofs/schema/grades/provenance,
checks exhausted budgets, and reproduces every shard byte-for-byte. It also
generates banks above the former count limits, exercises real CLI generation
and read-only custom checks, verifies difficulty filtering, protects existing
outputs on shortfalls and checks temporary-file cleanup on write errors.

## Provenance, licensing and boundaries

The bank and tooling were authored for this repository from the game rules and
general solution-first growth / constraint-solving techniques. No commercial
puzzles were scraped, and no cat illustrations or other assets were copied.
No third-party source was vendored and no new package dependency was added;
existing Zod and Vitest dependencies keep their existing license obligations.
This document does not assign a separate license to the repository's new work.

The suggested reference
`https://github.com/daniel-jones-dev/queens-puzzle` was queried via GitHub's
repository, commits and tree APIs on 2026-09-26; all returned HTTP 404. Its source,
license and maintenance state could therefore **not** be verified. This
implementation neither incorporates it nor relies on the earlier reported MIT
license or human-rating claims.

Remaining limits: modest bank size, coarse solver-relative difficulty, asymmetric
growth shapes and occasional singleton regions, no calibrated solve-time model,
no UI/hint adaptation, no artwork and no persistence. A future game consumer
should provide accessible region styling and a suitable marker of its own.
