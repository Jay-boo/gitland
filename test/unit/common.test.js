// Shared webview helpers (media/common.js).
const test = require('node:test');
const assert = require('node:assert');
const gl = require('../../media/common.js');

test('esc escapes HTML special characters', () => {
  assert.strictEqual(gl.esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.strictEqual(gl.esc("it's"), 'it&#39;s');
  assert.strictEqual(gl.esc(undefined), '');
});

test('icon renders a codicon', () => {
  assert.strictEqual(gl.icon('git-branch'), '<i class="codicon codicon-git-branch"></i>');
  assert.strictEqual(gl.icon('sync', 'codicon-modifier-spin'), '<i class="codicon codicon-sync codicon-modifier-spin"></i>');
});

test('relTime: long form, then a date', () => {
  assert.strictEqual(gl.relTime(Date.now() - 90e3), '1m ago');
  assert.strictEqual(gl.relTime(Date.now() - 3 * 3600e3), '3h ago');
  assert.strictEqual(gl.relTime(Date.now() - 2 * 86400e3), '2d ago');
  assert.match(gl.relTime(Date.UTC(2020, 0, 15)), /2020/);
  assert.strictEqual(gl.relTime(0), '');
});

test('relShort: compact form up to years', () => {
  assert.strictEqual(gl.relShort(Date.now() - 90e3), '1m');
  assert.strictEqual(gl.relShort(Date.now() - 45 * 86400e3), '1mo');
  assert.strictEqual(gl.relShort(Date.now() - 400 * 86400e3), '1y');
});

test('themeColors reads the 11 lane tokens', () => {
  const got = gl.themeColors((n) => n);
  assert.strictEqual(got.length, 11);
  assert.strictEqual(got[0], '--gl-lane-0');
  assert.strictEqual(got[10], '--gl-lane-10');
});
