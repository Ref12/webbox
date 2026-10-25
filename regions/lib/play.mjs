// Play-state helpers for the UI (not part of the bank): live violations, win check, auto-X and hints.
// state: array of size*size numbers, 0 empty, 1 = X (excluded), 2 = marker.
import { conflicts } from './rules.mjs'
import { solveLogically } from './logic.mjs'

export const EMPTY = 0, CROSS = 1, MARK = 2

export function markerCells(state) {
  const out = []
  for (let i = 0; i < state.length; i++) if (state[i] === MARK) out.push(i)
  return out
}

/** Cells holding a marker that breaks a rule -> Set of reasons ('row' | 'column' | 'region' | 'touch'). */
export function findViolations(board, state) {
  const n = board.size, out = new Map()
  const add = (c, why) => { if (!out.has(c)) out.set(c, new Set()); out.get(c).add(why) }
  const m = markerCells(state)
  for (let i = 0; i < m.length; i++) {
    for (let j = i + 1; j < m.length; j++) {
      const a = m[i], b = m[j]
      const ra = Math.floor(a / n), rb = Math.floor(b / n), ca = a % n, cb = b % n
      const why = []
      if (ra === rb) why.push('row')
      if (ca === cb) why.push('column')
      if (board.regions[a] === board.regions[b]) why.push('region')
      if (Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1) why.push('touch')
      for (const w of why) { add(a, w); add(b, w) }
    }
  }
  return out
}

/** Exactly one marker per row, column and region, nothing breaking a rule. */
export function isSolved(board, state) {
  const m = markerCells(state)
  if (m.length !== board.size) return false
  if (findViolations(board, state).size) return false
  return true // n markers with no shared row/column/region: one in each
}

/** Cells that a marker at `cell` rules out: its row, column, region and the 8 neighbours (the cell itself excluded). */
export function peers(board, cell) {
  const out = []
  for (let c = 0; c < board.size * board.size; c++) if (c !== cell && conflicts(board, cell, c)) out.push(c)
  return out
}

const nameOf = (h) => h.kind === 'region' ? 'region ' + (h.index + 1) : h.kind + ' ' + (h.index + 1)
const TECH = {
  confinement: 'a row/column/region whose options all lie inside another one',
  adjacency: 'a cell that touches every remaining option of a house',
  pair: 'two houses sharing exactly two others',
  triple: 'three houses sharing exactly three others',
}

/**
 * One forced cell, from the solver's no-guess deduction (solveLogically on the empty board; a bank board always finishes).
 * Returns { kind: 'error', cells } when the player has markers that cannot be right (they are not in the proof's solution),
 * { kind: 'done' } when solved, else { kind: 'place', cell, why } with the next forced marker the player has not placed.
 */
export function hint(board, state) {
  const res = solveLogically(board, 'hard')
  if (res.status !== 'solved') return { kind: 'none' }
  const n = board.size
  const sol = new Set(res.solution.map((c, r) => r * n + c))
  const wrong = markerCells(state).filter((c) => !sol.has(c))
  if (wrong.length) return { kind: 'error', cells: wrong, why: 'These markers are not part of the solution.' }
  let lastTech = null
  for (const step of res.trace) {
    if (step.technique !== 'single') { lastTech = step.technique; continue }
    if (state[step.cell] === MARK) { lastTech = null; continue }
    const where = nameOf(step.house)
    const why = 'The only place left in ' + where + '.' + (lastTech ? ' (Found with ' + TECH[lastTech] + '.)' : '')
    return { kind: 'place', cell: step.cell, why }
  }
  return { kind: 'done' }
}
