// Pull requests and tickets mentioned in commit messages (src/links.ts).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');

const entry = path.join(__dirname, '../../src/links.ts');
const { outputFiles } = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false });
const mod = new Module(entry);
mod._compile(outputFiles[0].text, entry);
const { findLinks } = mod.exports;

const gitlab = {
  kind: 'gitlab',
  pullRequestUrl: (id) => `https://gitlab.com/g/r/-/merge_requests/${id}`,
  ticketUrl: (id) => `https://gitlab.com/g/r/-/issues/${id}`,
};
const github = { kind: 'github', pullRequestUrl: (id) => `https://github.com/o/r/pull/${id}`, ticketUrl: (id) => `https://github.com/o/r/issues/${id}` };

test('GitLab: merge requests (!n) and issues (#n)', () => {
  assert.deepStrictEqual(findLinks('Fix login\n\nSee merge request g/r!42\nCloses #7', gitlab), [
    { kind: 'pr', id: '42', url: 'https://gitlab.com/g/r/-/merge_requests/42' },
    { kind: 'ticket', id: '7', url: 'https://gitlab.com/g/r/-/issues/7' },
  ]);
  assert.ok(findLinks('Merge branch x into main (!12)', gitlab).some((l) => l.kind === 'pr' && l.id === '12'));
});

test('GitHub: !n is not a pull request', () => {
  assert.ok(!findLinks('a!12', github).some((l) => l.kind === 'pr'));
});

test('GitLab: an issue and a merge request with the same number are both linked', () => {
  const l = findLinks('Fix\n\nCloses #7\n\nSee merge request g/r!7', gitlab);
  assert.deepStrictEqual(l.map((x) => x.kind + x.id).sort(), ['pr7', 'ticket7']);
});
