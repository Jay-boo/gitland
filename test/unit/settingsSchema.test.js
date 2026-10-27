// Settings page grouping (src/settings/schema.pure.ts).
const test = require('node:test');
const assert = require('node:assert');
const { settingsGroups } = require('../../out/unit/schema.js');

const props = {
  'gitland.blame.toggleMode': { type: 'string', enum: ['file', 'window'], default: 'file', description: 'How file blame toggles.' },
  'gitland.graph.maxCommits': { type: 'number', default: 400, description: 'Commits to load.' },
  'gitland.graph.statusBar.enabled': { type: 'boolean', default: true, markdownDescription: 'Show **Graph** in the status bar.' },
  'gitland.changes.commitMessageInstructions': { type: 'string', default: '', description: 'Extra instructions.' },
  'gitland.branch.prefixByType': { type: 'object', default: {}, description: 'Prefixes.' },
  'gitland.ai.explainInstructions': { type: 'string', default: '' },
  'gitland.zzz.other': { type: 'boolean', default: false },
};

test('groups in the page order, unknown keys last under Other', () => {
  const g = settingsGroups(props);
  assert.deepStrictEqual(g.map((x) => x.title), ['Graph', 'Blame & CodeLens', 'Changes & AI', 'Tickets & branches', 'Other']);
});

test('control types', () => {
  const all = Object.fromEntries(settingsGroups(props).flatMap((g) => g.settings).map((s) => [s.key, s]));
  assert.strictEqual(all['graph.maxCommits'].type, 'number');
  assert.strictEqual(all['graph.statusBar.enabled'].type, 'boolean');
  assert.strictEqual(all['blame.toggleMode'].type, 'enum');
  assert.deepStrictEqual(all['blame.toggleMode'].options, ['file', 'window']);
  assert.strictEqual(all['changes.commitMessageInstructions'].type, 'text');
  assert.strictEqual(all['branch.prefixByType'].type, 'json');
  assert.strictEqual(all['blame.toggleMode'].default, 'file');
});

test('titles drop the group prefix and split camelCase', () => {
  const all = Object.fromEntries(settingsGroups(props).flatMap((g) => g.settings).map((s) => [s.key, s]));
  assert.strictEqual(all['graph.maxCommits'].title, 'Max Commits');
  assert.strictEqual(all['graph.statusBar.enabled'].title, 'Status Bar Enabled');
  assert.strictEqual(all['ai.explainInstructions'].title, 'Explain Instructions');
});

test('descriptions come from description or markdownDescription', () => {
  const all = Object.fromEntries(settingsGroups(props).flatMap((g) => g.settings).map((s) => [s.key, s]));
  assert.strictEqual(all['graph.maxCommits'].description, 'Commits to load.');
  assert.strictEqual(all['graph.statusBar.enabled'].description, 'Show **Graph** in the status bar.');
});
