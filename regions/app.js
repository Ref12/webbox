import { validateBank } from './lib/validate.mjs'
import { EMPTY, CROSS, MARK, findViolations, isSolved, peers, hint as getHint } from './lib/play.mjs'

const $ = (id) => document.getElementById(id)
const HUES = [350, 28, 52, 96, 160, 190, 216, 268, 308]
const SHAPES = [
  '<circle cx="5" cy="5" r="3.6"/>', '<rect x="1.6" y="1.6" width="6.8" height="6.8"/>', '<polygon points="5,1.2 9,8.6 1,8.6"/>',
  '<polygon points="5,0.8 9.2,5 5,9.2 0.8,5"/>', '<polygon points="5,0.8 6.2,3.8 9.4,3.9 6.9,5.9 7.8,9 5,7.2 2.2,9 3.1,5.9 0.6,3.9 3.8,3.8"/>',
  '<polygon points="3.6,1 6.4,1 6.4,3.6 9,3.6 9,6.4 6.4,6.4 6.4,9 3.6,9 3.6,6.4 1,6.4 1,3.6 3.6,3.6"/>', '<polygon points="2.8,1.4 7.2,1.4 9.4,5 7.2,8.6 2.8,8.6 0.6,5"/>',
  '<polygon points="5,0.8 9.2,3.9 7.6,8.8 2.4,8.8 0.8,3.9"/>', '<circle class="ring" cx="5" cy="5" r="3.3"/>',
].map((s) => '<svg viewBox="0 0 10 10" aria-hidden="true">' + s + '</svg>')
const CHARS = [...'我你他好是的不人学生老师']   // HSK 1; presentation only

const banks = {}          // size -> bank
let all = []              // every puzzle
let puzzle = null, board = null, state = [], history = [], cursor = 0
let started = 0, elapsed = 0, timerId = 0, won = false, hintCell = -1
const opt = JSON.parse(localStorage.getItem('regions-opts') || '{}')
for (const k of ['auto', 'paint', 'challenge']) $(k).checked = !!opt[k]
$('glyphs').value = opt.glyphs || 'shapes'
const saveOpts = () => localStorage.setItem('regions-opts', JSON.stringify({ auto: $('auto').checked, paint: $('paint').checked, challenge: $('challenge').checked, glyphs: $('glyphs').value }))

async function loadBanks() {
  const sizes = [5, 6, 7, 8, 9]
  const got = await Promise.all(sizes.map((n) => fetch('boards/' + n + '.json').then((r) => r.json())))
  sizes.forEach((n, i) => { banks[n] = got[i]; all.push(...got[i].puzzles) })
  for (const n of sizes) { const o = document.createElement('option'); o.value = n; o.textContent = n + '\u00d7' + n; $('size').append(o) }
}
const list = () => all.filter((p) => p.size === +$('size').value && p.difficulty === $('diff').value)

function open(p, push = true) {
  puzzle = p; board = { size: p.size, regions: p.regions }
  state = new Array(p.size * p.size).fill(EMPTY); history = []; cursor = 0; won = false; hintCell = -1
  clearInterval(timerId); started = 0; elapsed = 0; showTime()
  $('size').value = p.size; $('diff').value = p.difficulty
  $('boardId').textContent = p.id.replace('regions-v1-', '#')
  if (push && location.hash.slice(1) !== p.id) history_replace(p.id)
  $('msg').textContent = ''
  build(); render()
}
const history_replace = (id) => { location.hash = id }

function build() {
  const g = $('grid'), n = board.size
  g.style.setProperty('--n', n); g.innerHTML = ''
  g.setAttribute('aria-rowcount', n)
  for (let i = 0; i < n * n; i++) {
    const c = document.createElement('div'), reg = board.regions[i]
    c.className = 'cell'; c.dataset.i = i; c.setAttribute('role', 'gridcell')
    c.style.setProperty('--h', HUES[reg % 9]); c.style.setProperty('--k', reg)
    const r = Math.floor(i / n), col = i % n
    if (col < n - 1 && board.regions[i + 1] !== reg) c.classList.add('rt')
    if (r < n - 1 && board.regions[i + n] !== reg) c.classList.add('rb')
    g.append(c)
  }
}

function render() {
  const g = $('grid'), ch = $('challenge').checked, chars = $('glyphs').value === 'chars'
  g.classList.toggle('ch', ch)
  const bad = findViolations(board, state)
  g.querySelectorAll('.cell').forEach((c, i) => {
    const v = state[i]
    let h = ''
    if (ch) h += '<span class="glyph">' + (chars ? CHARS[board.regions[i]] : SHAPES[board.regions[i] % 9]) + '</span>'
    if (v === CROSS) h += '<span class="x"></span>'
    if (v === MARK) h += '<span class="mk"></span>'
    if (c._h !== h) { c.innerHTML = h; c._h = h }
    c.classList.toggle('bad', bad.has(i))
    c.classList.toggle('cursor', i === cursor && document.activeElement === g)
    c.classList.toggle('hint', i === hintCell)
    c.setAttribute('aria-label', 'row ' + (Math.floor(i / board.size) + 1) + ' column ' + (i % board.size + 1) + ', region ' + (board.regions[i] + 1) + (v === MARK ? ', marker' : v === CROSS ? ', cross' : ''))
  })
  $('undo').disabled = !history.length
  const left = board.size - state.filter((v) => v === MARK).length
  if (!won && !$('msg').dataset.keep) $('msg').textContent = bad.size ? 'Rule broken: red cells conflict.' : left + ' marker' + (left === 1 ? '' : 's') + ' to place'
}

const fmt = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
const showTime = () => { $('timer').textContent = fmt(Math.floor(elapsed / 1000)) }
function startTimer() {
  if (started || won) return
  started = Date.now() - elapsed
  timerId = setInterval(() => { elapsed = Date.now() - started; showTime() }, 250)
}

function push() { history.push(state.slice()) }
function apply(fn) {          // one undoable action
  if (won) return
  startTimer(); push(); fn()
  hintCell = -1; delete $('msg').dataset.keep
  if (isSolved(board, state)) win()
  render()
}
function cycle(i) {
  apply(() => {
    const v = state[i]
    if (v === EMPTY) state[i] = CROSS
    else if (v === CROSS) { state[i] = MARK; if ($('auto').checked) for (const p of peers(board, i)) if (state[p] === EMPTY) state[p] = CROSS }
    else state[i] = EMPTY
  })
}
function undo() { if (history.length && !won) { state = history.pop(); hintCell = -1; render() } }
function reset() { if (!history.length && state.every((v) => !v)) return; won = false; push(); state.fill(EMPTY); hintCell = -1; render() }
function win() {
  won = true; clearInterval(timerId); elapsed = Date.now() - started; showTime()
  $('msg').textContent = 'Solved in ' + fmt(Math.floor(elapsed / 1000)) + '!'
  $('winText').textContent = board.size + '\u00d7' + board.size + ' ' + puzzle.difficulty + ' solved in ' + fmt(Math.floor(elapsed / 1000)) + '.'
  setTimeout(() => $('win').showModal(), 350)
}

// pointer: tap cycles; long-press (or the Drag-x toggle) then drag paints crosses
const grid = $('grid')
let drag = null
const cellAt = (x, y) => { const e = document.elementFromPoint(x, y); const c = e && e.closest && e.closest('.cell'); return c && grid.contains(c) ? +c.dataset.i : -1 }
grid.addEventListener('pointerdown', (e) => {
  const i = cellAt(e.clientX, e.clientY); if (i < 0) return
  e.preventDefault(); grid.focus({ preventScroll: true }); cursor = i
  drag = { start: i, painting: false, painted: false, val: state[i] === CROSS ? EMPTY : CROSS, x: e.clientX, y: e.clientY, snap: false }
  if ($('paint').checked) drag.painting = true
  else drag.timer = setTimeout(() => { if (drag) { drag.painting = true; navigator.vibrate && navigator.vibrate(15); paint(drag.start) } }, 380)
  try { grid.setPointerCapture(e.pointerId) } catch {}
})
function paint(i) {
  if (won || !drag) return
  const from = drag.val === CROSS ? EMPTY : CROSS
  if (state[i] !== from) return
  if (!drag.snap) { startTimer(); push(); drag.snap = true }
  state[i] = drag.val; drag.painted = true; hintCell = -1; render()
}
grid.addEventListener('pointermove', (e) => {
  if (!drag) return
  const i = cellAt(e.clientX, e.clientY)
  if (!drag.painting && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 10) clearTimeout(drag.timer)
  if (drag.painting && i >= 0) { if (!drag.painted && i === drag.start) return; paint(drag.start); paint(i); cursor = i }
})
const end = (e) => {
  if (!drag) return
  clearTimeout(drag.timer)
  const d = drag; drag = null
  if (e.type === 'pointerup' && !d.painted && !d.painting) { const i = cellAt(e.clientX, e.clientY); if (i === d.start) cycle(i) }
  else if (e.type === 'pointerup' && !d.painted && d.painting && cellAt(e.clientX, e.clientY) === d.start) cycle(d.start)
  if (d.painted && isSolved(board, state)) win()
  render()
}
grid.addEventListener('pointerup', end); grid.addEventListener('pointercancel', end)
grid.addEventListener('contextmenu', (e) => e.preventDefault())
grid.addEventListener('blur', render); grid.addEventListener('focus', render)

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return
  if (e.target.matches && e.target.matches('select, input')) return
  const n = board.size, r = Math.floor(cursor / n), c = cursor % n
  const k = e.key
  if (k === 'ArrowLeft') cursor = r * n + Math.max(0, c - 1)
  else if (k === 'ArrowRight') cursor = r * n + Math.min(n - 1, c + 1)
  else if (k === 'ArrowUp') cursor = Math.max(0, r - 1) * n + c
  else if (k === 'ArrowDown') cursor = Math.min(n - 1, r + 1) * n + c
  else if (k === ' ' || k === 'x' || k === 'X') cycle(cursor)
  else if (k === 'u' || k === 'U') undo()
  else if (k === 'h' || k === 'H') doHint()
  else if (k === 'n' || k === 'N') nextBoard()
  else return
  e.preventDefault(); if (document.activeElement !== grid && k.startsWith('Arrow')) grid.focus({ preventScroll: true }); render()
})

function doHint() {
  if (won) return
  const h = getHint(board, state)
  const msg = $('msg')
  if (h.kind === 'error') { msg.textContent = h.why + ' Undo or clear the red cells.'; msg.dataset.keep = 1; hintCell = h.cells[0]; cursor = hintCell; render() }
  else if (h.kind === 'place') {
    cursor = h.cell
    apply(() => { state[h.cell] = MARK; if ($('auto').checked) for (const p of peers(board, h.cell)) if (state[p] === EMPTY) state[p] = CROSS })
    hintCell = h.cell; msg.textContent = 'Hint: ' + h.why; msg.dataset.keep = 1; render()
  } else msg.textContent = 'Nothing left to hint.'
}

function nextBoard() { const l = list(); const k = l.findIndex((p) => p.id === puzzle.id); open(l[(k + 1) % l.length]) }
function randomBoard() {
  const l = list(), o = l.filter((p) => p.id !== puzzle.id)
  open((o.length ? o : l)[Math.floor(Math.random() * (o.length || l.length))])
}
function fromSelects() { const l = list(); open(l[0]) }

$('size').onchange = $('diff').onchange = fromSelects
$('next').onclick = nextBoard; $('random').onclick = randomBoard
$('undo').onclick = undo; $('reset').onclick = reset; $('hint').onclick = doHint
$('auto').onchange = $('paint').onchange = $('glyphs').onchange = $('challenge').onchange = () => { saveOpts(); render() }
$('help').onclick = () => $('rules').showModal(); $('rulesClose').onclick = () => $('rules').close()
$('winNext').onclick = () => { $('win').close(); nextBoard() }; $('winClose').onclick = () => $('win').close()
window.addEventListener('hashchange', () => { const p = all.find((x) => x.id === location.hash.slice(1)); if (p && (!puzzle || p.id !== puzzle.id)) open(p, false) })

await loadBanks()
open(all.find((x) => x.id === location.hash.slice(1)) || all.find((p) => p.size === 7 && p.difficulty === 'easy'))
setTimeout(() => {
  let count = 0
  for (const n of Object.keys(banks)) { validateBank(banks[n]); count += banks[n].puzzles.length }
  console.log('regions: validator accepted the bank, ' + count + ' boards')
}, 0)
