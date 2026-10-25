// @ts-check
import { bankSchema, DIFFICULTIES, puzzleSchema } from './schema.mjs'
import { canonicalBoardKey, countSolutions, validateBoard, validateSolution } from './rules.mjs'
import { gradeBoard, replayTrace } from './logic.mjs'

/** @param {unknown} input */
export function validatePuzzle(input) {
  const puzzle = puzzleSchema.parse(input)
  const board = validateBoard({ size: puzzle.size, regions: puzzle.regions })
  if (!puzzle.id.startsWith(`regions-v1-${puzzle.size}-`) ||
      !puzzle.id.endsWith(`-${puzzle.attempt}`)) {
    throw new Error(`${puzzle.id}: ID size or attempt disagrees with the puzzle`)
  }
  validateSolution(board, puzzle.solution)
  const exact = countSolutions(board)
  if (exact.count !== 1 || !exact.exhaustive) throw new Error(`${puzzle.id}: puzzle is not uniquely solvable`)
  if (JSON.stringify(exact.solution) !== JSON.stringify(puzzle.solution)) {
    throw new Error(`${puzzle.id}: stored solution disagrees with exact search`)
  }
  const replayed = replayTrace(board, puzzle.trace)
  if (JSON.stringify(replayed) !== JSON.stringify(puzzle.solution)) {
    throw new Error(`${puzzle.id}: trace does not prove the stored solution`)
  }
  const grade = gradeBoard(board)
  if (!grade || grade.difficulty !== puzzle.difficulty) {
    throw new Error(`${puzzle.id}: difficulty is not the weakest solving tier`)
  }
  if (JSON.stringify(grade.trace) !== JSON.stringify(puzzle.trace)) {
    throw new Error(`${puzzle.id}: trace differs from the versioned deterministic solver`)
  }
  return puzzle
}

/** Full semantic validation is intentionally offline, not a rendering cost.
 * @param {unknown} input */
export function validateBank(input) {
  const bank = bankSchema.parse(input)
  const ids = new Set()
  const attempts = new Set()
  const boards = new Set()
  const counts = { easy: 0, medium: 0, hard: 0 }
  const seedHex = bank.recipe.seed.toString(16).padStart(8, '0')
  let previousTier = -1
  let previousAttempt = 0
  for (const inputPuzzle of bank.puzzles) {
    const puzzle = validatePuzzle(inputPuzzle)
    if (puzzle.size !== bank.recipe.size || puzzle.attempt > bank.recipe.maxAttempts ||
        puzzle.id !== `regions-v1-${puzzle.size}-${seedHex}-${puzzle.attempt}`) {
      throw new Error(`${puzzle.id}: puzzle provenance does not match the bank recipe`)
    }
    const tier = DIFFICULTIES.indexOf(puzzle.difficulty)
    if (tier < previousTier || (tier === previousTier && puzzle.attempt <= previousAttempt)) {
      throw new Error('Puzzles must be sorted by tier then generation attempt')
    }
    previousTier = tier
    previousAttempt = puzzle.attempt
    if (ids.has(puzzle.id) || attempts.has(puzzle.attempt)) throw new Error('Duplicate puzzle identity')
    ids.add(puzzle.id)
    attempts.add(puzzle.attempt)
    const key = canonicalBoardKey({ size: puzzle.size, regions: puzzle.regions })
    if (boards.has(key)) throw new Error('Duplicate board up to symmetry and region relabeling')
    boards.add(key)
    counts[puzzle.difficulty]++
  }
  for (const difficulty of DIFFICULTIES) {
    if (counts[difficulty] !== bank.recipe.quotas[difficulty]) {
      throw new Error(`${difficulty}: bank does not meet its exact recipe quota`)
    }
  }
  return bank
}
