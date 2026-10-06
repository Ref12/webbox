import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, normalizeLoadUrl, directiveSpans, handleCommand, HELP_TEXT } from '../../src/CsRepl.Wasm/wwwroot/commands.js';
import { toHtml, paint } from '../../src/CsRepl.Wasm/wwwroot/classify.js';

test('commands are recognised only as a whole one-line submission', () => {
  for (const [code, kind] of [['#help', 'help'], ['  #clear  ', 'clear'], ['clear', 'clear'], ['#reset', 'reset'], ['#help // list', 'help']])
    assert.equal(parseCommand(code)?.kind, kind, code);
  for (const code of ['clear;', 'clear()', 'var clear = 1;', '#r "System.Net.Http"', '#nullable enable', '#helpme', '#help\nvar x = 1;', '#region x', 'Console.WriteLine("#help");', '', 'Clear'])
    assert.equal(parseCommand(code), null, JSON.stringify(code));
});

test('commands that take no arguments reject them; #load needs one quoted URL', () => {
  assert.match(parseCommand('#help me').error, /takes no arguments/);
  assert.match(parseCommand('#reset now').error, /takes no arguments/);
  assert.match(parseCommand('#load').error, /quoted URL/);
  assert.match(parseCommand('#load https://x/y.csx').error, /quoted URL/);
  assert.match(parseCommand('#load "script.csx"').error, /absolute http\(s\) URL/);
  assert.match(parseCommand('#load "file:///etc/passwd"').error, /http\(s\)/);
  assert.equal(parseCommand('#load "https://example.com/a.csx"').arg, 'https://example.com/a.csx');
  assert.equal(parseCommand('#load "https://example.com/a.csx"').error, undefined);
});

test('GitHub page URLs become raw URLs', () => {
  assert.equal(normalizeLoadUrl('https://github.com/u/r/blob/main/dir/a.csx').url, 'https://raw.githubusercontent.com/u/r/main/dir/a.csx');
  assert.equal(normalizeLoadUrl('https://gist.github.com/u/0123abcd').url, 'https://gist.githubusercontent.com/u/0123abcd/raw');
  assert.equal(normalizeLoadUrl('https://raw.githubusercontent.com/u/r/main/a.csx').url, 'https://raw.githubusercontent.com/u/r/main/a.csx');
});

test('directives are classified as preprocessor directives: commands and #r lines', () => {
  const sp = parseCommand('  #help').spans;
  assert.deepEqual(sp, [{ start: 2, length: 5, type: 'preprocessor keyword' }]);
  assert.equal(toHtml('#help', directiveSpans('#help')), '<span class="t-preproc">#help</span>');
  assert.equal(toHtml('clear', directiveSpans('clear')), '<span class="t-preproc">clear</span>');
  assert.equal(toHtml('#load "https://a/b"', directiveSpans('#load "https://a/b"')), '<span class="t-preproc">#load</span> <span class="t-string">"https://a/b"</span>');
  const code = 'var a = 1;\n#r "nuget: Humanizer.Core, 2.14.1"\n  #r "System.Net.Http"\na';
  const p = paint(code.length, directiveSpans(code), code);
  const at = (s) => p[code.indexOf(s)];
  assert.equal(at('#r "nuget'), 'preproc'); assert.equal(at('"nuget'), 'string'); assert.equal(at('2.14.1'), 'string'); assert.equal(at('var'), null);
  assert.equal(p[code.indexOf('  #r "System') + 2], 'preproc'); assert.equal(at('"System.Net.Http"'), 'string');
  // an unterminated string while typing is still coloured
  assert.equal(toHtml('#r "nug', directiveSpans('#r "nug')), '<span class="t-preproc">#r</span> <span class="t-string">"nug</span>');
});

test('handleCommand drives the page: help, clear, reset, load, errors', async () => {
  const calls = [];
  const host = { print: (t) => calls.push(['print', t]), error: (t) => calls.push(['error', t]), clearTranscript: () => calls.push(['clear']), resetSession: () => calls.push(['reset']), loadScript: async (u) => calls.push(['load', u]) };
  assert.equal(await handleCommand(parseCommand('#help'), host), 'help');
  assert.equal(await handleCommand(parseCommand('clear'), host), 'clear');
  assert.equal(await handleCommand(parseCommand('#clear'), host), 'clear');
  assert.equal(await handleCommand(parseCommand('#reset'), host), 'reset');
  assert.equal(await handleCommand(parseCommand('#load "https://x.test/a.csx"'), host), 'load');
  assert.equal(await handleCommand(parseCommand('#load "nope"'), host), 'error');
  assert.deepEqual(calls.map((c) => c[0]), ['print', 'clear', 'clear', 'reset', 'load', 'error']);
  assert.equal(calls[0][1], HELP_TEXT);
  assert.equal(calls[4][1], 'https://x.test/a.csx');
  for (const w of ['#help', '#clear', '#reset', '#load', '#r "nuget:', 'Ctrl+↑/↓', 'Shift+Enter']) assert.ok(HELP_TEXT.includes(w), w);
});
