// @ts-check
import { DIFFICULTIES, difficultySchema, stepSchema } from './schema.mjs'
import { conflicts, houseIndex, houses, inHouse, validateBoard, validateSolution } from './rules.mjs'

/** @typedef {import('./types').RegionBoard} Board */
/** @typedef {import('./types').RegionHouse} House */
/** @typedef {import('./types').RegionStep} Step */
/** @typedef {import('./types').RegionDifficulty} Difficulty */
/** @typedef {{board: Board, candidates: Set<number>, placed: number[], allHouses: House[]}} State */

const KINDS = /** @type {const} */ (['row', 'column', 'region'])

/** @param {Board} board @returns {State} */
function initialState(board) {
  return {
    board,
    candidates: new Set(Array.from({ length: board.size * board.size }, (_, cell) => cell)),
    placed: [],
    allHouses: houses(board),
  }
}

/** @param {State} state @param {House} house */
function options(state, house) {
  return [...state.candidates].filter(cell => inHouse(state.board, house, cell))
}

/** @param {State} state @param {House} house */
function filled(state, house) {
  return state.placed.some(cell => inHouse(state.board, house, cell))
}

/** @param {State} state */
function activeHouses(state) {
  return state.allHouses.filter(house => !filled(state, house))
}

/** @param {number[]} a @param {number[]} b */
function sameNumbers(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** @param {Board} board @param {number} a @param {number} b */
function touches(board, a, b) {
  return Math.abs(Math.floor(a / board.size) - Math.floor(b / board.size)) <= 1 &&
    Math.abs(a % board.size - b % board.size) <= 1
}

/** @template T @param {T[]} items @param {number} count @returns {T[][]} */
function combinations(items, count) {
  /** @type {T[][]} */
  const result = []
  /** @param {number} start @param {T[]} prefix */
  function visit(start, prefix) {
    if (prefix.length === count) {
      result.push(prefix)
      return
    }
    for (let index = start; index <= items.length - count + prefix.length; index++) {
      visit(index + 1, [...prefix, items[index]])
    }
  }
  visit(0, [])
  return result
}

/** @param {State} state @param {House[]} sources @param {House[]} targets */
function setEliminations(state, sources, targets) {
  return [...state.candidates].filter(cell =>
    targets.some(target => inHouse(state.board, target, cell)) &&
    !sources.some(source => inHouse(state.board, source, cell)))
}

/** @param {State} state @param {Difficulty} difficulty @returns {Step | null} */
function nextStep(state, difficulty) {
  const active = activeHouses(state)
  const candidates = [...state.candidates]
  const groups = active.map(house => ({ house, cells: options(state, house) }))
  for (const { house, cells } of groups) {
    if (cells.length === 1) {
      const cell = cells[0]
      return {
        technique: 'single', house, cell,
        eliminated: candidates.filter(other => other !== cell && conflicts(state.board, cell, other)),
      }
    }
  }
  if (difficulty === 'easy') return null

  for (const { house: source, cells } of groups) {
    for (const target of active) {
      if (source.kind === target.kind || !cells.every(cell => inHouse(state.board, target, cell))) continue
      const eliminated = options(state, target).filter(cell => !inHouse(state.board, source, cell))
      if (eliminated.length) return { technique: 'confinement', source, target, eliminated }
    }
  }
  for (const { house: source, cells } of groups) {
    const eliminated = candidates.filter(cell => !inHouse(state.board, source, cell) &&
      cells.every(other => touches(state.board, cell, other)))
    if (eliminated.length) return { technique: 'adjacency', source, eliminated }
  }
  if (difficulty === 'medium') return null

  for (const count of [2, 3]) {
    for (const sourceKind of KINDS) {
      for (const sources of combinations(active.filter(house => house.kind === sourceKind), count)) {
        const cells = candidates.filter(cell => sources.some(source => inHouse(state.board, source, cell)))
        for (const targetKind of KINDS) {
          if (sourceKind === targetKind) continue
          const indices = [...new Set(cells.map(cell => houseIndex(state.board, cell, targetKind)))]
            .sort((a, b) => a - b)
          if (indices.length !== count) continue
          const targets = indices.map(index => ({ kind: targetKind, index }))
          const eliminated = setEliminations(state, sources, targets)
          if (eliminated.length) return {
            technique: count === 2 ? 'pair' : 'triple', sources, targets, eliminated,
          }
        }
      }
    }
  }
  return null
}

/** @param {State} state @param {Step} step */
function applyStep(state, step) {
  if (step.technique === 'single') {
    state.placed.push(step.cell)
    state.candidates.delete(step.cell)
  }
  for (const cell of step.eliminated) state.candidates.delete(cell)
}

/** @param {State} state */
function contradiction(state) {
  return activeHouses(state).some(house => options(state, house).length === 0)
}

/** Does not read a stored solution or call the exact solver. Each iteration
 * removes at least one candidate, bounding the trace by size squared steps.
 * @param {Board} input @param {Difficulty} difficulty */
export function solveLogically(input, difficulty = 'hard') {
  const board = validateBoard(input)
  difficultySchema.parse(difficulty)
  const state = initialState(board)
  /** @type {Step[]} */
  const trace = []
  while (!contradiction(state) && state.placed.length < board.size) {
    const step = nextStep(state, difficulty)
    if (!step) break
    applyStep(state, step)
    trace.push(step)
  }
  const solved = state.placed.length === board.size
  const solution = solved
    ? state.placed.sort((a, b) => a - b).map(cell => cell % board.size)
    : null
  if (solution) validateSolution(board, solution)
  return {
    status: /** @type {'solved' | 'stalled' | 'contradiction'} */ (
      solved ? 'solved' : contradiction(state) ? 'contradiction' : 'stalled'),
    solution,
    trace,
  }
}

/** Weakest implemented tier that finishes, not the board size or step count.
 * A stalled weaker solver is evidence relative to this solver, not a proof
 * that no human could find a different simpler argument.
 * @param {Board} board */
export function gradeBoard(board) {
  for (const difficulty of DIFFICULTIES) {
    const result = solveLogically(board, difficulty)
    if (result.status === 'solved') return { difficulty, ...result }
    if (result.status === 'contradiction') return null
  }
  return null
}

/** Check supplied witnesses against current candidates, independently of the
 * solver's choice/order of deductions. Never trust claimed eliminations.
 * @param {State} state @param {Step} step */
function verifyStep(state, step) {
  const board = state.board
  /** @param {House} house */
  function requireActive(house) {
    if (house.index >= board.size || filled(state, house) || !options(state, house).length) {
      throw new Error('Trace references an invalid or filled house')
    }
  }
  /** @type {number[]} */
  let expected
  if (step.technique === 'single') {
    requireActive(step.house)
    if (!sameNumbers(options(state, step.house), [step.cell])) {
      throw new Error('Single is not forced by its house')
    }
    expected = [...state.candidates].filter(other => other !== step.cell && conflicts(board, step.cell, other))
  } else if (step.technique === 'confinement') {
    requireActive(step.source)
    requireActive(step.target)
    if (step.source.kind === step.target.kind ||
        !options(state, step.source).every(cell => inHouse(board, step.target, cell))) {
      throw new Error('Confinement witness does not confine the source')
    }
    expected = options(state, step.target).filter(cell => !inHouse(board, step.source, cell))
  } else if (step.technique === 'adjacency') {
    requireActive(step.source)
    const cells = options(state, step.source)
    expected = [...state.candidates].filter(cell => !inHouse(board, step.source, cell) &&
      cells.every(other => touches(board, cell, other)))
  } else {
    const count = step.technique === 'pair' ? 2 : 3
    for (const house of [...step.sources, ...step.targets]) requireActive(house)
    const sourceKind = step.sources[0].kind
    const targetKind = step.targets[0].kind
    if (sourceKind === targetKind ||
        step.sources.some(house => house.kind !== sourceKind) ||
        step.targets.some(house => house.kind !== targetKind) ||
        new Set(step.sources.map(house => house.index)).size !== count ||
        new Set(step.targets.map(house => house.index)).size !== count) {
      throw new Error('Set witness requires distinct houses from two different families')
    }
    const cells = [...state.candidates].filter(cell => step.sources.some(source => inHouse(board, source, cell)))
    const indices = [...new Set(cells.map(cell => houseIndex(board, cell, targetKind)))].sort((a, b) => a - b)
    if (!sameNumbers(indices, step.targets.map(house => house.index))) {
      throw new Error('Set witness does not cover exactly its target houses')
    }
    expected = setEliminations(state, step.sources, step.targets)
  }
  if (!sameNumbers(step.eliminated, expected) || (step.technique !== 'single' && !expected.length)) {
    throw new Error('Trace eliminations do not match the justified candidates')
  }
}

/** @param {Board} input @param {unknown} inputTrace @returns {number[]} */
export function replayTrace(input, inputTrace) {
  const board = validateBoard(input)
  if (!Array.isArray(inputTrace) || inputTrace.length > board.size * board.size) {
    throw new Error('Expected a bounded logical trace')
  }
  const state = initialState(board)
  for (const [index, inputStep] of inputTrace.entries()) {
    if (contradiction(state) || state.placed.length === board.size) {
      throw new Error(`Trace step ${index}: board is already finished or contradictory`)
    }
    const step = stepSchema.parse(inputStep)
    verifyStep(state, step)
    applyStep(state, step)
  }
  if (state.placed.length !== board.size) throw new Error('Trace does not finish the board')
  const solution = state.placed.sort((a, b) => a - b).map(cell => cell % board.size)
  return validateSolution(board, solution)
}
