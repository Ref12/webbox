// @ts-check
import { boardSchema } from './schema.mjs'

/** @typedef {import('./types').RegionBoard} Board */
/** @typedef {import('./types').RegionHouse} House */

/** @param {number} cell @param {number} size */
export function neighbors(cell, size) {
  const row = Math.floor(cell / size)
  const column = cell % size
  return [
    ...(row > 0 ? [cell - size] : []),
    ...(column > 0 ? [cell - 1] : []),
    ...(column < size - 1 ? [cell + 1] : []),
    ...(row < size - 1 ? [cell + size] : []),
  ]
}

/** Validates shape, exhaustive region labels and orthogonal connectivity.
 * @param {unknown} input @returns {Board} */
export function validateBoard(input) {
  const board = boardSchema.parse(input)
  for (let region = 0; region < board.size; region++) {
    const start = board.regions.indexOf(region)
    if (start < 0) throw new Error(`Missing region ${region}`)
    const visited = new Set([start])
    const queue = [start]
    for (let offset = 0; offset < queue.length; offset++) {
      for (const next of neighbors(queue[offset], board.size)) {
        if (board.regions[next] === region && !visited.has(next)) {
          visited.add(next)
          queue.push(next)
        }
      }
    }
    if (visited.size !== board.regions.filter(value => value === region).length) {
      throw new Error(`Disconnected region ${region}`)
    }
  }
  return board
}

/** Chess long diagonals deliberately do not appear here.
 * @param {Board} board @param {number} a @param {number} b */
export function conflicts(board, a, b) {
  const rowA = Math.floor(a / board.size)
  const rowB = Math.floor(b / board.size)
  const columnA = a % board.size
  const columnB = b % board.size
  return rowA === rowB || columnA === columnB ||
    board.regions[a] === board.regions[b] ||
    (Math.abs(rowA - rowB) <= 1 && Math.abs(columnA - columnB) <= 1)
}

/** @param {Board} board @param {unknown} input @returns {number[]} */
export function validateSolution(board, input) {
  validateBoard(board)
  if (!Array.isArray(input) || input.length !== board.size ||
      input.some(column => !Number.isInteger(column) || column < 0 || column >= board.size)) {
    throw new Error('Solution must contain one valid column index per row')
  }
  const cells = input.map((column, row) => row * board.size + column)
  for (let a = 0; a < cells.length; a++) {
    for (let b = a + 1; b < cells.length; b++) {
      if (conflicts(board, cells[a], cells[b])) throw new Error('Solution has conflicting markers')
    }
  }
  return input
}

/** @param {Board} board @param {number} cell @param {House['kind']} kind */
export function houseIndex(board, cell, kind) {
  if (kind === 'row') return Math.floor(cell / board.size)
  if (kind === 'column') return cell % board.size
  return board.regions[cell]
}

/** @param {Board} board @param {House} house @param {number} cell */
export function inHouse(board, house, cell) {
  return houseIndex(board, cell, house.kind) === house.index
}

/** @param {Board} board @returns {House[]} */
export function houses(board) {
  return /** @type {const} */ (['row', 'column', 'region']).flatMap(kind =>
    Array.from({ length: board.size }, (_, index) => ({ kind, index })))
}

export class SearchLimitError extends Error {
  /** @param {number} maxNodes */
  constructor(maxNodes) {
    super(`Exact search exceeded ${maxNodes} nodes; uniqueness is unknown`)
    this.name = 'SearchLimitError'
  }
}

/** Exact capped count: 0/1 means exhaustive; 2 means at least two solutions.
 * Exceeding the budget throws rather than certifying a partial search.
 * @param {Board} input @param {{maxNodes?: number}} options */
export function countSolutions(input, { maxNodes = 1000000 } = {}) {
  const board = validateBoard(input)
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 10000000) {
    throw new Error('maxNodes must be an integer from 1 to 10000000')
  }
  let nodes = 0
  let count = 0
  /** @type {number[] | null} */
  let solution = null
  /** @type {number[]} */
  const columns = []
  /** @param {number} row @param {number} usedColumns @param {number} usedRegions */
  function search(row, usedColumns, usedRegions) {
    if (++nodes > maxNodes) throw new SearchLimitError(maxNodes)
    if (row === board.size) {
      count++
      solution ??= [...columns]
      return
    }
    for (let column = 0; column < board.size && count < 2; column++) {
      const region = board.regions[row * board.size + column]
      if ((usedColumns & (1 << column)) || (usedRegions & (1 << region)) ||
          (row > 0 && Math.abs(columns[row - 1] - column) <= 1)) continue
      columns.push(column)
      search(row + 1, usedColumns | (1 << column), usedRegions | (1 << region))
      columns.pop()
    }
  }
  search(0, 0, 0)
  return { count, solution, nodes, exhaustive: count < 2 }
}

/** Region labels are colors, not identities. Canonicalize across all eight
 * square symmetries as well, to prevent rotated/recolored bank duplicates.
 * @param {Board} board */
export function canonicalBoardKey(board) {
  validateBoard(board)
  /** @type {string[]} */
  const keys = []
  for (let reflect = 0; reflect < 2; reflect++) {
    for (let rotate = 0; rotate < 4; rotate++) {
      const transformed = new Array(board.size * board.size)
      for (let cell = 0; cell < transformed.length; cell++) {
        let row = Math.floor(cell / board.size)
        let column = cell % board.size
        if (reflect) column = board.size - 1 - column
        for (let turn = 0; turn < rotate; turn++) [row, column] = [column, board.size - 1 - row]
        transformed[row * board.size + column] = board.regions[cell]
      }
      /** @type {Map<number, number>} */
      const labels = new Map()
      keys.push(transformed.map(region => {
        if (!labels.has(region)) labels.set(region, labels.size)
        return labels.get(region)
      }).join(','))
    }
  }
  return `${board.size}:${keys.sort()[0]}`
}
