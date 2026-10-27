// Which Gitland page a link opens (src/linkTarget.pure.ts).
const test = require('node:test');
const assert = require('node:assert');
const { linkTarget } = require('../../out/unit/linkTarget.js');

const azure = {
  kind: 'azure',
  pullRequestUrl: (id) => `https://dev.azure.com/Org/Proj/_git/repo/pullrequest/${id}`,
  ticketUrl: (id) => `https://dev.azure.com/Org/Proj/_workitems/edit/${id}`,
  releaseUrl: (tag) => `https://dev.azure.com/Org/Proj/_git/repo?version=GT${encodeURIComponent(tag)}`,
};
const github = {
  kind: 'github',
  pullRequestUrl: (id) => `https://github.com/o/r/pull/${id}`,
  ticketUrl: (id) => `https://github.com/o/r/issues/${id}`,
  releaseUrl: (tag) => `https://github.com/o/r/releases/tag/${encodeURIComponent(tag)}`,
};

test('pull requests of this repository open the PR page', () => {
  assert.deepStrictEqual(linkTarget('https://dev.azure.com/Org/Proj/_git/repo/pullrequest/527', azure), { kind: 'pr', id: '527' });
  assert.deepStrictEqual(linkTarget('https://dev.azure.com/org/proj/_git/repo/pullrequest/527?_a=files', azure), { kind: 'pr', id: '527' });
  assert.deepStrictEqual(linkTarget('https://github.com/o/r/pull/12', github), { kind: 'pr', id: '12' });
  assert.strictEqual(linkTarget('https://github.com/other/r/pull/12', github), undefined);
});

test('work items and issues open the ticket page', () => {
  assert.deepStrictEqual(linkTarget('https://dev.azure.com/Backlog%20Org/Board/_workitems/edit/1234', undefined), { kind: 'ticket', id: '1234', org: 'Backlog Org' });
  assert.deepStrictEqual(linkTarget('https://github.com/o/r/issues/7', github), { kind: 'ticket', id: '7' });
});

test('releases and tags open the release page', () => {
  assert.deepStrictEqual(linkTarget('https://github.com/o/r/releases/tag/v1.2.0', github), { kind: 'release', tag: 'v1.2.0' });
  assert.deepStrictEqual(linkTarget('https://dev.azure.com/Org/Proj/_git/repo?version=GT3.7.1', azure), { kind: 'release', tag: '3.7.1' });
});

test('anything else opens in the browser', () => {
  assert.strictEqual(linkTarget('https://dev.azure.com/Org/Proj/_build/results?buildId=4', azure), undefined);
  assert.strictEqual(linkTarget('https://github.com/o/r/commit/abc', github), undefined);
  assert.strictEqual(linkTarget('https://example.com/pull/3', undefined), undefined);
});

const gitlab = {
  kind: 'gitlab',
  pullRequestUrl: (id) => `https://gitlab.com/g/r/-/merge_requests/${id}`,
  ticketUrl: (id) => `https://gitlab.com/g/r/-/issues/${id}`,
  releaseUrl: (tag) => `https://gitlab.com/g/r/-/releases/${encodeURIComponent(tag)}`,
};

test('GitLab merge requests, issues and releases open Gitland pages', () => {
  assert.deepStrictEqual(linkTarget('https://gitlab.com/g/r/-/merge_requests/42', gitlab), { kind: 'pr', id: '42' });
  assert.deepStrictEqual(linkTarget('https://gitlab.com/g/r/-/issues/7#note_1', gitlab), { kind: 'ticket', id: '7' });
  assert.deepStrictEqual(linkTarget('https://gitlab.com/g/r/-/releases/v1.0', gitlab), { kind: 'release', tag: 'v1.0' });
  assert.strictEqual(linkTarget('https://gitlab.com/other/r/-/issues/7', gitlab), undefined);
});

test('Jira browse links on a configured site open the ticket page', () => {
  const p = { ...github, ticketKeys: { DATA: 'https://acme.atlassian.net', OPS: 'https://jira.corp.com/jira' } };
  assert.deepStrictEqual(linkTarget('https://acme.atlassian.net/browse/DATA-7?focused=1', p), { kind: 'ticket', id: 'DATA-7', org: 'https://acme.atlassian.net' });
  assert.deepStrictEqual(linkTarget('https://Jira.corp.com/jira/browse/OPS-2', p), { kind: 'ticket', id: 'OPS-2', org: 'https://jira.corp.com/jira' });
  assert.strictEqual(linkTarget('https://other.atlassian.net/browse/DATA-7', p), undefined);
  assert.strictEqual(linkTarget('https://acme.atlassian.net/browse/NOPE-7', p), undefined);
});
