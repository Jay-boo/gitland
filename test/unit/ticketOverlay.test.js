// Jira tickets over a code host (src/providers/ticketOverlay.ts).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');

const entry = path.join(__dirname, '../../src/providers/ticketOverlay.ts');
const { outputFiles } = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false });
const mod = new Module(entry);
mod._compile(outputFiles[0].text, entry);
const { TicketOverlay, withKey } = mod.exports;

const fakes = () => {
  const host = {
    kind: 'github',
    displayName: 'GitHub · o/r',
    ticketNoun: 'issue',
    isSignedIn: async () => true,
    listMyTickets: async () => [{ id: '1' }],
    pullRequestUrl: (id) => `https://github.com/o/r/pull/${id}`,
    ticketUrl: (id) => `https://github.com/o/r/issues/${id}`,
    listPullRequests: async () => [{ id: '3' }],
    createPullRequest: async (o) => ((host.created = o), { id: '9' }),
  };
  const tickets = {
    ticketKind: 'jira',
    ticketNoun: 'issue',
    ticketSourceLabel: 'Jira · DATA',
    ticketKeys: { DATA: 'https://acme.atlassian.net' },
    isSignedIn: async () => false,
    listMyTickets: async () => [{ id: 'DATA-1' }],
    ticketUrl: (id) => `https://acme.atlassian.net/browse/${id}`,
  };
  return { host, tickets };
};

test('ticket members go to Jira, the rest to the host', async () => {
  const { host, tickets } = fakes();
  const o = new TicketOverlay(host, tickets);
  assert.strictEqual(o.kind, 'github');
  assert.strictEqual(o.displayName, 'GitHub · o/r');
  assert.strictEqual(o.ticketNoun, 'issue');
  assert.strictEqual(o.ticketKind, 'jira');
  assert.strictEqual(o.ticketSourceLabel, 'Jira · DATA');
  assert.deepStrictEqual(o.ticketKeys, { DATA: 'https://acme.atlassian.net' });
  assert.deepStrictEqual(await o.listMyTickets(), [{ id: 'DATA-1' }]);
  assert.strictEqual(o.ticketUrl('DATA-1'), 'https://acme.atlassian.net/browse/DATA-1');
  assert.strictEqual(o.pullRequestUrl('3'), 'https://github.com/o/r/pull/3');
  assert.deepStrictEqual(await o.listPullRequests(), [{ id: '3' }]);
  assert.strictEqual(await o.isSignedIn(), true);
  assert.strictEqual(await o.ticketsSignedIn(), false);
  // Members Jira does not have stay undefined rather than falling back to the host's tickets.
  assert.strictEqual(o.getTicketDetails, undefined);
});

test('createPullRequest puts the key in the title and sends no ticket ids', async () => {
  const { host, tickets } = fakes();
  await new TicketOverlay(host, tickets).createPullRequest({ source: 'b', target: 'main', title: 'Fix login', description: '', draft: true, ticketIds: ['DATA-1'] });
  assert.deepStrictEqual([host.created.title, host.created.ticketIds], ['DATA-1: Fix login', []]);
});

test('withKey', () => {
  assert.strictEqual(withKey('DATA-1 fix', 'DATA-1'), 'DATA-1 fix');
  assert.strictEqual(withKey('fix data-1', 'DATA-1'), 'fix data-1');
  assert.strictEqual(withKey('fix', undefined), 'fix');
});

test('hostOf unwraps the overlay', () => {
  const { host, tickets } = fakes();
  assert.strictEqual(mod.exports.hostOf(new TicketOverlay(host, tickets)), host);
  assert.strictEqual(mod.exports.hostOf(host), host);
  assert.strictEqual(mod.exports.hostOf(undefined), undefined);
});

test('pull request work items are the Jira keys of its title and description', async () => {
  const { host, tickets } = fakes();
  host.getPullRequestDetails = async () => ({ pr: { title: 'DATA-1: login' }, description: 'also OPS-2, #4', workItems: [{ id: '4', url: 'x' }] });
  const d = await new TicketOverlay(host, { ...tickets, ticketKeys: { DATA: 'https://a', OPS: 'https://b' } }).getPullRequestDetails('9');
  assert.deepStrictEqual(d.workItems, [{ id: 'DATA-1', url: 'https://a/browse/DATA-1' }, { id: 'OPS-2', url: 'https://b/browse/OPS-2' }]);
});
