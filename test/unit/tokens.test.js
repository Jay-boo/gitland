// Style rules of the Sixth-style restyle: theme tokens only, shared helpers only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const media = path.join(__dirname, '../../media');
const src = path.join(__dirname, '../../src');
const read = (f) => fs.readFileSync(f, 'utf8');
const files = (dir, ext) => fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f));
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const base = () => read(path.join(media, 'base.css'));

test('no hex colour literal in view stylesheets (only base.css fallbacks)', () => {
  const bad = files(media, '.css')
    .filter((f) => path.basename(f) !== 'base.css')
    .flatMap((f) => (read(f).match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((h) => `${path.basename(f)}: ${h}`));
  assert.deepStrictEqual(bad, []);
});

test('every --gl-* colour token maps to a theme variable with a fallback', () => {
  const decls = [...base().matchAll(/(--gl-[\w-]+)\s*:\s*([^;]+);/g)];
  assert.ok(decls.length > 20, 'tokens are declared');
  const bad = decls
    .filter(([, name]) => !/^--gl-(font|mono|radius|row|shadow)/.test(name))
    .filter(([, , v]) => !/var\(--(vscode|gl)-[\w-]+\s*,/.test(v) && !/color-mix\(/.test(v))
    .map(([, n, v]) => `${n}: ${v}`);
  assert.deepStrictEqual(bad, []);
});

test('Geist is gone', () => {
  const hits = [...walk(media), ...walk(src)].filter((f) => /\.(css|js|ts)$/.test(f) && /Gitland Geist|geist/i.test(read(f)));
  assert.deepStrictEqual(hits.map((f) => path.relative(media, f)), []);
});

test('view scripts use the shared helpers, not private copies', () => {
  const bad = files(media, '.js')
    .filter((f) => path.basename(f) !== 'common.js')
    .filter((f) => /const esc = |function relTime\(/.test(read(f)))
    .map((f) => path.basename(f));
  assert.deepStrictEqual(bad, []);
});

test('keyboard focus stays visible', () => {
  assert.match(base(), /:focus-visible[^{]*\{[^}]*--vscode-focusBorder/);
});

test('cards, lists, pills and pop-overs show the high-contrast border', () => {
  for (const sel of ['.gl-card', '.gl-list', '.gl-pill', '.gl-pop']) {
    const rule = base().match(new RegExp(`(^|\\n)${sel.replace('.', '\\.')}\\s*\\{[^}]*\\}`));
    assert.ok(rule, `${sel} rule exists`);
    assert.match(rule[0], /--gl-border/, `${sel} uses --gl-border`);
  }
});

test('graph lanes come from the theme, not hex literals', () => {
  const js = read(path.join(media, 'graph.js'));
  assert.deepStrictEqual(js.match(/'#[0-9a-fA-F]{3,8}'/g) || [], []);
  assert.match(js, /gl\.themeColors|themeColors\(/);
});

test('editor blame hover uses theme colours', () => {
  const ts = read(path.join(src, 'blame', 'blameController.ts'));
  for (const name of ['MUTED', 'BRANCH', 'PR', 'TICKET', 'RELEASE', 'ADDED', 'DELETED']) {
    assert.match(ts, new RegExp(`const ${name} = 'var\\(--vscode-[\\w-]+\\)'`), `${name} is a theme variable`);
  }
  assert.doesNotMatch(ts, /\$\{c\}26/, 'pills do not append a hex alpha to a colour');
});

test('graph theme watcher ignores the graph writing its own <html style> vars', () => {
  const js = read(path.join(media, 'graph.js'));
  assert.doesNotMatch(js, /themeWatch\.observe\(document\.documentElement/);
  assert.match(js, /themeWatch\.observe\(document\.body, \{ attributes: true, attributeFilter: \['class'\] \}\)/);
});

test('every tinted chip shows the high-contrast border', () => {
  const rules = [
    ['graph.css', '.rel-chip'], ['graph.css', '.ci-label'], ['graph.css', '.sig-chip'],
    ['history.css', '.hchip'], ['compare.css', '.pr-chip'], ['pr.css', '.rev .req'], ['ticket.css', '.cur-chip.big'],
  ];
  for (const [file, sel] of rules) {
    const css = read(path.join(media, file));
    const esc = sel.replace(/[.]/g, '\\.').replace(/ /g, '\\s+');
    const rule = css.match(new RegExp(`(^|\\n)${esc}\\s*\\{[^}]*\\}`));
    assert.ok(rule, `${file} ${sel} exists`);
    assert.match(rule[0], /--gl-border/, `${file} ${sel} uses --gl-border`);
  }
});

test('the active segment is outlined in high contrast', () => {
  assert.match(read(path.join(media, 'base.css')), /\.gl-seg > button\.on[^{]*\{[^}]*--vscode-contrastActiveBorder/);
  assert.match(read(path.join(media, 'graph.css')), /\.seg button\.on[^{]*\{[^}]*--vscode-contrastActiveBorder/);
});
