// The Jira REST client (src/providers/jira.ts) with VS Code and fetch stubbed.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');

const entry = path.join(__dirname, '../../src/providers/jira.ts');
const { outputFiles } = esbuild.buildSync({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false,
  alias: { vscode: path.join(__dirname, 'vscodeStub.js') },
});
const mod = new Module(entry);
mod._compile(outputFiles[0].text, entry);
const { JiraTickets, jiraSources, jiraTokenKey } = mod.exports;

const site = 'https://jira.corp.com';
const secrets = { m: new Map([[jiraTokenKey(site), JSON.stringify({ token: 'PAT' })]]), get(k) { return Promise.resolve(this.m.get(k)); } };
const calls = [];
globalThis.fetch = async (url, o) => {
  calls.push(`${o.method} ${String(url).replace(`${site}/rest/api/2`, '')}`);
  const body = /\/comment\?/.test(url) ? { comments: [] } : /\/transitions$/.test(url) ? { transitions: [] } : { key: 'DATA-12', fields: { summary: 'S', issuetype: { name: 'Task' }, status: { name: 'Open' }, project: { key: 'DATA' } } };
  return new Response(JSON.stringify(body), { status: 200 });
};

test('bare numbers and lower-case keys are the configured project\'s issue on every call', async () => {
  const j = new JiraTickets([{ type: 'jira', site, project: 'DATA' }], secrets);
  calls.length = 0;
  await j.getTicketDetails('12');
  await j.ticketStates('data-12');
  await j.commentTicket('#12', 'x');
  assert.deepStrictEqual(calls, [
    'GET /issue/DATA-12?expand=renderedFields', 'GET /issue/DATA-12/comment?expand=renderedBody&orderBy=created',
    'GET /issue/DATA-12/transitions', 'POST /issue/DATA-12/comment',
  ]);
});

test('jiraSources skips entries with a malformed site', () => {
  globalThis.__sources = [{ type: 'jira', site: 'acme atlassian', project: 'X' }, { type: 'jira', site, project: 'DATA' }, { organization: 'o', project: 'p' }];
  assert.deepStrictEqual(jiraSources().map((s) => s.project), ['DATA']);
  assert.doesNotThrow(() => new JiraTickets(jiraSources(), secrets));
});
