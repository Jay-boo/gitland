// Renders every Gitland webview in headless Chromium, with the production CSP and real VS Code
// theme variables, replaying the messages captured from a real VS Code run.
//   npm run render [-- --only graph,changes] [-- --out dir]
// Pages:    test/render/fixtures/<view>.html (captured, git-ignored) or static/<view>.page.json
// Messages: test/render/static/<view>.jsonl (hand-written, wins) or fixtures/<view>.jsonl;
//           static/<view>@<variant>.jsonl adds a variant shot of the same page; a line
//           {"type":"__type","selector":…,"text":…} or {"type":"__click","selector":…} drives the page.
// Themes:   test/render/themes/<theme>.json (dumped by test/suite.js)
// Fails (exit 1) on a page error, a CSP violation or horizontal overflow.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const media = path.join(root, 'media');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const only = arg('--only')?.split(',');
const outDir = path.resolve(arg('--out') || path.join(here, 'out'));

const SIDEBAR = new Set(['changes', 'tickets', 'prs', 'releases', 'pipelines']);
/** Captured messages that answer a page's request instead of being replayed at load: request type → reply type. */
const REPLIES = { graph: { select: 'details', hover: 'hover' }, pipelines: { expand: 'jobs' } };
/** Variants that show a page state (loading, empty, error…): the view's interactions do not apply to them. */
const STATE_VARIANTS = new Set(['loading', 'empty', 'signin', 'error', 'empty-repo', 'filter', 'files', 'signedin']);
/** Extra shots after an interaction: [suffix, async (page) => …]. */
const INTERACTIONS = {
  changes: [
    ['sync', async (page) => {
      // Branch card: one sync action visible, the other three under "…" (opened from the keyboard: first item focused).
      const shown = await page.evaluate(() => ['btnSync', 'btnPush', 'btnPull', 'btnFetch'].filter((id) => !document.getElementById(id).hidden).length);
      if (shown !== 1) throw new Error(`changes: ${shown} sync actions visible in the branch card (want 1)`);
      await page.locator('#btnSyncMore').focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
      const r = await page.evaluate(() => ({ n: document.querySelectorAll('#syncMenu .gl-mi').length, focused: document.activeElement && document.activeElement.classList.contains('gl-mi') }));
      if (r.n !== 3 || !r.focused) throw new Error(`changes: the "…" menu lists ${r.n} actions (want 3), focused: ${r.focused}`);
    }],
    ['narrow', async (page) => {
      // Group headers (title, count, stats, actions) must fit the sidebar width.
      const bad = await page.evaluate(() => [...document.querySelectorAll('.gh')].filter((h) => [...h.querySelectorAll('button')].some((b) => b.getBoundingClientRect().right > innerWidth - 2)).map((h) => h.textContent.trim().slice(0, 30)));
      if (bad.length) throw new Error(`changes: group header actions cut off at ${await page.evaluate(() => innerWidth)}px: ${bad.join(' | ')}`);
    }],
    ['editor', async (page) => {
      // In an editor tab the sections keep the readable width (not their content width).
      const vp = page.viewportSize();
      await page.setViewportSize({ width: 1400, height: vp.height });
      const w = await page.evaluate(() => { document.body.classList.add('in-editor'); const g = document.getElementById('groups').getBoundingClientRect().width; const c = document.querySelector('.compose').getBoundingClientRect().width; document.body.classList.remove('in-editor'); return Math.min(g, c); });
      await page.setViewportSize(vp);
      if (w < 800) throw new Error(`changes in an editor tab: sections shrink to ${w}px`);
    }],
    ['end', async (page) => {
      // The pinned composer must never cover the last file: scroll to the end and compare.
      const r = await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        document.body.scrollTop = document.body.scrollHeight;
        const files = document.querySelectorAll('.gb .file');
        const last = files[files.length - 1];
        const compose = document.querySelector('.compose');
        return last && compose ? { last: last.getBoundingClientRect().bottom, compose: compose.getBoundingClientRect().top } : null;
      });
      if (r && r.last > r.compose + 1) throw new Error(`changes: the last file (bottom ${r.last}) is under the composer (top ${r.compose})`);
      await page.waitForTimeout(100);
    }],
  ],
  rebase: [
    ['hover', async (page) => {
      // The per-row action strip appears on hover without moving the row's content.
      const row = page.locator('.rb-row').nth(1);
      const before = await row.evaluate((r) => r.querySelector('.rb-msg').getBoundingClientRect().left);
      await row.hover();
      await page.waitForTimeout(150);
      const after = await row.evaluate((r) => ({ left: r.querySelector('.rb-msg').getBoundingClientRect().left, shown: getComputedStyle(r.querySelector('.rb-acts button:not(.on)')).opacity }));
      if (Math.abs(after.left - before) > 0.5) throw new Error(`rebase: the row content shifts on hover (${before} → ${after.left})`);
      if (after.shown !== '1') throw new Error('rebase: the row actions do not show on hover');
    }],
    ['focus', async (page) => {
      // Keyboard: tabbing into a row's actions shows them (focus-within).
      await page.locator('.rb-row').nth(3).locator('.rb-acts button').nth(1).focus();
      await page.waitForTimeout(150);
      const shown = await page.locator('.rb-row').nth(3).evaluate((r) => getComputedStyle(r.querySelector('.rb-acts button:not(.on)')).opacity);
      if (shown !== '1') throw new Error('rebase: the row actions do not show on keyboard focus');
    }],
  ],
  pipelines: [
    ['expand', async (page) => {
      await page.locator('.run[data-id="411"]').click({ position: { x: 60, y: 12 } });
      await page.waitForTimeout(300);
    }],
  ],
  graph: [
    ['hover', async (page) => {
      const row = page.locator('#rows .commit').nth(3);
      await row.hover();
      await page.waitForTimeout(700);
    }],
    ['details', async (page) => {
      const row = page.locator('#rows .commit').nth(3);
      const box = await row.boundingBox();
      await row.click({ position: { x: box.width - 12, y: box.height / 2 } });
      await page.waitForTimeout(300);
    }],
    ['detailsfit', async (page) => {
      // Selected-commit actions and Close must all be reachable; the message must keep room with many files.
      const row = page.locator('#rows .commit').nth(3);
      const box = await row.boundingBox();
      await row.click({ position: { x: box.width - 12, y: box.height / 2 } });
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const d = document.getElementById('details');
        if (!d || d.hidden) return { err: 'details not open' };
        const dr = d.getBoundingClientRect();
        const cut = [...d.querySelectorAll('.sel-line .act')].filter((b) => { const x = b.getBoundingClientRect(); return x.right > dr.right + 1 || x.width < 8; }).map((b) => b.textContent.trim() || b.className);
        const files = d.querySelector('.files');
        const f = files && files.querySelector('.file');
        if (f) for (let i = 0; i < 30; i++) files.appendChild(f.cloneNode(true));
        const info = d.querySelector('.info').getBoundingClientRect().height;
        return { cut, info };
      });
      if (r.err) throw new Error(`graph: ${r.err}`);
      if (r.cut.length) throw new Error(`graph details: actions cut off: ${r.cut.join(', ')}`);
      if (r.info < 60) throw new Error(`graph details: the commit summary is squeezed to ${r.info}px by the file list`);
    }],
    ['compare', async (page) => {
      await page.keyboard.press('Escape');
      const rows = page.locator('#rows .commit');
      const b3 = await rows.nth(3).boundingBox();
      await rows.nth(3).click({ position: { x: b3.width - 12, y: b3.height / 2 } });
      const b5 = await rows.nth(5).boundingBox();
      await rows.nth(5).click({ position: { x: b5.width - 12, y: b5.height / 2 }, modifiers: ['Control'] });
      await page.waitForTimeout(300);
      const w = await page.evaluate(() => { const c = document.querySelector('#details .close'); return c ? c.getBoundingClientRect().width : 0; });
      if (w > 60) throw new Error(`graph compare: the close button is stretched to ${w}px`);
    }],
    ['more', async (page) => {
      // Toolbar overflow: every moved action is listed, and the menu opens from the keyboard with focus on its first item.
      await page.locator('#btnOverflow').focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => ({ acts: [...document.querySelectorAll('#menu .item')].map((i) => i.dataset.act), focused: document.activeElement && document.activeElement.dataset.act }));
      for (const a of ['tb:btnBranches', 'tb:btnCompare', 'tb:btnRefresh', 'tb:btnKeys']) if (!r.acts.includes(a)) throw new Error(`graph: "…" menu lacks ${a}`);
      if (r.focused !== r.acts[0]) throw new Error('graph: the "…" menu does not focus its first item when opened from the keyboard');
    }],
    ['branches', async (page) => {
      // The branch picker now opens from the "…" menu.
      await page.locator('#btnOverflow').click();
      await page.locator('#menu .item[data-act="tb:btnBranches"]').click();
      await page.waitForTimeout(200);
      if (await page.locator('#picker').isHidden()) throw new Error('graph: "Focus on a branch…" does not open the branch picker');
      const order = await page.evaluate(() => document.querySelector('#picker .search').getBoundingClientRect().top < document.getElementById('pickerList').getBoundingClientRect().top);
      if (!order) throw new Error('graph: the branch picker filter box is not at the top');
    }],
    ['chart', async (page) => {
      // Activity chart: every day column keeps the same width and nothing (e.g. a shared .empty rule) restyles it.
      const r = await page.evaluate(() => {
        const m = document.getElementById('minimap');
        if (!m || m.hidden) return null;
        const days = [...m.querySelectorAll('.day')];
        const w = days.map((d) => d.getBoundingClientRect().width);
        const padded = days.filter((d) => parseFloat(getComputedStyle(d).paddingTop) > 0 || getComputedStyle(d).display !== 'flex').length;
        return { n: days.length, min: Math.min(...w), max: Math.max(...w), padded, bars: [...m.querySelectorAll('.day i')].filter((i) => i.getBoundingClientRect().height > 3).length };
      });
      if (!r) return;
      if (!r.n) throw new Error('graph: the activity chart has no day columns');
      if (r.padded) throw new Error(`graph: ${r.padded} activity-chart day columns are restyled (padding/display)`);
      if (r.max - r.min > 1.5) throw new Error(`graph: activity-chart columns collapse (width ${r.min}–${r.max}px)`);
      if (!r.bars) throw new Error('graph: the activity chart shows no bars');
    }],
    ['keys', async (page) => {
      await page.keyboard.press('?');
      await page.waitForTimeout(150);
    }],
    ['jkeys', async (page) => {
      await page.keyboard.press('Escape');
      for (const k of ['j', 'j', 'j', 'Enter']) await page.keyboard.press(k);
      await page.waitForTimeout(300);
    }],
    ['menu', async (page) => {
      await page.locator('#rows .commit').nth(3).click({ button: 'right' });
      await page.waitForTimeout(200);
    }],
  ],
};
const widths = (view) => (view === 'graph' ? [320, 1000] : SIDEBAR.has(view) ? [220, 320] : [1000]);
const THEMES = ['dark_modern', 'light_modern', 'hc_black'];

const ls = (dir, ext) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length)) : []);
const fixtures = path.join(here, 'fixtures');
const statics = path.join(here, 'static');
const views = [...new Set([...ls(fixtures, '.html'), ...ls(statics, '.page.json')])].filter((v) => !only || only.includes(v)).sort();

/** VS Code's own default webview stylesheet (abridged): what every page gets before its CSS. */
const DEFAULT_STYLES = `<style id="_defaultStyles">
html { scrollbar-color: var(--vscode-scrollbarSlider-background) var(--vscode-editor-background); }
body { background-color: transparent; color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); font-weight: var(--vscode-font-weight); font-size: var(--vscode-font-size); margin: 0; padding: 0 20px; }
img, video { max-width: 100%; max-height: 100%; }
a, a code { color: var(--vscode-textLink-foreground); }
code { font-family: var(--vscode-editor-font-family); color: var(--vscode-textPreformat-foreground); }
</style>`;

const CSP_SOURCE = `'self' https://*.vscode-cdn.net`;

/** Same page as src/views/webviewHtml.ts builds, for views only known from a static page.json. */
function pageFromStatic(p) {
  const nonce = 'static0nonce';
  const uri = (...s) => `https://file%2B.vscode-resource.vscode-cdn.net${path.join(media, ...s)}`;
  const styles = (p.base || ['base.css', 'graph.css']).concat(p.styles || []).map((s) => `<link rel="stylesheet" href="${uri(s)}">`).join('\n');
  const scripts = (p.common || ['common.js']).concat(p.script || []).map((s) => `<script nonce="${nonce}" src="${uri(s)}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${CSP_SOURCE} 'unsafe-inline'; font-src ${CSP_SOURCE}; script-src 'nonce-${nonce}'; img-src ${CSP_SOURCE} https: data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('vendor', 'codicon.css')}">
${styles}
${p.head || ''}
<title>${p.title}</title>
</head>
<body class="${p.bodyClass || ''}">
${p.body}
${scripts}
</body>
</html>`;
}

/** Views whose body markup is exported from src: the capture's body is swapped for the current source, so
 *  markup changes show without re-capturing. view → [source file, exported const]. */
const LIVE_BODY = { graph: ['src/graph/graphPanel.ts', 'GRAPH_BODY'], changes: ['src/views/changesView.ts', 'CHANGES_BODY'] };
function liveBody(html, view) {
  const live = LIVE_BODY[view];
  if (!live) return html;
  const m = fs.readFileSync(path.join(root, live[0]), 'utf8').match(new RegExp(`export const ${live[1]} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`${live[0]}: ${live[1]} not found`);
  return html.replace(/(<body[^>]*>\n)[\s\S]*?(?=<script)/, (_, open) => `${open}${m[1]}\n`);
}

/** Captured page → loadable from disk: vscode-resource URLs → file://, CSP sources → file:, stubs + theme. */
function prepare(html, theme, view) {
  const nonce = (html.match(/'nonce-([^']+)'/) || [])[1];
  const vars = Object.entries(theme.vars).map(([k, v]) => `${k}: ${v}`).join('; ');
  const bg = SIDEBAR.has(view) ? 'var(--vscode-sideBar-background)' : 'var(--vscode-editor-background)';
  const stub = `<script nonce="${nonce}">
window.__posted = [];
let __state = undefined;
window.__replies = {};
const __reply = (m) => {
  if (m && m.type === 'compare' && window.__replies.select) {
    const d = window.__replies.select.details || {};
    return void setTimeout(() => window.postMessage({ type: 'compare', a: m.a, b: m.b, files: d.files || [], onlyNewer: 2, onlyOlder: 0 }, '*'), 30);
  }
  const r = m && window.__replies[m.type];
  if (r) setTimeout(() => window.postMessage({ ...r, sha: m.sha ?? r.sha, details: r.details && { ...r.details, sha: m.sha ?? r.sha } }, '*'), 30);
};
window.acquireVsCodeApi = () => ({ postMessage: (m) => { window.__posted.push(m); __reply(m); }, getState: () => __state, setState: (s) => { __state = s; return s; } });
document.addEventListener('securitypolicyviolation', (e) => { (window.__csp = window.__csp || []).push(e.violatedDirective + ' ' + (e.blockedURI || 'inline')); });
</script>`;
  return html
    .replace(/https:\/\/file%2B\.vscode-resource\.vscode-cdn\.net([^"')\s]+)/g, (_, p) => pathToFileURL(decodeURIComponent(p)).href)
    .split(CSP_SOURCE).join('file:')
    .replace(/<html([^>]*)>/, `<html$1 style="${vars.replace(/"/g, '&quot;')}; background: ${bg};">`)
    .replace(/<head>/, `<head>\n${stub}\n${DEFAULT_STYLES}`)
    // Sidebar views are rendered as the sidebar, even when the capture came from their editor tab.
    .replace(/<body([^>]*?)(?: class="([^"]*)")?>/, (_, a, c) => `<body${a} class="${[SIDEBAR.has(view) ? (c || '').replace(/\bin-editor\b/, '').trim() : c, theme.bodyClass].filter(Boolean).join(' ')}">`);
}

function messages(view, variant) {
  const f = variant
    ? path.join(statics, `${view}@${variant}.jsonl`)
    : [path.join(statics, `${view}.jsonl`), path.join(fixtures, `${view}.jsonl`)].find((x) => fs.existsSync(x));
  return f ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** Interaction quality on the page as rendered: focus ring, no hover shift, pointer rows, no clipped text. */
async function quality(page) {
  const out = [];
  // (a) every focusable control shows the shared focus ring when focused from the keyboard.
  const noRing = await page.evaluate(() => {
    const vis = (e) => e.offsetParent && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0;
    // The commit list (#list) delegates its ring to the focused row, like native lists.
    const els = [...document.querySelectorAll('button, [role=button], [data-act], [tabindex]:not([tabindex="-1"])')].filter((e) => vis(e) && e.id !== 'list').slice(0, 40);
    const bad = [];
    for (const el of els) {
      el.focus({ focusVisible: true });
      if (document.activeElement !== el || !el.matches(':focus-visible')) continue;
      const cs = getComputedStyle(el);
      if (cs.outlineStyle === 'none' || parseFloat(cs.outlineWidth) < 1) bad.push(el.id || el.className || el.tagName);
      el.blur();
    }
    return bad;
  });
  if (noRing.length) out.push(`no focus ring on: ${[...new Set(noRing)].slice(0, 5).join(', ')}`);
  // (a') text fields show focus too: their border (or their .search / .gl-composer box's) changes, or an outline appears.
  const quietFields = await page.evaluate(() => {
    const vis = (e) => e.offsetParent && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0;
    const look = (e) => {
      const box = e.closest('.search, .gl-composer, .state-pick') || e;
      const a = getComputedStyle(e);
      const b = getComputedStyle(box);
      return [a.borderTopColor, a.outlineStyle, a.outlineWidth, b.borderTopColor, b.outlineStyle].join('|');
    };
    const bad = [];
    for (const el of [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, select')].filter(vis).slice(0, 20)) {
      if (document.activeElement === el) el.blur();
      const before = look(el);
      el.focus({ focusVisible: true });
      if (document.activeElement !== el) continue;
      if (look(el) === before) bad.push(el.id || el.className || el.tagName);
      el.blur();
    }
    return bad;
  });
  if (quietFields.length) out.push(`no visible focus on fields: ${[...new Set(quietFields)].slice(0, 5).join(', ')}`);
  // (b) hovering a row or a button never moves it.
  const targets = await page.evaluate(() => {
    const vis = (e) => e.offsetParent && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().top >= 0 && e.getBoundingClientRect().bottom < innerHeight;
    const pick = (sel) => [...document.querySelectorAll(sel)].filter(vis).slice(0, 2);
    return [...pick('.item, .drow, .gl-prow, .link-row, .commit-row, .c-row, .tl-head, .gb .file, .rb-row'), ...pick('button')].map((e) => {
      e.setAttribute('data-q', String(Math.random()).slice(2));
      return e.getAttribute('data-q');
    });
  });
  for (const q of targets) {
    const el = page.locator(`[data-q="${q}"]`);
    const before = await el.boundingBox();
    await el.hover({ force: true }).catch(() => {});
    await page.waitForTimeout(120);
    const after = await el.boundingBox();
    if (before && after && (Math.abs(before.x - after.x) > 0.5 || Math.abs(before.y - after.y) > 0.5 || Math.abs(before.width - after.width) > 0.5 || Math.abs(before.height - after.height) > 0.5)) out.push(`hover moves [data-q] ${await el.evaluate((e) => e.className)}`);
  }
  await page.mouse.move(1, 1);
  await page.evaluate(() => document.querySelectorAll('[data-q]').forEach((e) => e.removeAttribute('data-q')));
  // (c) clickable rows show the pointer (the commit graph keeps the native list arrow).
  const noPointer = await page.evaluate(() =>
    [...document.querySelectorAll('.item, .drow, .gl-orow, .gl-prow, .link-row:not(.on), .commit-row, .c-row, .pr-row, .cl-row, .f-row, .gb .file, .tl-head, [data-act]:not(button)')]
      .filter((e) => e.offsetParent && getComputedStyle(e).cursor !== 'pointer')
      .map((e) => e.className),
  );
  if (noPointer.length) out.push(`no pointer cursor on: ${[...new Set(noPointer)].slice(0, 5).join(', ')}`);
  // (d) text never overflows its box without an ellipsis.
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll('body *')]
      .filter((e) => {
        if (!e.offsetParent || e.closest('svg, pre, textarea, .codicon')) return false;
        const cs = getComputedStyle(e);
        if (!/hidden|clip/.test(cs.overflowX) || cs.textOverflow === 'ellipsis') return false;
        if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return false;
        return e.scrollWidth > e.clientWidth + 1;
      })
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ').join('.')}`),
  );
  if (clipped.length) out.push(`text clipped without ellipsis: ${[...new Set(clipped)].slice(0, 5).join(', ')}`);
  return out;
}

const exe = path.join(os.homedir(), '.cache/ms-playwright/chromium-1134/chrome-linux/chrome');
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined, args: ['--allow-file-access-from-files'] });
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitland-render-'));
const failures = [];
let shots = 0;

for (const view of views) {
  const captured = path.join(fixtures, `${view}.html`);
  const html = fs.existsSync(captured)
    ? fs.readFileSync(captured, 'utf8')
    : pageFromStatic(JSON.parse(fs.readFileSync(path.join(statics, `${view}.page.json`), 'utf8')));
  for (const variant of [undefined, ...ls(statics, '.jsonl').filter((f) => f.startsWith(`${view}@`)).map((f) => f.slice(view.length + 1))]) {
  const name = variant ? `${view}@${variant}` : view;
  const all = messages(view, variant);
  const map = REPLIES[view] || {};
  const replyTypes = Object.values(map);
  const msgs = all.filter((m) => !replyTypes.includes(m.type));
  // A captured 'details' message stands in for any reply type ('hover' has the same shape).
  const sample = all.find((m) => replyTypes.includes(m.type));
  const replies = {};
  for (const [req, type] of Object.entries(map)) if (sample) replies[req] = { ...sample, type };
  for (const t of THEMES) {
    const theme = JSON.parse(fs.readFileSync(path.join(here, 'themes', `${t}.json`), 'utf8'));
    const file = path.join(tmp, `${name}-${t}.html`);
    fs.writeFileSync(file, prepare(liveBody(html, view), theme, view));
    for (const w of widths(view)) {
      const page = await browser.newPage({ viewport: { width: w, height: 760 }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      await page.goto(pathToFileURL(file).href);
      await page.waitForTimeout(150);
      await page.evaluate((r) => { window.__replies = r; }, replies);
      for (const m of msgs) {
        // Harness steps inside a .jsonl: type into or click an element of the page (e.g. a filter, a tab).
        if (m.type === '__type') await page.locator(m.selector).fill(m.text);
        else if (m.type === '__click') await page.locator(m.selector).click();
        else await page.evaluate((x) => window.postMessage(x, '*'), m);
      }
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => ({ sw: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), w: innerWidth, csp: window.__csp || [] }));
      if (r.sw > r.w + 1) {
        const wide = await page.evaluate(() =>
          [...document.querySelectorAll('body *')]
            .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
            .slice(0, 3)
            .map((e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${e.className && typeof e.className === 'string' ? `.${e.className.trim().split(/\s+/).join('.')}` : ''}`),
        );
        errors.push(`horizontal overflow: scrollWidth ${r.sw} > ${r.w} (${wide.join(', ')})`);
      }
      for (const c of r.csp) errors.push(`CSP: ${c}`);
      // Empty / loading / error blocks must keep a readable width (a stray class once squeezed them to 50px).
      const narrow = await page.evaluate(() => [...document.querySelectorAll('.gl-empty')].filter((e) => e.offsetParent && e.getBoundingClientRect().width < 160).length);
      if (narrow) errors.push(`${narrow} .gl-empty block(s) narrower than 160px`);
      await page.screenshot({ path: path.join(outDir, `${name}-${t}-${w}.png`), fullPage: true });
      shots++;
      errors.push(...(await quality(page)));
      for (const [suffix, act] of INTERACTIONS[name] || (STATE_VARIANTS.has(variant) ? [] : INTERACTIONS[view]) || []) {
        await act(page);
        await page.screenshot({ path: path.join(outDir, `${name}-${t}-${w}-${suffix}.png`) });
        shots++;
        const sw = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth);
        if (sw > 1) errors.push(`${suffix}: horizontal overflow of ${sw}px`);
        await page.mouse.move(1, 1);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
      }
      if (errors.length) failures.push(`${name} ${t} ${w}px: ${errors.join(' | ')}`);
      await page.close();
    }
  }
  }
}
await browser.close();
if (process.env.KEEP_HTML) console.log(`pages kept in ${tmp}`);
else fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${shots} screenshots → ${path.relative(root, outDir)}`);
if (failures.length) {
  console.log(`${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
