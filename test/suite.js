// Runs inside the VS Code extension host.
const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (e) {
    console.log(`  ✘ ${name}: ${e && e.stack ? e.stack : e}`);
    throw e;
  }
}

exports.run = async function () {
  if (process.env.GITLAND_CAPTURE_DIR) {
    return captureForRender(process.env.GITLAND_CAPTURE_DIR);
  }
  const ws = process.env.GITLAND_TEST_WORKSPACE;
  const ext = vscode.extensions.getExtension('jay-boo.gitland');
  await step('extension is present', () => assert.ok(ext, 'jay-boo.gitland not found'));
  await step('extension activates', async () => {
    await ext.activate();
    assert.ok(ext.isActive);
  });
  await step('all commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    const declared = ext.packageJSON.contributes.commands.map((c) => c.command);
    const missing = declared.filter((c) => !all.includes(c));
    assert.deepStrictEqual(missing, []);
  });
  const cp = require('child_process');
  // A tracked text file with some history, e.g. the most recently changed one.
  const tracked =
    cp.execSync("git log -1 --diff-filter=AM --name-only --format= -- '*.py' '*.ts' '*.yml' '*.md' '*.json'", { cwd: ws }).toString().trim().split('\n')[0] ||
    cp.execSync('git ls-files', { cwd: ws }).toString().split('\n')[0];
  console.log(`    using ${tracked}`);
  const file = vscode.Uri.file(path.join(ws, tracked));
  await step('toggle file blame on a tracked file', async () => {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(3, 0, 3, 0);
    await vscode.commands.executeCommand('gitland.toggleFileBlame');
    await sleep(1500);
  });
  await step('show commit graph view in the Gitland sidebar (default, like GitLens)', async () => {
    await vscode.commands.executeCommand('gitland.showGraph');
    await sleep(3000);
    if (process.env.GITLAND_TEST_HOLD) {
      await sleep(Number(process.env.GITLAND_TEST_HOLD));
    }
  });
  await step('show commit graph in the bottom panel too', async () => {
    await vscode.commands.executeCommand('gitland.showGraphInPanel');
    await sleep(2500);
  });
  await step('show the Changes view (stage / commit / push)', async () => {
    await vscode.commands.executeCommand('gitland.changesView.focus');
    await sleep(2000);
  });
  await step('show the Changes view in the bottom panel too', async () => {
    await vscode.commands.executeCommand('gitland.showChangesInPanel');
    await sleep(2000);
    await vscode.commands.executeCommand('gitland.showChangesView');
    await sleep(1000);
  });
  await step('open the Changes view in an editor tab', async () => {
    await vscode.commands.executeCommand('gitland.showChangesInEditor');
    await sleep(2500);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab && /^Changes/.test(tab.label) && tab.input instanceof vscode.TabInputWebview, `active tab is ${tab && tab.label}`);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
  await step('open commit graph in an editor tab', async () => {
    await vscode.commands.executeCommand('gitland.showGraphInEditor');
    await sleep(2500);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab && /^Commit Graph|TRESO|Infra|gitland/.test(tab.label) && tab.input instanceof vscode.TabInputWebview, `active tab is ${tab && tab.label}`);
  });
  await step('open commit diff from blame args', async () => {
    const out = cp.execSync(`git log -1 --format=%H -- "${tracked}"`, { cwd: ws }).toString().trim();
    await vscode.commands.executeCommand('gitland.openCommitFileDiff', { repoRoot: ws, sha: out, path: tracked, previousPath: tracked });
    await sleep(1500);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab && tab.input instanceof vscode.TabInputTextDiff, `active tab is ${tab && tab.label}`);
  });
  await step('GitLens-style CodeLens: recent change + authors', async () => {
    const pyFile = vscode.Uri.file(path.join(ws, process.env.GITLAND_TEST_PYFILE || tracked));
    const doc = await vscode.workspace.openTextDocument(pyFile);
    await vscode.window.showTextDocument(doc);
    await sleep(4000); // let language servers index symbols
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', pyFile, 100);
    const ours = lenses.filter((l) => l.command && /^\$\((history|person|organization|pencil)\)/.test(l.command.title));
    console.log(`    ${ours.length} Gitland lenses, e.g.: ${ours.slice(0, 4).map((l) => `L${l.range.start.line + 1} "${l.command.title}"`).join(' | ')}`);
    assert.ok(ours.length >= 2, 'expected at least the document-level lenses');
  });
  await step('show My Tickets and Pull Requests (webviews)', async () => {
    await vscode.commands.executeCommand('gitland.tickets.focus');
    await vscode.commands.executeCommand('gitland.prs.focus');
    await sleep(2000);
  });
  await step('views are contributed', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.gitlandSidebar');
    await sleep(1500);
  });
  // Give background work a moment to log anything unexpected.
  await sleep(1000);
};

// --- capture for test/render/render.mjs (GITLAND_CAPTURE_DIR set) ---

const THEMES = { dark_modern: 'Default Dark Modern', light_modern: 'Default Light Modern', hc_black: 'Default High Contrast' };

/** Theme variables VS Code puts on a webview's <html style> and its body class, for one theme. */
async function dumpTheme(file, theme) {
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
  await sleep(1500);
  const panel = vscode.window.createWebviewPanel('gitland.themeDump', 'theme', vscode.ViewColumn.Active, { enableScripts: true });
  const got = new Promise((resolve) => panel.webview.onDidReceiveMessage(resolve));
  panel.webview.html = `<!DOCTYPE html><html><body><script>
    const vars = {};
    const st = document.documentElement.style;
    for (let i = 0; i < st.length; i++) { const n = st[i]; if (n.startsWith('--vscode-')) vars[n] = st.getPropertyValue(n).trim(); }
    acquireVsCodeApi().postMessage({ bodyClass: document.body.className, vars });
  </script></body></html>`;
  const data = await Promise.race([got, sleep(8000).then(() => undefined)]);
  panel.dispose();
  if (!data) throw new Error(`no theme dump for ${theme}`);
  require('fs').writeFileSync(file, JSON.stringify(data, null, 1));
  console.log(`    ${theme}: ${Object.keys(data.vars).length} vars, body "${data.bodyClass}"`);
}

/** First JSON value in <dir>/<view>.jsonl matching pick(), or undefined. */
function fromCapture(dir, view, pick) {
  const fs = require('fs');
  const f = path.join(dir, `${view}.jsonl`);
  if (!fs.existsSync(f)) return undefined;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    const v = pick(JSON.parse(line));
    if (v !== undefined) return v;
  }
  return undefined;
}

async function captureForRender(dir) {
  const fs = require('fs');
  const ext = vscode.extensions.getExtension('jay-boo.gitland');
  await ext.activate();
  const themesDir = path.join(__dirname, 'render', 'themes');
  fs.mkdirSync(themesDir, { recursive: true });
  for (const [file, theme] of Object.entries(THEMES)) {
    await step(`theme ${theme}`, () => dumpTheme(path.join(themesDir, `${file}.json`), theme));
  }
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', THEMES.dark_modern, vscode.ConfigurationTarget.Global);
  const open = async (name, fn, wait = 5000) => {
    await step(`capture ${name}`, async () => {
      await fn();
      await sleep(wait);
    });
  };
  const run = (cmd, ...args) => () => vscode.commands.executeCommand(cmd, ...args);
  await open('sidebar', run('workbench.view.extension.gitlandSidebar'), 6000);
  await open('tickets', run('gitland.tickets.focus'), 6000);
  await open('prs', run('gitland.prs.focus'), 6000);
  await open('releases', run('gitland.releases.focus'), 6000);
  await open('graph', run('gitland.showGraphInEditor'), 8000);
  await open('changes', run('gitland.showChangesInEditor'));
  await open('dashboard', run('gitland.dashboard'), 8000);
  await open('compare', run('gitland.compare', 'HEAD~15', 'HEAD'), 6000);
  const ws = process.env.GITLAND_TEST_WORKSPACE;
  const readme = ['README.md', 'package.json', 'pyproject.toml'].map((f) => path.join(ws, f)).find((f) => fs.existsSync(f));
  await open('history', async () => {
    await vscode.window.showTextDocument(vscode.Uri.file(readme));
    await vscode.commands.executeCommand('gitland.fileHistory');
  }, 6000);
  await open('cleanup', run('gitland.branches.cleanup'), 6000);
  await open('rebase', run('gitland.rebase.interactive', 'HEAD~6'));
  await open('newpr', run('gitland.prs.create'), 8000);
  await open('newrelease', run('gitland.releases.create'), 6000);
  const prId = fromCapture(dir, 'prs', (m) => {
    const all = JSON.stringify(m).match(/"id":"?(\d+)"?/);
    return all ? all[1] : undefined;
  });
  if (prId) await open('pr', run('gitland.prs.show', prId), 8000);
  const ticketId = fromCapture(dir, 'tickets', (m) => {
    const all = JSON.stringify(m).match(/"id":"?(\d+)"?/);
    return all ? all[1] : undefined;
  });
  if (ticketId) {
    await open('ticket', async () => {
      await vscode.commands.executeCommand('gitland.tickets.show', { ticket: { id: ticketId } });
    }, 8000);
  }
  console.log(`    captured: ${fs.readdirSync(dir).filter((f) => f.endsWith('.html')).join(', ')}`);
}
