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
  const ws = process.env.GITLAND_TEST_WORKSPACE;
  const ext = vscode.extensions.getExtension('jayboo.gitland');
  await step('extension is present', () => assert.ok(ext, 'jayboo.gitland not found'));
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
  const file = vscode.Uri.file(path.join(ws, 'azure-pipelines.yml'));
  await step('toggle file blame on a tracked file', async () => {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(3, 0, 3, 0);
    await vscode.commands.executeCommand('gitland.toggleFileBlame');
    await sleep(1500);
  });
  await step('show git graph', async () => {
    await vscode.commands.executeCommand('gitland.showGraph');
    await sleep(2500);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab && /Git Graph/.test(tab.label), `active tab is ${tab && tab.label}`);
  });
  await step('open commit diff from blame args', async () => {
    const out = require('child_process').execSync('git log -1 --format=%H -- azure-pipelines.yml', { cwd: ws }).toString().trim();
    await vscode.commands.executeCommand('gitland.openCommitFileDiff', { repoRoot: ws, sha: out, path: 'azure-pipelines.yml', previousPath: 'azure-pipelines.yml' });
    await sleep(1500);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab && tab.input instanceof vscode.TabInputTextDiff, `active tab is ${tab && tab.label}`);
  });
  await step('views are contributed', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.gitland');
    await sleep(1500);
  });
  // Give background work a moment to log anything unexpected.
  await sleep(1000);
};
