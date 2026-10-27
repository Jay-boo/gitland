# Jira Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jira (Cloud and Server / Data Center) as a ticket source for any repository (Azure DevOps, GitHub, GitLab), replacing the host's tickets when configured.

**Architecture:** A pure mapping module (`jiraMap.pure.ts`) holds every Jira rule that can be tested without VS Code. `JiraTickets` (`jira.ts`) is the REST client for the ticket members of `Provider`. `TicketOverlay` wraps the host provider, sending ticket members to `JiraTickets` and the rest to the host. `getProvider` returns the overlay when `gitland.tickets.sources` has Jira entries.

**Tech Stack:** TypeScript, VS Code API 1.85, `fetch`, esbuild, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-27-jira-support-design.md`

## Global Constraints

- No new dependency. REST via `fetch`, shaped like `src/providers/gitlab.ts` (`request<T>`, `once` for a single prompt).
- Cloud = site host ends with `.atlassian.net` → `/rest/api/3`, `Authorization: Basic base64(email:token)`. Everything else = Server → `/rest/api/2`, `Authorization: Bearer <PAT>`.
- Secret key `gitland.jira.token:<site>` (normalized site), value JSON `{ "email"?: string, "token": string }`.
- Default JQL: `project = "<KEY>" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`.
- Ticket URL: `<site>/browse/<KEY-n>`. Ticket `org` = site, `project` = project key, `id` = issue key.
- Jira replaces host tickets when any Jira source is configured; PRs / pipelines stay on the host.
- `findLinks` (src/links.ts) and `linksIn` (media/graph.js) stay identical in behaviour.
- Commits as Jay-boo, **no** Co-Authored-By trailer (user rule).
- Webview CSP: no inline `style=""` in any new webview markup.

## Review Focus

- Server / DC sites under a context path (`https://jira.corp.com/jira/`): the path must be kept, only the trailing `/` dropped → Task 1 test `normalizeSite keeps a context path`.
- Keys that look like keys but are not configured (`UTF-8`, `SHA-256`, `XDATA-1` inside a word): never linked → Task 4 test `only configured keys, whole words`.
- Search text with `"` or `\`: JQL must stay valid → Task 1 test `searchJql escapes quotes and backslashes`.
- One source failing (no token for one site, deleted project): the other sources' tickets still show, failure logged → Task 2 step `listMyTickets uses Promise.allSettled` + Task 1 test `mergeTickets sorts by updated and keeps survivors`.
- Issue with no description / no renderedFields / no assignee (common on Server): mapping must not throw → Task 1 test `toDetails tolerates missing fields`.

---

### Task 1: Pure Jira mapping

**Files:**
- Create: `src/providers/jiraMap.pure.ts`
- Modify: `src/providers/types.ts` (TicketSource union)
- Test: `test/unit/jira.test.js`

**Interfaces:**
- Produces (types.ts):
  - `interface AzureTicketSource { type?: 'azure'; organization: string; project: string; wiql?: string }`
  - `interface JiraTicketSource { type: 'jira'; site: string; project: string; jql?: string }`
  - `type TicketSource = AzureTicketSource | JiraTicketSource`
  - `Provider` gains `readonly ticketKind?: 'jira'` and `readonly ticketKeys?: Record<string, string>` (KEY → site).
- Produces (jiraMap.pure.ts):
  - `isJiraSource(s: TicketSource): s is JiraTicketSource`
  - `type JiraFlavour = 'cloud' | 'server'`; `jiraFlavour(site: string): JiraFlavour`
  - `normalizeSite(input: string): string` — trims, adds `https://` when no scheme, lower-cases scheme + host, keeps the path, drops trailing `/`.
  - `apiBase(site: string): string` — `<site>/rest/api/3` or `/2`.
  - `parseTicketId(text: string, keys: string[]): string | undefined` — `data-12` → `DATA-12`; `12` / `#12` → `<keys[0]>-12` (undefined when no keys); else undefined.
  - `keyOf(id: string): string` — `DATA-12` → `DATA`.
  - `myTicketsJql(project: string): string`; `jqlString(text: string): string` (quoted, escaped); `searchJql(keys: string[], text: string): string`.
  - `TICKET_FIELDS = 'summary,issuetype,status,assignee,project,updated'`
  - `toTicket(issue: JiraIssue, site: string): Ticket & { updated?: number }`
  - `mergeTickets(lists: (Ticket & { updated?: number })[][]): Ticket[]`
  - `toDetails(issue: JiraIssue, comments: JiraComment[], site: string): TicketDetails`
  - `adfBody(text: string): unknown`
  - `jiraErrorMessage(body: unknown): string | undefined`
  - `JiraIssue` / `JiraComment`: loose interfaces of the REST fields used (`key`, `fields`, `renderedFields?`, comment `author.displayName`, `created`, `renderedBody?`, `body?`).
- Produces (`src/providers/ticketPrefix.pure.ts`): `ticketPrefix(p: { kind: string; ticketKind?: 'jira' } | undefined): string` → `''` for Jira, `'#'` for github / gitlab, else `'AB#'`.

- [ ] **Step 1: Write the failing tests** in `test/unit/jira.test.js` (style of `gitlab.test.js`, requiring `../../out/unit/jiraMap.js` and `../../out/unit/ticketPrefix.js`):

```js
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
  const t = toTicket({ key: 'DATA-3', fields: { summary: 'Login', issuetype: { name: 'Story' }, status: { name: 'To Do' }, assignee: { displayName: 'Jay' }, project: { key: 'DATA' }, updated: '2026-10-01T10:00:00.000+0000' } }, 'https://acme.atlassian.net');
  assert.deepStrictEqual({ ...t, updated: undefined }, { id: 'DATA-3', title: 'Login', type: 'Story', state: 'To Do', assignee: 'Jay', url: 'https://acme.atlassian.net/browse/DATA-3', org: 'https://acme.atlassian.net', project: 'DATA', updated: undefined });
  assert.strictEqual(t.updated, Date.parse('2026-10-01T10:00:00.000+0000'));
});
test('mergeTickets sorts by updated and keeps survivors', () => {
  const m = mergeTickets([[{ id: 'A-1', updated: 1 }], [], [{ id: 'B-1', updated: 5 }]]);
  assert.deepStrictEqual(m.map((t) => t.id), ['B-1', 'A-1']);
});
test('toDetails', () => {
  const d = toDetails({
    key: 'DATA-3',
    fields: { summary: 'S', issuetype: { name: 'Bug' }, status: { name: 'Open' }, project: { key: 'DATA' }, priority: { name: 'High' }, reporter: { displayName: 'Ann' },
      labels: ['ui'], components: [{ name: 'web' }], fixVersions: [{ name: '1.2' }], duedate: '2026-11-01',
      customfield_10020: [{ id: 1, name: 'Sprint 7', state: 'active' }],
      parent: { key: 'DATA-1' }, subtasks: [{ key: 'DATA-4' }],
      issuelinks: [{ type: { outward: 'blocks', inward: 'is blocked by' }, outwardIssue: { key: 'OPS-9' } }], updated: '2026-10-02T00:00:00.000+0000' },
    renderedFields: { description: '<p>Hi</p>' },
  }, [{ author: { displayName: 'Bob' }, created: '2026-10-01T00:00:00.000+0000', renderedBody: '<p>ok</p>' }], 'https://acme.atlassian.net');
  assert.strictEqual(d.format, 'html');
  assert.strictEqual(d.description, '<p>Hi</p>');
  assert.deepStrictEqual(d.fields.map((f) => f.label), ['Status', 'Priority', 'Reporter', 'Sprint', 'Fix versions', 'Due date']);
  assert.strictEqual(d.fields.find((f) => f.label === 'Sprint').value, 'Sprint 7');
  assert.deepStrictEqual(d.tags, ['ui', 'web']);
  assert.deepStrictEqual(d.related.map((r) => [r.id, r.kind]), [['DATA-1', 'parent'], ['DATA-4', 'child'], ['OPS-9', 'blocks']]);
  assert.strictEqual(d.related[2].url, 'https://acme.atlassian.net/browse/OPS-9');
  assert.deepStrictEqual(d.comments, [{ author: 'Bob', date: Date.parse('2026-10-01T00:00:00.000+0000'), body: '<p>ok</p>' }]);
  assert.deepStrictEqual(d.pullRequests, []);
});
test('toDetails tolerates missing fields', () => {
  const d = toDetails({ key: 'X-1', fields: { summary: 'S', issuetype: { name: 'Task' }, status: { name: 'Open' }, project: { key: 'X' }, description: null, assignee: null } }, [], 'https://jira.corp.com');
  assert.strictEqual(d.description, undefined);
  assert.deepStrictEqual(d.fields.map((f) => f.label), ['Status']);
});
test('adfBody: one paragraph per line', () => {
  assert.deepStrictEqual(adfBody('a\nb'), { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] });
  assert.deepStrictEqual(adfBody('a\n\nb').content[1], { type: 'paragraph', content: [] });
});
test('jiraErrorMessage', () => {
  assert.strictEqual(jiraErrorMessage({ errorMessages: ['Issue does not exist'] }), 'Issue does not exist');
  assert.strictEqual(jiraErrorMessage({ errorMessages: [], errors: { summary: 'required' } }), 'summary: required');
  assert.strictEqual(jiraErrorMessage({ message: 'nope' }), 'nope');
});
test('isJiraSource', () => {
  assert.strictEqual(isJiraSource({ type: 'jira', site: 's', project: 'P' }), true);
  assert.strictEqual(isJiraSource({ organization: 'o', project: 'p' }), false);
});
test('ticketPrefix', () => {
  assert.strictEqual(ticketPrefix({ kind: 'azure' }), 'AB#');
  assert.strictEqual(ticketPrefix({ kind: 'github' }), '#');
  assert.strictEqual(ticketPrefix({ kind: 'azure', ticketKind: 'jira' }), '');
  assert.strictEqual(ticketPrefix(undefined), 'AB#');
});
```

Sprint detection: the first `customfield_*` whose value is a non-empty array of objects with `name` and `state`; value = the `active` sprint's name, else the last one's. On Server the sprint field may be strings like `com.atlassian…Sprint@1[…,name=Sprint 7,…]` → extract `name=([^,\]]+)`; add an assertion for that form in the `toDetails` test.

- [ ] **Step 2: Run** `npm run test:unit` → the new tests FAIL (module not found).
- [ ] **Step 3: Implement** `jiraMap.pure.ts`, `ticketPrefix.pure.ts`, the types.ts union. `AzureDevOpsProvider.ticketSources` filters with `!isJiraSource(t)` and narrows to `AzureTicketSource`; `ticketSources.ts` narrows the same way, so `npm run typecheck` passes.
- [ ] **Step 4: Run** `npm run test:unit && npm run typecheck` → all PASS.
- [ ] **Step 5: Commit** `feat(jira): ticket source types and pure Jira mappings`.

---

### Task 2: `JiraTickets` REST client and token command

**Files:**
- Create: `src/providers/jira.ts`
- Modify: `src/extension.ts` (register `gitland.setJiraToken`), `package.json` (command contribution)

**Interfaces:**
- Consumes: everything in Task 1.
- Produces:
  - `jiraTokenKey(site: string): string` → `gitland.jira.token:<normalizeSite(site)>`
  - `promptJiraToken(site: string, secrets: vscode.SecretStorage): Promise<boolean>` — Cloud: email input then password input; Server: password input. Button "Create token" (`$(link-external)`) opens the URLs from the spec. Empty token → delete the secret, return false.
  - `setJiraToken(sites: string[], secrets): Promise<void>` — the command: quick pick of `sites` plus "Other site…" (input box), then `promptJiraToken`.
  - `class JiraTickets` with `constructor(sources: JiraTicketSource[], secrets: vscode.SecretStorage)` and:
    `ticketKind = 'jira'`, `ticketNoun = 'issue'`, `ticketSourceLabel` (`Jira · DATA, OPS`), `ticketKeys: Record<string, string>`, `sites: string[]`,
    `isSignedIn()`, `listMyTickets()`, `searchTickets(text)`, `getTicket(id, org?)`, `getTicketDetails(id, org?)`, `activateTicket(id, org?)`,
    `ticketStates(id, org?)`, `setTicketState(id, state, org?)`, `assignTicketToMe(id, org?)`, `commentTicket(id, text, org?)`, `ticketUrl(id)`.
  - Site for an id: `org` when given, else `ticketKeys[keyOf(id)]`, else `sites[0]`.

- [ ] **Step 1: Implement `jira.ts`** following `gitlab.ts`:
  - `private request<T>(site, method, path, body?)` → `fetch(apiBase(site) + path)` with the auth header, `Accept` / `Content-Type: application/json`. 204 → `undefined`. 401 → `AuthError('Jira rejected the token for <site>. Run "Gitland: Set Jira Token".')`. 403 on `/myself` → same AuthError. Other non-OK → `Error('Jira: ' + (jiraErrorMessage(json) ?? status))`. A missing token prompts once per site (`once` from `gitlabMap.pure.ts`); cancelled → `AuthError('Jira sign-in cancelled', true)`.
  - Search: Cloud `POST /search/jql` `{ jql, fields: TICKET_FIELDS.split(','), maxResults: 50 }`; Server `POST /search` with the same body.
  - `listMyTickets` uses `Promise.allSettled` over sources (`jql ?? myTicketsJql(project)`), logs each rejection with `log.error('Tickets from Jira <KEY> failed', …)`, throws only when every source failed (the first reason), returns `mergeTickets(fulfilled)`.
  - `searchTickets`: `parseTicketId` hit → `[getTicket]` (dropping undefined); else `searchJql` per site over that site's keys, merged.
  - `getTicket`: `GET /issue/<KEY>?fields=<TICKET_FIELDS>`; 404 → undefined.
  - `getTicketDetails`: issue `?expand=renderedFields` and `/comment?expand=renderedBody&orderBy=created` in parallel → `toDetails`.
  - `ticketStates` / `setTicketState` / `activateTicket` (first transition with `to.statusCategory.key === 'indeterminate'`; none → no-op) / `assignTicketToMe` (`me()` cached per site from `GET /myself`) / `commentTicket` (`adfBody` on Cloud, plain string on Server) as in the spec.
- [ ] **Step 2: Register the command** `gitland.setJiraToken` ("Gitland: Set Jira Token", category Gitland) in package.json `contributes.commands` and in `extension.ts`, calling `setJiraToken` with the Jira sites from `gitland.tickets.sources`, then refreshing the Tickets view (same as `gitland.setGitLabToken` does).
- [ ] **Step 3: Run** `npm run typecheck && npm run test:unit` → PASS.
- [ ] **Step 4: Commit** `feat(jira): Jira REST client and token sign-in`.

---

### Task 3: `TicketOverlay` and provider wiring

**Files:**
- Create: `src/providers/ticketOverlay.ts` (imports **types only**, so the test can bundle it)
- Modify: `src/providers/index.ts`, `src/views/ticketsView.ts`, `src/views/pipelinesView.ts`, `src/views/dashboardPanel.ts` (callers of `signIn`)
- Test: `test/unit/ticketOverlay.test.js` (esbuild-bundled like `links.test.js`)

**Interfaces:**
- Consumes: `Provider`, `CreatePullRequestOptions` (types.ts); `JiraTickets` public members (Task 2) through a structural type `TicketBackend = Pick<Provider, 'ticketNoun' | 'ticketSourceLabel' | 'ticketKind' | 'ticketKeys' | 'isSignedIn' | 'listMyTickets' | 'searchTickets' | 'getTicket' | 'getTicketDetails' | 'activateTicket' | 'ticketStates' | 'setTicketState' | 'assignTicketToMe' | 'commentTicket' | 'ticketUrl'>`.
- Produces:
  - `class TicketOverlay implements Provider` — `constructor(readonly host: Provider, readonly tickets: TicketBackend)`. `kind`, `displayName`, all PR / pipeline / avatar / URL members → host; ticket members → tickets. `isSignedIn()` → the **host's** (PR / pipeline views); `ticketsSignedIn()` → the tickets'.
  - `createPullRequest(o)` → `host.createPullRequest({ ...o, ticketIds: [], title: withKey(o.title, o.ticketIds[0]) })`; `withKey(title, key?)` exported: prefixes `KEY: ` unless the title already contains the key (case-insensitive), no key → unchanged.
  - `signIn(provider: Provider, part: 'host' | 'tickets' = 'host'): { command: string; host: string }` in `index.ts` (was `signIn(kind)`); `part === 'tickets'` with `provider.ticketKind === 'jira'` → `{ command: 'gitland.setJiraToken', host: 'Jira' }`.
  - `getProvider` reads `tickets.sources` with `getConfiguration('gitland', repo.root uri)`, keeps the Jira entries, normalizes their sites, wraps the host provider in `new TicketOverlay(host, new JiraTickets(jira, secrets))` when there are any. The cache key appends `JSON.stringify(jira)`.

- [ ] **Step 1: Write the failing test** `test/unit/ticketOverlay.test.js`:

```js
test('ticket members go to Jira, the rest to the host', async () => {
  const o = new TicketOverlay(host, tickets);
  assert.strictEqual(o.kind, 'github');
  assert.strictEqual(o.ticketNoun, 'issue');
  assert.strictEqual(o.ticketKind, 'jira');
  assert.deepStrictEqual(await o.listMyTickets(), [{ id: 'DATA-1' }]);
  assert.strictEqual(o.ticketUrl('DATA-1'), 'https://acme.atlassian.net/browse/DATA-1');
  assert.strictEqual(o.pullRequestUrl('3'), 'https://github.com/o/r/pull/3');
});
test('createPullRequest puts the key in the title and sends no ticket ids', async () => {
  await new TicketOverlay(host, tickets).createPullRequest({ source: 'b', target: 'main', title: 'Fix login', description: '', draft: true, ticketIds: ['DATA-1'] });
  assert.deepStrictEqual([host.created.title, host.created.ticketIds], ['DATA-1: Fix login', []]);
});
test('withKey', () => {
  assert.strictEqual(withKey('DATA-1 fix', 'DATA-1'), 'DATA-1 fix');
  assert.strictEqual(withKey('fix data-1', 'DATA-1'), 'fix data-1');
  assert.strictEqual(withKey('fix', undefined), 'fix');
});
```
(`host` / `tickets` are small fakes defined at the top of the test; `host.createPullRequest` stores its argument in `host.created`.)

- [ ] **Step 2: Run** `npm run test:unit` → FAIL.
- [ ] **Step 3: Implement** the overlay and the `getProvider` / `signIn` changes. Tickets view: the signed-in check uses `'ticketsSignedIn' in provider ? provider.ticketsSignedIn() : provider.isSignedIn()`, and the sign-in command and host use `signIn(provider, 'tickets')`. The "Tickets come from the remote of this repository" empty-state text is unchanged. Other `signIn` callers pass the provider.
- [ ] **Step 4: Run** `npm run test:unit && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(jira): ticket overlay over the code host`.

---

### Task 4: Jira keys in commit links and link routing

**Files:**
- Modify: `src/links.ts`, `media/graph.js` (`linksIn`, `linkChips`), `src/linkTarget.pure.ts`, webview `links:` payloads in `src/graph/graphPanel.ts:317`, `src/views/historyPanel.ts:95`, `src/views/comparePanel.ts:148`, `src/views/releasePanel.ts:155`
- Test: `test/unit/links.test.js`, `test/unit/linkTarget.test.js`

**Interfaces:**
- Consumes: `Provider.ticketKeys` (Task 1).
- Produces: `LinkUrls.ticketKeys?: Record<string, string>`; webview payload `links: { kind, pr, ticket, ticketKeys? }`.

- [ ] **Step 1: Write the failing tests.** In `links.test.js`, with `jira = { ...github, ticketKind: 'jira', ticketKeys: { DATA: 'https://acme.atlassian.net', OPS: 'https://jira.corp.com/jira' } }`:

```js
test('Jira: only configured keys, whole words', () => {
  assert.deepStrictEqual(findLinks('DATA-12 fix UTF-8 and SHA-256, XDATA-3, see OPS-4', jira).map((l) => [l.kind, l.id, l.url]), [
    ['ticket', 'DATA-12', 'https://acme.atlassian.net/browse/DATA-12'],
    ['ticket', 'OPS-4', 'https://jira.corp.com/jira/browse/OPS-4'],
  ]);
});
test('Jira: #n is not a ticket, PR rules intact', () => {
  assert.deepStrictEqual(findLinks('Fix (#7)\n\nrefs #9', jira).map((l) => [l.kind, l.id]), [['pr', '7']]);
});
```
In `linkTarget.test.js`:
```js
test('Jira browse links on a configured site open the ticket page', () => {
  const p = { ...github, ticketKeys: { DATA: 'https://acme.atlassian.net', OPS: 'https://jira.corp.com/jira' } };
  assert.deepStrictEqual(linkTarget('https://acme.atlassian.net/browse/DATA-7?focused=1', p), { kind: 'ticket', id: 'DATA-7', org: 'https://acme.atlassian.net' });
  assert.deepStrictEqual(linkTarget('https://jira.corp.com/jira/browse/OPS-2', p), { kind: 'ticket', id: 'OPS-2', org: 'https://jira.corp.com/jira' });
  assert.strictEqual(linkTarget('https://other.atlassian.net/browse/DATA-7', p), undefined);
});
```
- [ ] **Step 2: Run** `npm run test:unit` → FAIL.
- [ ] **Step 3: Implement.** Key regex: `new RegExp('(?<![\\w-])(' + keys.map(escapeRe).join('|') + ')-(\\d+)\\b', 'g')`. When `ticketKeys` is set, this replaces the `#n` / `AB#n` ticket rule; the URL is `<ticketKeys[key]>/browse/<KEY-n>`. Mirror the same code in `linksIn`, using `L.ticketKeys`. `linkChips`: label `Jira DATA-12`, title `Open Jira issue DATA-12`. Payloads add `ticketKeys: provider.ticketKeys`. `linkTarget`: before the generic rules, for each site in `ticketKeys` match `<site>/browse/(<KEY>-\d+)` (case-insensitive site, key in the configured set).
- [ ] **Step 4: Run** `npm run test:unit` → PASS.
- [ ] **Step 5: Commit** `feat(jira): Jira keys in commit links and link routing`.

---

### Task 5: Ticket labels, Start Work and search

**Files:**
- Modify: every inline `kind === 'github' || kind === 'gitlab' ? '#' : 'AB#'`, replaced by `ticketPrefix(provider)`: `src/views/newReleasePanel.ts:99`, `newPrPanel.ts:113,121`, `historyPanel.ts:189`, `comparePanel.ts:252`, `ticketPanel.ts:100`, `prPanel.ts:85`, `changesView.ts:142,165,288`; `src/commands/work.ts`; `src/views/ticketPanel.ts:83`; `package.json` (setting `gitland.jira.transitionOnStartWork`, `branch.prefixByType` defaults `Story`, `Sub-task`)

**Interfaces:**
- Consumes: `ticketPrefix` (Task 1), `TicketOverlay.createPullRequest` (Task 3).

- [ ] **Step 1: Replace the inline prefixes** with `ticketPrefix(provider)`. Also use it in work.ts messages and titles (`Start work on ${ticketPrefix(provider)}${ticket.id}`, "Working on …", the draft-PR description) and in ticketPanel's "was not found" message.
- [ ] **Step 2: Start Work activation** (work.ts:257): `provider.ticketKind === 'jira' ? config('jira.transitionOnStartWork', false) : config('azureDevOps.activateOnStartWork', false)`; warning text `Could not move the ${provider.ticketNoun} to In Progress`. The draft-PR offer stays gated on `provider.kind === 'azure'`; through the overlay it gets the key in the title automatically.
- [ ] **Step 3: Settings.** Add `gitland.jira.transitionOnStartWork` (boolean, default false, description "Move the Jira issue to In Progress when you start work on it."). Add `Story` and `Sub-task` → `feature` to `branch.prefixByType`. Add the group `{ id: 'jira', title: 'Jira', prefixes: ['jira.'] }` after `gitlab` in `src/settings/schema.pure.ts` and extend `test/unit/settingsSchema.test.js` with a `jira.transitionOnStartWork` → group `jira` assertion.
- [ ] **Step 4: Run** `npm run typecheck && npm run test:unit` → PASS; `grep -rn "'AB#'" src` shows only `ticketPrefix.pure.ts`.
- [ ] **Step 5: Commit** `feat(jira): Jira keys in labels, Start Work and settings`.

---

### Task 6: Ticket Sources picker, manifest and README

**Files:**
- Modify: `src/commands/ticketSources.ts`, `package.json` (`tickets.sources` item schema, description, keywords), `README.md`

- [ ] **Step 1: Picker.** List Jira entries as `$(issues) Jira · <KEY>` with description `<site> · <where>` and detail `JQL: …` when set, removable with the same button (`removeSource` compares by `type` + site / organization + project). Add the item `$(add) Add a Jira project…` (description `Jira Cloud or Server / Data Center`). Flow: input the site (`normalizeSite`, placeholder `https://your-company.atlassian.net`) → `promptJiraToken` when no secret → quick pick from `GET <apiBase>/project` (Cloud: `/project/search?maxResults=100`, paged with `startAt` until `isLast`; label `KEY`, description name) → the existing scope pick → append `{ type: 'jira', site, project: key }`. The JiraTickets helper `listProjects(site): Promise<{ key: string; name: string }[]>` lives in `jira.ts`. Picker title stays "Gitland: Ticket Sources"; doc comment updated.
- [ ] **Step 2: Manifest.** `tickets.sources.items` becomes `oneOf` of the Azure object (unchanged) and `{ type: { const: 'jira' }, site, project, jql }` (required `type`, `site`, `project`). The `markdownDescription` mentions Jira. Description and keywords add Jira.
- [ ] **Step 3: README.** Section "Jira tickets": add a source via ⚙ in the Tickets view; Cloud = email + API token, Server / DC = personal access token; tickets replace the host's, PRs stay on the host; keys in branches, commits and links; `gitland.jira.transitionOnStartWork`.
- [ ] **Step 4: Run** `npm run typecheck && npm run test:unit && npm run build` → PASS.
- [ ] **Step 5: Commit** `feat(jira): add Jira projects from Ticket Sources; docs`.

---

### Task 7: Manual verification

- [ ] **Step 1:** `node test/runTest.js <a GitHub or GitLab repo> --real`. Add a Jira Cloud source, then check: the Tickets view lists assigned issues; Start Work creates `feature/DATA-n-…`; the ticket page shows the description, fields and comments, and a transition, a comment and assign-to-me all work; a commit containing `DATA-n` shows a Jira chip in the graph that opens the ticket page; the PR and pipelines views still use the host.
- [ ] **Step 2:** Remove the Jira source and check that the host's tickets come back without a reload.
- [ ] **Step 3:** `npm run package` and report the VSIX version for the user to install. Don't bump or release without asking.
