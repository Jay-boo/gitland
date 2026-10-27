// Jira mappings (src/providers/jiraMap.pure.ts) and the ticket id prefix (src/providers/ticketPrefix.pure.ts).
const test = require('node:test');
const assert = require('node:assert');
const {
  isJiraSource, jiraFlavour, normalizeSite, apiBase, parseTicketId, myTicketsJql, searchJql,
  toTicket, mergeTickets, toDetails, adfBody, jiraErrorMessage, jiraKeysIn, jiraKeyFromBranch,
} = require('../../out/unit/jiraMap.js');
const { ticketPrefix, ticketLabel, mentionGrep, closesHostWorkItems } = require('../../out/unit/ticketPrefix.js');

test('jiraFlavour', () => {
  assert.strictEqual(jiraFlavour('https://acme.atlassian.net'), 'cloud');
  assert.strictEqual(jiraFlavour('https://jira.corp.com/jira'), 'server');
});

test('normalizeSite keeps a context path', () => {
  assert.strictEqual(normalizeSite(' ACME.atlassian.net/ '), 'https://acme.atlassian.net');
  assert.strictEqual(normalizeSite('https://Jira.Corp.com/jira/'), 'https://jira.corp.com/jira');
  assert.strictEqual(apiBase('https://jira.corp.com/jira'), 'https://jira.corp.com/jira/rest/api/2');
  assert.strictEqual(apiBase('https://acme.atlassian.net'), 'https://acme.atlassian.net/rest/api/3');
});

test('parseTicketId', () => {
  assert.strictEqual(parseTicketId('data-12', ['DATA']), 'DATA-12');
  assert.strictEqual(parseTicketId('OPS_2-7', ['DATA']), 'OPS_2-7');
  assert.strictEqual(parseTicketId('#12', ['DATA', 'OPS']), 'DATA-12');
  assert.strictEqual(parseTicketId('12', []), undefined);
  assert.strictEqual(parseTicketId('fix login', ['DATA']), undefined);
});

test('myTicketsJql', () => {
  assert.strictEqual(myTicketsJql('DATA'), 'project = "DATA" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
});

test('searchJql escapes quotes and backslashes', () => {
  assert.strictEqual(searchJql(['DATA', 'OPS'], 'say "hi" \\ now'), 'project in ("DATA", "OPS") AND text ~ "say \\"hi\\" \\\\ now" ORDER BY updated DESC');
});

test('toTicket', () => {
  const t = toTicket(
    { key: 'DATA-3', fields: { summary: 'Login', issuetype: { name: 'Story' }, status: { name: 'To Do' }, assignee: { displayName: 'Jay' }, project: { key: 'DATA' }, updated: '2026-10-01T10:00:00.000+0000' } },
    'https://acme.atlassian.net',
  );
  assert.deepStrictEqual({ ...t, updated: undefined }, {
    id: 'DATA-3', title: 'Login', type: 'Story', state: 'To Do', assignee: 'Jay', url: 'https://acme.atlassian.net/browse/DATA-3',
    org: 'https://acme.atlassian.net', project: 'DATA', updated: undefined,
  });
  assert.strictEqual(t.updated, Date.parse('2026-10-01T10:00:00.000+0000'));
});

test('mergeTickets sorts by updated and keeps survivors', () => {
  const m = mergeTickets([[{ id: 'A-1', updated: 1 }], [], [{ id: 'B-1', updated: 5 }]]);
  assert.deepStrictEqual(m.map((t) => t.id), ['B-1', 'A-1']);
});

test('toDetails', () => {
  const d = toDetails(
    {
      key: 'DATA-3',
      fields: {
        summary: 'S', issuetype: { name: 'Bug' }, status: { name: 'Open' }, project: { key: 'DATA' }, priority: { name: 'High' }, reporter: { displayName: 'Ann' },
        labels: ['ui'], components: [{ name: 'web' }], fixVersions: [{ name: '1.2' }], duedate: '2026-11-01',
        customfield_10020: [{ id: 1, name: 'Sprint 6', state: 'closed' }, { id: 2, name: 'Sprint 7', state: 'active' }],
        parent: { key: 'DATA-1' }, subtasks: [{ key: 'DATA-4' }],
        issuelinks: [{ type: { outward: 'blocks', inward: 'is blocked by' }, outwardIssue: { key: 'OPS-9' } }, { type: { outward: 'blocks', inward: 'is blocked by' }, inwardIssue: { key: 'OPS-8' } }],
        updated: '2026-10-02T00:00:00.000+0000',
      },
      renderedFields: { description: '<p>Hi</p>' },
    },
    [{ author: { displayName: 'Bob' }, created: '2026-10-01T00:00:00.000+0000', renderedBody: '<p>ok</p>' }],
    'https://acme.atlassian.net',
  );
  assert.strictEqual(d.format, 'html');
  assert.strictEqual(d.description, '<p>Hi</p>');
  assert.strictEqual(d.ticket.id, 'DATA-3');
  assert.deepStrictEqual(d.fields.map((f) => f.label), ['Status', 'Priority', 'Reporter', 'Sprint', 'Fix versions', 'Due date']);
  assert.strictEqual(d.fields.find((f) => f.label === 'Sprint').value, 'Sprint 7');
  assert.deepStrictEqual(d.tags, ['ui', 'web']);
  assert.deepStrictEqual(d.related.map((r) => [r.id, r.kind]), [['DATA-1', 'parent'], ['DATA-4', 'child'], ['OPS-9', 'blocks'], ['OPS-8', 'is blocked by']]);
  assert.strictEqual(d.related[2].url, 'https://acme.atlassian.net/browse/OPS-9');
  assert.deepStrictEqual(d.comments, [{ author: 'Bob', date: Date.parse('2026-10-01T00:00:00.000+0000'), body: '<p>ok</p>' }]);
  assert.deepStrictEqual(d.pullRequests, []);
  assert.strictEqual(d.changed, Date.parse('2026-10-02T00:00:00.000+0000'));
});

test('toDetails reads a Server sprint string', () => {
  const d = toDetails(
    { key: 'X-1', fields: { summary: 'S', issuetype: { name: 'Task' }, status: { name: 'Open' }, project: { key: 'X' }, customfield_10100: ['com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=3,rapidViewId=1,state=ACTIVE,name=Sprint 9,startDate=2026-10-01]'] } },
    [],
    'https://jira.corp.com',
  );
  assert.strictEqual(d.fields.find((f) => f.label === 'Sprint').value, 'Sprint 9');
});

test('toDetails tolerates missing fields', () => {
  const d = toDetails({ key: 'X-1', fields: { summary: 'S', issuetype: { name: 'Task' }, status: { name: 'Open' }, project: { key: 'X' }, description: null, assignee: null } }, [], 'https://jira.corp.com');
  assert.strictEqual(d.description, undefined);
  assert.deepStrictEqual(d.fields.map((f) => f.label), ['Status']);
  assert.deepStrictEqual([d.tags, d.related, d.comments], [[], [], []]);
});

test('toDetails falls back to a plain comment body', () => {
  const d = toDetails({ key: 'X-1', fields: { summary: 'S', issuetype: { name: 'Task' }, status: { name: 'Open' }, project: { key: 'X' } } }, [{ author: { displayName: 'B' }, created: '2026-10-01T00:00:00.000+0000', body: 'a <b>' }], 'https://jira.corp.com');
  assert.strictEqual(d.comments[0].body, 'a &lt;b&gt;');
});

test('adfBody: one paragraph per line', () => {
  assert.deepStrictEqual(adfBody('a\nb'), {
    type: 'doc', version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }],
  });
  assert.deepStrictEqual(adfBody('a\n\nb').content[1], { type: 'paragraph', content: [] });
});

test('jiraErrorMessage', () => {
  assert.strictEqual(jiraErrorMessage({ errorMessages: ['Issue does not exist'] }), 'Issue does not exist');
  assert.strictEqual(jiraErrorMessage({ errorMessages: [], errors: { summary: 'required' } }), 'summary: required');
  assert.strictEqual(jiraErrorMessage({ message: 'nope' }), 'nope');
  assert.strictEqual(jiraErrorMessage(undefined), undefined);
});

test('isJiraSource', () => {
  assert.strictEqual(isJiraSource({ type: 'jira', site: 's', project: 'P' }), true);
  assert.strictEqual(isJiraSource({ organization: 'o', project: 'p' }), false);
});

test('ticketPrefix', () => {
  assert.strictEqual(ticketPrefix({ kind: 'azure' }), 'AB#');
  assert.strictEqual(ticketPrefix({ kind: 'github' }), '#');
  assert.strictEqual(ticketPrefix({ kind: 'gitlab' }), '#');
  assert.strictEqual(ticketPrefix({ kind: 'azure', ticketKind: 'jira' }), '');
  assert.strictEqual(ticketPrefix(undefined), 'AB#');
});

test('jiraKeysIn: configured keys, first appearance order, no duplicates', () => {
  assert.deepStrictEqual(jiraKeysIn('OPS-2 and DATA-1, again OPS-2; UTF-8 XDATA-3 /browse/DATA-9', ['DATA', 'OPS']), ['OPS-2', 'DATA-1']);
  assert.deepStrictEqual(jiraKeysIn('DATA-1', []), []);
});

test('jiraKeyFromBranch', () => {
  assert.strictEqual(jiraKeyFromBranch('feature/DATA-123-fix-login', ['DATA']), 'DATA-123');
  assert.strictEqual(jiraKeyFromBranch('fix/data-7', ['DATA']), 'DATA-7');
  assert.strictEqual(jiraKeyFromBranch('feature/OPS-1-x', ['DATA']), undefined);
  assert.strictEqual(jiraKeyFromBranch('feature/123-x', ['DATA']), undefined);
});

test('ticketLabel: #12 for numbers, keys as they are', () => {
  assert.strictEqual(ticketLabel('12'), '#12');
  assert.strictEqual(ticketLabel('DATA-12'), 'DATA-12');
});

test('mentionGrep: git log pattern for commits that mention a ticket', () => {
  const re = (id, p) => new RegExp(mentionGrep(id, p));
  assert.ok(re('12', { kind: 'azure' }).test('fix AB#12 now'));
  assert.ok(!re('12', { kind: 'azure' }).test('fix AB#123'));
  const jira = { kind: 'github', ticketKind: 'jira' };
  assert.ok(re('DATA-12', jira).test('DATA-12: fix'));
  assert.ok(re('DATA-12', jira).test('fix (DATA-12)'));
  assert.ok(!re('DATA-12', jira).test('XDATA-12 fix'));
  assert.ok(!re('DATA-12', jira).test('DATA-123'));
  assert.ok(!mentionGrep('DATA-12', jira).includes('(?'), 'git -E has no lookbehind');
});

test('closesHostWorkItems: only Azure DevOps with its own work items', () => {
  assert.strictEqual(closesHostWorkItems({ kind: 'azure' }), true);
  assert.strictEqual(closesHostWorkItems({ kind: 'azure', ticketKind: 'jira' }), false);
  assert.strictEqual(closesHostWorkItems({ kind: 'github' }), false);
});
