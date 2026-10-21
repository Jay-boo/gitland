// Renders every Gitland webview in headless Chromium, with the production CSP and real VS Code
// theme variables, replaying the messages captured from a real VS Code run.
//   npm run render [-- --only graph,changes] [-- --out dir]
// Pages:    test/render/fixtures/<view>.html (captured, git-ignored) or static/<view>.page.json
// Messages: test/render/static/<view>.jsonl (hand-written, wins) or fixtures/<view>.jsonl;
//           static/<view>@<variant>.jsonl adds a variant shot of the same page.
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

const SIDEBAR = new Set(['changes', 'tickets', 'prs', 'releases']);
/** Captured messages that answer a page's request instead of being replayed at load: request type → reply type. */
const REPLIES = { graph: { select: 'details', hover: 'hover' } };
/** Extra shots after an interaction: [suffix, async (page) => …]. */
const INTERACTIONS = {
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
    ['branches', async (page) => {
      await page.locator('#btnBranches').click();
      await page.waitForTimeout(200);
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
    fs.writeFileSync(file, prepare(html, theme, view));
    for (const w of widths(view)) {
      const page = await browser.newPage({ viewport: { width: w, height: 760 }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      await page.goto(pathToFileURL(file).href);
      await page.waitForTimeout(150);
      await page.evaluate((r) => { window.__replies = r; }, replies);
      for (const m of msgs) await page.evaluate((x) => window.postMessage(x, '*'), m);
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, csp: window.__csp || [] }));
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
      await page.screenshot({ path: path.join(outDir, `${name}-${t}-${w}.png`), fullPage: true });
      shots++;
      for (const [suffix, act] of INTERACTIONS[view] || []) {
        await act(page);
        await page.screenshot({ path: path.join(outDir, `${name}-${t}-${w}-${suffix}.png`) });
        shots++;
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
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${shots} screenshots → ${path.relative(root, outDir)}`);
if (failures.length) {
  console.log(`${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
