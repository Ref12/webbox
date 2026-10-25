// node regions/test.mjs: the rules module flags each violation type and accepts every bank board's solution.
import { readFileSync } from 'node:fs'
import { validateBoard, validateSolution } from './lib/rules.mjs'
import { validateBank } from './lib/validate.mjs'
import { findViolations, isSolved, MARK } from './lib/play.mjs'
import assert from 'node:assert/strict'

const banks = [5, 6, 7, 8, 9].map((n) => JSON.parse(readFileSync(new URL('./boards/' + n + '.json', import.meta.url))))
let boards = 0
for (const bank of banks) {
  validateBank(bank)
  for (const p of bank.puzzles) {
    const board = { size: p.size, regions: p.regions }
    validateBoard(board); validateSolution(board, p.solution)
    const marks = new Array(p.size * p.size).fill(0); p.solution.forEach((c, r) => { marks[r * p.size + c] = MARK })
    assert.equal(findViolations(board, marks).size, 0, p.id)
    assert(isSolved(board, marks), p.id)
    boards++
  }
}
assert.equal(boards, 29)

// each violation type, on a hand-made board
const board = { size: 5, regions: [0,0,1,1,1, 0,0,1,1,1, 2,2,2,3,3, 2,2,2,3,3, 2,2,4,4,4] }
const st = (...cells) => { const s = new Array(25).fill(0); for (const c of cells) s[c] = MARK; return s }
const why = (...cells) => { const m = findViolations(board, st(...cells)); return [...new Set([...m.values()].flatMap((x) => [...x]))].sort().join() }
assert.equal(why(0, 4), 'row', 'row')   // (0,0) and (0,4)
assert.equal(why(0, 20), 'column', 'column')              // (0,0) and (4,0): same column, regions 0 and 2
assert.equal(why(2, 7), 'column,region,touch', 'column+region+touch') // (0,2),(1,2)
assert.equal(why(0, 6), 'region,touch', 'diagonal touch, same region')
assert.equal(why(4, 10), '', 'unrelated markers')
assert.equal(why(1, 7), 'touch', 'diagonal touch, different regions') // (0,1),(1,2)
assert.equal(why(0, 12), '', 'distant markers on one diagonal are legal')
assert.equal(why(0, 1), 'region,row,touch', 'row+region+touch')
assert(!isSolved(board, st(0, 7)), 'partial board is not solved')
assert.throws(() => validateBoard({ size: 5, regions: [0,1,0,1,0, 1,0,1,0,1, 0,1,0,1,0, 1,0,1,0,1, 2,3,4,2,3] }), /Disconnected|Missing/)
assert.throws(() => validateSolution(board, [0, 0, 0, 0, 0]))
assert.throws(() => validateSolution(board, [0, 2, 4, 1]))
console.log('ok:', boards, 'boards')
