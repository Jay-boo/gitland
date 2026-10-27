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

test('shortDate: relative within a week, then day + month, then month + year', () => {
  const now = Date.UTC(2026, 9, 22, 12);
  assert.strictEqual(gl.shortDate(now - 8 * 3600e3, now), gl.relShort(now - 8 * 3600e3));
  assert.match(gl.shortDate(Date.UTC(2026, 7, 26, 12), now), /Aug/);
  assert.match(gl.shortDate(Date.UTC(2026, 7, 26, 12), now), /26/);
  assert.doesNotMatch(gl.shortDate(Date.UTC(2026, 7, 26, 12), now), /2026/);
  assert.match(gl.shortDate(Date.UTC(2025, 1, 10, 12), now), /Feb/);
  assert.match(gl.shortDate(Date.UTC(2025, 1, 10, 12), now), /2025/);
  assert.doesNotMatch(gl.shortDate(Date.UTC(2025, 1, 10, 12), now), /\b10\b/);
  assert.strictEqual(gl.shortDate(0), '');
});

test('listDate: short date with the full date as tooltip', () => {
  const ts = Date.UTC(2025, 1, 10, 12);
  const html = gl.listDate(ts);
  assert.match(html, /^<span class="k" title="[^"]*2025[^"]*">/);
  assert.ok(html.includes(`>${gl.shortDate(ts)}</span>`));
});

test('displayName: an e-mail shows its local part', () => {
  assert.strictEqual(gl.displayName('ja.morel-ext@voltalia.com'), 'ja.morel-ext');
  assert.strictEqual(gl.displayName('Jean-Alain MOREL (EXT)'), 'Jean-Alain MOREL');
  assert.strictEqual(gl.displayName('Diogo FONTE'), 'Diogo FONTE');
  assert.strictEqual(gl.displayName(''), '');
});

test('middleName keeps the type and ticket id, then the tail', () => {
  const long = 'feature/18342-login-page-redesign-with-a-very-long-branch-name';
  assert.strictEqual(gl.branchHead(long), 'feature/18342-');
  assert.strictEqual(gl.middleName(long, 7), 'feature/18342-…ch-name');
  assert.strictEqual(gl.branchHead('fix/88-token'), 'fix/88-');
  assert.strictEqual(gl.middleName('fix/88-token-refresh-on-expiry', 6), 'fix/88-…expiry');
  assert.strictEqual(gl.branchHead('release-candidate-2026'), 'release-');
  assert.strictEqual(gl.middleName('release-candidate-2026', 4), 'release-…2026');
  assert.strictEqual(gl.middleName('dev', 10), 'dev');
  assert.strictEqual(gl.middleName('fix/88-token', 5), 'fix/88-token');
});

test('themeColors reads the 11 lane tokens', () => {
  const got = gl.themeColors((n) => n);
  assert.strictEqual(got.length, 11);
  assert.strictEqual(got[0], '--gl-lane-0');
  assert.strictEqual(got[10], '--gl-lane-10');
});
