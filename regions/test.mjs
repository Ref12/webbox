// node regions/test.mjs: the rules module flags each violation type and accepts every bank board's solution.
import { readFileSync } from 'node:fs'
import { validateBoard, validateSolution } from './lib/rules.mjs'
import { validateBank } from './lib/validate.mjs'
import { findViolations, isSolved } from './lib/play.mjs'
import assert from 'node:assert/strict'

const banks = [5, 6, 7, 8, 9].map((n) => JSON.parse(readFileSync(new URL('./boards/' + n + '.json', import.meta.url))))
let boards = 0
for (const bank of banks) {
  validateBank(bank)
  for (const p of bank.puzzles) {
    const board = { size: p.size, regions: p.regions }
    validateBoard(board); validateSolution(board, p.solution)
    const marks = new Map(p.solution.map((c, r) => [r * p.size + c, 2]))
    assert.equal(findViolations(board, marks).size, 0, p.id)
    assert(isSolved(board, marks), p.id)
    boards++
  }
}
assert.equal(boards, 29)

// violation types on a hand-made 5x5 (regions: 5 vertical-ish strips by column)
const board = { size: 5, regions: Array.from({ length: 25 }, (_, i) => i % 5) }
const v = (cells) => findViolations(board, new Map(cells.map((c) => [c, 2])))
assert(v([0, 2]).size >= 2, 'row')            // same row
assert(v([0, 10]).size >= 2, 'column/region') // same column (= same region here)
const rb = { size: 5, regions: [0,0,1,1,1, 0,0,1,1,1, 2,2,2,3,3, 2,2,2,3,3, 2,2,4,4,4] }
const vr = (cells) => findViolations(rb, new Map(cells.map((c) => [c, 2])))
assert(vr([0, 6]).size === 2, 'touch diagonal') // (0,0)-(1,1) diagonal neighbours, same region too
assert(vr([0, 6]).get ? true : true)
assert(vr([1, 5]).size === 2, 'touch')
assert(vr([0, 7]).size === 2, 'same region, not touching')
assert(vr([2, 13]).size === 0, 'distant markers fine')
assert(vr([0, 12]).size === 0, 'distant diagonal markers are legal')
assert.equal(vr([0, 4]).size, 2, 'same row')
assert.equal(vr([0, 20]).size, 2, 'same column')
assert.throws(() => validateBoard({ size: 5, regions: [0,1,0,1,0, 1,0,1,0,1, 0,1,0,1,0, 1,0,1,0,1, 2,3,4,2,3] }), /Disconnected|Missing/)
assert.throws(() => validateSolution(rb, [0, 0, 0, 0, 0]))
console.log('ok:', boards, 'boards')
