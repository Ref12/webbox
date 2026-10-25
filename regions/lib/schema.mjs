// Zod-free stand-in for the bank's schema.mjs (the original uses zod; webbox has no dependencies and no build step).
// Same exports and the same strictness (unknown keys rejected), each schema has .parse(input) that returns the input or throws.
export const RULES_VERSION = 'regions-no-touch-v1'
export const GENERATOR_VERSION = 'region-growth-v1'
export const SOLVER_VERSION = 'region-logic-v1'
export const DIFFICULTIES = ['easy', 'medium', 'hard']
export const SIZE_MIN = 5
export const SIZE_MAX = 9
export const MAX_ATTEMPTS = 0xffffffff

const fail = (m) => { throw new Error('Invalid input: ' + m) }
const int = (v, lo, hi, what) => { if (!Number.isInteger(v) || v < lo || v > hi) fail(what + ' must be an integer in ' + lo + '..' + hi); return v }
const arr = (v, lo, hi, each, what) => {
  if (!Array.isArray(v) || v.length < lo || v.length > hi) fail(what + ' must be an array of ' + lo + '..' + hi + ' items')
  v.forEach(each); return v
}
const obj = (v, keys, what) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(what + ' must be an object')
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail(what + ' has unknown key ' + k)
  for (const k of keys) if (!(k in v)) fail(what + ' lacks key ' + k)
  return v
}
const mk = (parse) => ({ parse })
const idx = (v) => int(v, 0, SIZE_MAX - 1, 'index')
const cell = (v) => int(v, 0, SIZE_MAX * SIZE_MAX - 1, 'cell')
const cells = (min) => (v) => arr(v, min, SIZE_MAX * SIZE_MAX, cell, 'cells')

export const attemptSchema = mk((v) => int(v, 1, MAX_ATTEMPTS, 'attempt'))
export const seedSchema = mk((v) => int(v, 0, 0xffffffff, 'seed'))
export const sizeSchema = mk((v) => int(v, SIZE_MIN, SIZE_MAX, 'size'))
export const difficultySchema = mk((v) => { if (!DIFFICULTIES.includes(v)) fail('difficulty'); return v })
export const houseKindSchema = mk((v) => { if (!['row', 'column', 'region'].includes(v)) fail('house kind'); return v })
export const houseSchema = mk((v) => { obj(v, ['kind', 'index'], 'house'); houseKindSchema.parse(v.kind); idx(v.index); return v })
const regionsOf = (v) => arr(v, SIZE_MIN * SIZE_MIN, SIZE_MAX * SIZE_MAX, idx, 'regions')

export const boardSchema = mk((v) => {
  obj(v, ['size', 'regions'], 'board'); sizeSchema.parse(v.size); regionsOf(v.regions)
  if (v.regions.length !== v.size * v.size) fail('Expected size squared cells')
  if (v.regions.some((r) => r >= v.size)) fail('Region index exceeds board size')
  return v
})

const houses = (n) => (v) => arr(v, n, n, (h) => houseSchema.parse(h), 'houses')
export const stepSchema = mk((v) => {
  if (!v || typeof v !== 'object') fail('step')
  switch (v.technique) {
    case 'single': obj(v, ['technique', 'house', 'cell', 'eliminated'], 'step'); houseSchema.parse(v.house); cell(v.cell); cells(0)(v.eliminated); break
    case 'confinement': obj(v, ['technique', 'source', 'target', 'eliminated'], 'step'); houseSchema.parse(v.source); houseSchema.parse(v.target); cells(1)(v.eliminated); break
    case 'adjacency': obj(v, ['technique', 'source', 'eliminated'], 'step'); houseSchema.parse(v.source); cells(1)(v.eliminated); break
    case 'pair': obj(v, ['technique', 'sources', 'targets', 'eliminated'], 'step'); houses(2)(v.sources); houses(2)(v.targets); cells(1)(v.eliminated); break
    case 'triple': obj(v, ['technique', 'sources', 'targets', 'eliminated'], 'step'); houses(3)(v.sources); houses(3)(v.targets); cells(1)(v.eliminated); break
    default: fail('unknown technique')
  }
  return v
})

export const puzzleSchema = mk((v) => {
  obj(v, ['id', 'size', 'regions', 'attempt', 'difficulty', 'solution', 'trace'], 'puzzle')
  if (typeof v.id !== 'string' || !/^regions-v1-[5-9]-[0-9a-f]{8}-[1-9][0-9]*$/.test(v.id)) fail('id')
  sizeSchema.parse(v.size); regionsOf(v.regions); attemptSchema.parse(v.attempt); difficultySchema.parse(v.difficulty)
  arr(v.solution, SIZE_MIN, SIZE_MAX, idx, 'solution')
  arr(v.trace, SIZE_MIN, SIZE_MAX * SIZE_MAX, (s) => stepSchema.parse(s), 'trace')
  return v
})

export const quotasSchema = mk((v) => {
  obj(v, ['easy', 'medium', 'hard'], 'quotas')
  for (const k of DIFFICULTIES) int(v[k], 0, MAX_ATTEMPTS, k)
  if (!DIFFICULTIES.some((k) => v[k] > 0)) fail('At least one puzzle is required')
  return v
})
export const recipeSchema = mk((v) => {
  obj(v, ['size', 'seed', 'quotas', 'maxAttempts'], 'recipe')
  sizeSchema.parse(v.size); seedSchema.parse(v.seed); quotasSchema.parse(v.quotas); attemptSchema.parse(v.maxAttempts); return v
})
export const bankSchema = mk((v) => {
  obj(v, ['schemaVersion', 'rulesVersion', 'generatorVersion', 'solverVersion', 'recipe', 'puzzles'], 'bank')
  if (v.schemaVersion !== 1 || v.rulesVersion !== RULES_VERSION || v.generatorVersion !== GENERATOR_VERSION || v.solverVersion !== SOLVER_VERSION) fail('versions')
  recipeSchema.parse(v.recipe)
  arr(v.puzzles, 1, MAX_ATTEMPTS, (p) => puzzleSchema.parse(p), 'puzzles')
  return v
})
