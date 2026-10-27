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
  for (const sel of ['.gl-task', '.gl-orow', '.gl-chip', '.gl-pop']) {
    const rule = base().match(new RegExp(`(^|\\n)${sel.replace('.', '\\.')}[^{\\n]*\\{[^}]*\\}`));
    assert.ok(rule, `${sel} rule exists`);
    assert.match(rule[0], /--gl-border|contrastBorder/, `${sel} keeps an edge in high contrast`);
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
  // All chips share one shape rule in base.css (it carries the border); views only colour them.
  const shared = rules(base()).find(([s]) => s.split(',').map((x) => x.trim()).includes('.gl-chip'));
  assert.ok(shared, 'base.css shared chip rule exists');
  assert.match(shared[1], /border:\s*1px solid var\(--gl-border\)/, 'the shared chip rule uses --gl-border');
  const names = shared[0].split(',').map((x) => x.trim());
  for (const sel of ['.rel-chip', '.ci-label', '.sig-chip', '.hchip', '.pr-chip', '.ref', '.pill', '.tag', '.chip', '.link-chip', '.pr-badge', '.merged-chip', '.hook-chip']) {
    assert.ok(names.includes(sel), `${sel} uses the shared chip shape`);
  }
  // No view rule takes the border away from a chip.
  for (const f of files(media, '.css')) {
    for (const [sel, body] of rules(read(f))) {
      if (names.includes(sel.trim()) && /border:\s*(0|none)\b/.test(body)) assert.fail(`${path.basename(f)} ${sel} drops the chip border`);
    }
  }
});

test('the active segment is outlined in high contrast', () => {
  assert.match(read(path.join(media, 'base.css')), /\.gl-seg > button\.on[^{]*\{[^}]*--vscode-contrastActiveBorder/);
  assert.match(read(path.join(media, 'graph.css')), /\.seg button\.on[^{]*\{[^}]*--vscode-contrastActiveBorder/);
});

test('the ticket reminder is a modal question, asked after the staging checks and not on the hook retry', () => {
  const ts = read(path.join(src, 'views', 'changesView.ts'));
  assert.match(ts, /showWarningMessage\(`\$\{branch\} has no ticket[^`]*`, \{ modal: true \}/);
  const commit = ts.slice(ts.indexOf('private async commit('));
  assert.ok(commit.indexOf('remindTicket') > commit.indexOf("repo.exec(['add', '-A'])"), 'after staging');
  assert.match(commit, /!amend && !noVerify/);
});

test('graph merge-base only takes a SHA', () => {
  assert.match(read(path.join(src, 'graph', 'graphPanel.ts')), /case 'mergeBase': \{\n\s+if \(!\/\^\[0-9a-f\]\{7,64\}\$\/i\.test\(m\.sha\)\)/);
});

// ---------- stream restyle (docs/superpowers/specs/2026-10-22-stream-restyle-design.md) ----------

/** [selector, declarations] of every rule in a stylesheet (flat; @media blocks are scanned too). */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let m;
  while ((m = re.exec(src))) out.push([m[1].trim().replace(/^@media[^{]*$/, '').trim(), m[2]]);
  return out;
}

test('filled surfaces are rare (one card per screen)', () => {
  const allowed = ['.sync', '#details .info', '.t-head', '.t-actions', '.c-head', '.preview'];
  const bad = [];
  for (const f of files(media, '.css').filter((f) => path.basename(f) !== 'base.css')) {
    for (const [sel, body] of rules(read(f))) {
      if (/background(-color)?:\s*var\(--(gl-card|surface-2|surface)\)/.test(body) && !sel.split(',').every((s) => allowed.some((a) => s.trim().endsWith(a)))) {
        bad.push(`${path.basename(f)}: ${sel}`);
      }
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('chips are square-ish (no round pills)', () => {
  const ok = /switch|knob|track|avatar|\.av\b|bubble|dot|legend i|scrollbar|gl-seg|gl-skeleton|loading/;
  const bad = [];
  for (const f of files(media, '.css')) {
    for (const [sel, body] of rules(read(f))) {
      if (/border-radius:\s*(999px|50%)/.test(body) && !ok.test(sel)) bad.push(`${path.basename(f)}: ${sel}`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('stream components exist with high-contrast borders', () => {
  const css = base();
  for (const sel of ['.gl-task', '.gl-orow', '.gl-ck .act', '.gl-chip']) {
    const rule = rules(css).find(([s]) => s.split(',').map((x) => x.trim()).includes(sel));
    assert.ok(rule, `${sel} rule exists`);
    assert.match(rule[1], /--gl-border|contrastBorder|--gl-dash/, `${sel} keeps an edge in high contrast`);
  }
  assert.match(css, /--gl-chip:/);
  assert.match(css, /--gl-dash:/);
});

test('a refused commit shows its hook output next to the Commit button', () => {
  const ts = read(path.join(src, 'views', 'changesView.ts'));
  const body = ts.slice(ts.indexOf('export const CHANGES_BODY'));
  const compose = body.indexOf('<section class="compose">');
  const hook = body.indexOf('id="hookOut"');
  const end = body.indexOf('</section>', compose);
  assert.ok(hook > compose && hook < end, '#hookOut is inside the pinned composer');
});

test('markdown headings in descriptions are not section separators', () => {
  assert.match(read(path.join(media, 'ticket.css')), /\.rich h3::after\s*\{[^}]*content:\s*none/);
});

test('dashed lines and selected rows keep high-contrast edges', () => {
  assert.match(base(), /--gl-dash:\s*var\(--vscode-contrastBorder,/);
  assert.match(base(), /\.gl-orow\.sel\s*\{[^}]*contrastActiveBorder/);
  assert.match(read(path.join(media, 'changes.css')), /\.gb \.file\.sel\s*\{[^}]*contrastActiveBorder/);
});
