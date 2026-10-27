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

const jira = { ...github, ticketKind: 'jira', ticketKeys: { DATA: 'https://acme.atlassian.net', OPS: 'https://jira.corp.com/jira' } };

test('Jira: only configured keys, whole words', () => {
  assert.deepStrictEqual(findLinks('DATA-12 fix UTF-8 and SHA-256, XDATA-3, see OPS-4', jira).map((l) => [l.kind, l.id, l.url]), [
    ['ticket', 'DATA-12', 'https://acme.atlassian.net/browse/DATA-12'],
    ['ticket', 'OPS-4', 'https://jira.corp.com/jira/browse/OPS-4'],
  ]);
});

test('Jira: #n is not a ticket, PR rules intact', () => {
  assert.deepStrictEqual(findLinks('Fix (#7)\n\nrefs #9', jira).map((l) => [l.kind, l.id]), [['pr', '7']]);
});

test('Jira: a key and a PR with the same number are both linked', () => {
  assert.deepStrictEqual(findLinks('DATA-7: fix (#7)', jira).map((l) => l.kind + l.id).sort(), ['pr7', 'ticketDATA-7']);
});

test('Jira: a key inside a URL path is not linked twice', () => {
  assert.deepStrictEqual(findLinks('see https://acme.atlassian.net/browse/DATA-5', jira), []);
});
