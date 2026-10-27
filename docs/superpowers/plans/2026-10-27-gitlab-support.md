# GitLab Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitLab (gitlab.com + self-hosted) as a third hosting provider in Gitland, at parity with GitHub.

**Architecture:** A hand-written REST v4 client `src/providers/gitlab.ts` implementing the existing `Provider`
interface, selected by `getProvider` when the remote parses as GitLab. Pure helpers (remote parsing, status
mapping, stage grouping, link extraction) are unit-tested; the HTTP layer is checked by typecheck + a manual run.

**Tech Stack:** TypeScript, VS Code API 1.85, `fetch` (Node 18), esbuild, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-27-gitlab-support-design.md`

## Global Constraints

- No new runtime dependency.
- API base `https://<host>/api/v4`; project segment `/projects/${encodeURIComponent(path)}`.
- Auth header `PRIVATE-TOKEN`; secret key `gitland.gitlab.token:<host lower-cased>`.
- Setting `gitland.gitlab.hosts`: string array, default `[]`.
- Command id `gitland.setGitLabToken`, title "Set GitLab Token", category "Gitland".
- 401 message: `GitLab rejected the token for <host>. Run "Gitland: Set GitLab Token".`
- Other errors: `GitLab: <message>`.
- `kind` value `'gitlab'`; MR label `!<iid>`; ticket prefix `#`.
- Commits authored as Jay-boo, no `Co-Authored-By` trailer.
- Code style matches `src/providers/github.ts` (comment density, naming, `request<T>` helper shape).

## Review Focus

1. Self-hosted GitLab on a non-standard HTTPS port (`https://git.corp:8443/group/repo.git`) listed in `gitland.gitlab.hosts` — host match must ignore the port, web/API URLs must keep it.
2. Project path with subgroups and dots (`group/sub.team/my.repo.git`) — path kept whole, only the final `.git` stripped, encoded once in API URLs.
3. A GitLab link opened from a commit chip (`/-/merge_requests/42`, `/-/issues/7`, `/-/releases/v1.0`) — must open the Gitland page, not the browser (per the "links open in VS Code" rule).
4. Branch names with `/` (`feature/3-x`) in `pipelineRuns` `ref=` and `branchUrl` — encoded for the query, readable in the tree URL.
5. A stage whose jobs are all `manual`/`skipped` next to a failed one — stage state follows the worst-state order, not the first job.

Tests for 1, 2 are in Task 1; 3 in Task 3; 5 in Task 2; 4 is checked in Task 5's manual step.

---

### Task 1: Remote detection

**Files:**
- Modify: `src/providers/remote.ts`
- Test: `test/unit/remote.test.js`

**Interfaces:**
- Produces: `RemoteInfo` gains `{ kind: 'gitlab'; host: string; path: string }` (`host` includes `:port` only for HTTPS remotes with an explicit port).
  `parseRemoteUrl(url: string, gitlabHosts: string[] = []): RemoteInfo | undefined`;
  `resolveRemoteUrl(url, resolveHost = resolveSshHost, gitlabHosts: string[] = [])`.
  `isGitLabHost(host: string, gitlabHosts: string[]): boolean` (exported; compares the name without port, case-insensitive).

- [ ] **Step 1: Write failing tests** in `test/unit/remote.test.js`:

```js
test('parseRemoteUrl: gitlab.com', () => {
  assert.deepStrictEqual(parseRemoteUrl('git@gitlab.com:group/sub/repo.git'), { kind: 'gitlab', host: 'gitlab.com', path: 'group/sub/repo' });
  assert.deepStrictEqual(parseRemoteUrl('https://gitlab.com/group/repo'), { kind: 'gitlab', host: 'gitlab.com', path: 'group/repo' });
  assert.deepStrictEqual(parseRemoteUrl('ssh://git@gitlab.com:2222/group/repo.git'), { kind: 'gitlab', host: 'gitlab.com', path: 'group/repo' });
});
test('parseRemoteUrl: self-hosted GitLab', () => {
  assert.deepStrictEqual(parseRemoteUrl('git@gitlab.corp.io:a/b.git'), { kind: 'gitlab', host: 'gitlab.corp.io', path: 'a/b' });
  assert.deepStrictEqual(parseRemoteUrl('https://git.corp:8443/group/sub.team/my.repo.git', ['GIT.corp']), { kind: 'gitlab', host: 'git.corp:8443', path: 'group/sub.team/my.repo' });
  assert.strictEqual(parseRemoteUrl('git@git.corp:a/b.git'), undefined);
  assert.strictEqual(parseRemoteUrl('https://bitbucket.org/a/b.git'), undefined);
});
test('resolveRemoteUrl: alias to a GitLab host', async () => {
  const r = async (a) => (a === 'gl' ? 'gitlab.com' : undefined);
  assert.deepStrictEqual(await resolveRemoteUrl('git@gl:group/repo.git', r), { kind: 'gitlab', host: 'gitlab.com', path: 'group/repo' });
});
```
Existing GitHub / Azure assertions must still pass (Azure and GitHub patterns are tried first).

- [ ] **Step 2: Run** `npm run test:unit` — new tests FAIL.
- [ ] **Step 3: Implement** in `remote.ts`: after the GitHub regex, match scp (`user@host:path`), `ssh://user@host[:port]/path`, and `https?://[user@]host[:port]/path` forms; if `isGitLabHost` accepts the host, return the GitLab info (path without trailing `/` and final `.git`, at least two segments). SSH ports are dropped from `host` (web is on 443).
- [ ] **Step 4: Run** `npm run test:unit` — PASS.
- [ ] **Step 5: Commit** `feat(providers): recognize GitLab remotes`.

### Task 2: Pure GitLab mappings

**Files:**
- Create: `src/providers/gitlabMap.pure.ts`
- Test: `test/unit/gitlab.test.js` (requires `../../out/unit/gitlabMap.js`)

**Interfaces:**
- Consumes: `PipelineRun['state']`, `PipelineJob` from `./types` (type-only import).
- Produces:
  - `pipelineState(status: string): PipelineRun['state']`
  - `worstState(states: PipelineRun['state'][]): PipelineRun['state']`
  - `groupJobsByStage(jobs: { id: number; name: string; stage: string; status: string }[]): PipelineJob[]` — one entry per stage (`id: 'stage:<stage>'`, `name: <stage>`, no `logId`), steps = its jobs (`id`/`logId` = job id string), order of first appearance.
  - `stripDraft(title: string): string`

- [ ] **Step 1: Write failing tests:**

```js
test('pipelineState', () => {
  assert.strictEqual(pipelineState('success'), 'succeeded');
  assert.strictEqual(pipelineState('failed'), 'failed');
  assert.strictEqual(pipelineState('running'), 'running');
  for (const s of ['canceled', 'skipped']) assert.strictEqual(pipelineState(s), 'canceled');
  for (const s of ['created', 'pending', 'preparing', 'waiting_for_resource', 'scheduled', 'manual']) assert.strictEqual(pipelineState(s), 'queued');
});
test('worstState: failed > running > queued > canceled > succeeded', () => {
  assert.strictEqual(worstState(['queued', 'canceled', 'failed']), 'failed');
  assert.strictEqual(worstState(['succeeded', 'canceled']), 'canceled');
  assert.strictEqual(worstState(['succeeded', 'queued', 'running']), 'running');
});
test('groupJobsByStage', () => {
  const g = groupJobsByStage([
    { id: 1, name: 'lint', stage: 'test', status: 'success' },
    { id: 2, name: 'build', stage: 'build', status: 'manual' },
    { id: 3, name: 'unit', stage: 'test', status: 'failed' },
  ]);
  assert.deepStrictEqual(g.map((s) => [s.id, s.name, s.state, s.steps.map((j) => j.logId)]), [
    ['stage:test', 'test', 'failed', ['1', '3']],
    ['stage:build', 'build', 'queued', ['2']],
  ]);
});
test('stripDraft', () => {
  for (const t of ['Draft: Fix x', '[Draft] Fix x', '(Draft) Fix x', 'WIP: Fix x', 'draft:Fix x']) assert.strictEqual(stripDraft(t), 'Fix x');
  assert.strictEqual(stripDraft('Drafting rules'), 'Drafting rules');
});
```
- [ ] **Step 2: Run** `npm run test:unit` — FAIL (module missing).
- [ ] **Step 3: Implement** the four functions (unknown status → `'queued'`).
- [ ] **Step 4: Run** `npm run test:unit` — PASS.
- [ ] **Step 5: Commit** `feat(providers): GitLab pipeline and draft mappings`.

### Task 3: Kind `'gitlab'`, commit-message links and link targets

**Files:**
- Modify: `src/providers/types.ts:117` (kind union), `src/linkTarget.pure.ts`, `src/links.ts`, `media/graph.js:84-110`
- Test: `test/unit/linkTarget.test.js`, new `test/unit/links.test.js` (bundles `src/links.ts` with esbuild like `remote.test.js`)

**Interfaces:**
- Produces: `Provider['kind']` and `LinkUrls['kind']` = `'azure' | 'github' | 'gitlab'`. GitLab URL shapes (built in Task 4): `https://<host>/<path>/-/merge_requests/<iid>`, `/-/issues/<iid>`, `/-/releases/<tag>`.

- [ ] **Step 1: Write failing tests:**
  - `linkTarget.test.js` with `gitlab = { kind: 'gitlab', pullRequestUrl: id => 'https://gitlab.com/g/r/-/merge_requests/'+id, ticketUrl: id => 'https://gitlab.com/g/r/-/issues/'+id, releaseUrl: t => 'https://gitlab.com/g/r/-/releases/'+encodeURIComponent(t) }`:
    `linkTarget('https://gitlab.com/g/r/-/merge_requests/42', gitlab)` → `{ kind: 'pr', id: '42' }`;
    `.../-/issues/7#note_1` → `{ kind: 'ticket', id: '7' }`; `.../-/releases/v1.0` → `{ kind: 'release', tag: 'v1.0' }`;
    `https://gitlab.com/other/r/-/issues/7` → `undefined`.
  - `links.test.js`: with the same fake provider, `findLinks('Fix login\n\nSee merge request g/r!42\nCloses #7', gitlab)` → `[{kind:'pr',id:'42',url:'…/merge_requests/42'},{kind:'ticket',id:'7',url:'…/issues/7'}]`; `findLinks('Merge branch x into main (!12)', gitlab)` contains the `pr` `12`; GitHub provider: `findLinks('a!12', github)` has no PR.
- [ ] **Step 2: Run** `npm run test:unit` — FAIL.
- [ ] **Step 3: Implement:**
  - `linkTarget`: ticket match for `github` **or** `gitlab`; release tag regex for GitLab `/\/-\/releases\/([^/]+)\/?$/` compared against `bare`.
  - `findLinks`: when `provider.kind === 'gitlab'`, add `pr` for every `(?:^|[^\w])!(\d+)\b` and `merge request \S*!(\d+)`; update the doc comment.
  - `media/graph.js` `linksIn`: the same rule on `L.kind === 'gitlab'`; `linkChips` noun `Issue` for github/gitlab and PR chip text `MR !<id>` for gitlab; `remoteName` icon `repo` when `L.kind`/remote is GitLab (`/gitlab/i` test before the github test).
- [ ] **Step 4: Run** `npm run test:unit && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: GitLab merge request and issue links`.

### Task 4: GitLabProvider — auth, URLs, issues; wiring and token command

**Files:**
- Create: `src/providers/gitlab.ts`
- Modify: `src/providers/index.ts`, `src/extension.ts` (command next to `gitland.setAzurePat`, line ~409), `package.json` (command, setting `gitland.gitlab.hosts`, description + keyword `gitlab`)

**Interfaces:**
- Consumes: `RemoteInfo` gitlab variant and `resolveRemoteUrl(url, resolveSshHost, hosts)` (Task 1).
- Produces:
  - `export const gitlabTokenKey = (host: string) => \`gitland.gitlab.token:${host.toLowerCase()}\``
  - `export async function promptGitLabToken(host: string, secrets: vscode.SecretStorage): Promise<string | undefined>` — password input box titled `GitLab token for <host>`, prompt "Scope needed: api. Leave empty to remove it.", button "Create token" opening `https://<host>/-/user_settings/personal_access_tokens?name=Gitland&scopes=api`; stores / deletes; returns the stored token.
  - `export class GitLabProvider implements Provider` with `constructor(host: string, path: string, secrets: vscode.SecretStorage)`, public `readonly host`, private `request<T>(method, apiPath, body?)` and `requestText(method, apiPath)` (apiPath relative to `/api/v4`), private `me(): Promise<{ id: number; username: string }>`, private `get project()` = `/projects/${encodeURIComponent(path)}`.

- [ ] **Step 1: Implement** the class header, `displayName` (`GitLab · <path>`, ` (<host>)` appended unless gitlab.com), URL builders from the spec table (`branchUrl` keeps `/`, encodes each segment), `isSignedIn`, `request`/`requestText` (no token → `promptGitLabToken`; still none → `AuthError('Set a GitLab token to continue.', true)`; 401 / errors per Global Constraints), `me`.
- [ ] **Step 2: Implement issues** exactly as spec §3 "Issues": `listMyTickets`, `searchTickets`, `getTicket` (non-auth errors → `undefined`, as GitHub), `getTicketDetails`, `ticketStates`, `setTicketState`, `assignTicketToMe`, `commentTicket`.
- [ ] **Step 3: Leave MR / pipeline methods** required by `Provider` (`listPullRequests`, `createPullRequest`) as `throw new Error('not implemented')` stubs — replaced in Task 5.
- [ ] **Step 4: Wire** `getProvider`: read `gitland.gitlab.hosts`, pass to `resolveRemoteUrl`, build `GitLabProvider(info.host, info.path, secrets)`; cache key = `remote.url + '|' + hosts.join(',')`. Register `gitland.setGitLabToken` in `extension.ts` (active repo provider's `host` if `GitLabProvider`, else input box defaulting to `gitlab.com`), then `refreshViews()`. Add the contributions to `package.json`.
- [ ] **Step 5: Verify** `npm run typecheck && npm run build && npm run test:unit` — PASS.
- [ ] **Step 6: Commit** `feat(providers): GitLab provider with issues and token sign-in`.

### Task 5: Merge requests, pipelines, avatars

**Files:**
- Modify: `src/providers/gitlab.ts`

**Interfaces:**
- Consumes: `pipelineState`, `groupJobsByStage`, `stripDraft` (Task 2).
- Produces: the remaining `Provider` methods, behaviour exactly as spec §3 "Merge requests", "Pipelines", "Avatars".

- [ ] **Step 1: Implement MRs:** private `toPullRequest(mr, me)`; `listPullRequests`, `getPullRequestDetails`, `votePullRequest`, `requestMyReview`, `commentPullRequest`, `resolveThread`, `updatePullRequest`, `createPullRequest`.
- [ ] **Step 2: Implement pipelines:** `pipelineRuns` (`ref=encodeURIComponent(branch)`), `pipelineJobs` (via `groupJobsByStage`), `pipelineLog` (job `logId` → trace; stage entry → traces of failed steps joined with a `\n── <job> ──\n` header, else first step), `rerunPipeline`, `cancelPipeline`.
- [ ] **Step 3: Implement** `avatarFor(email)`: `GET /avatar?email=…&size=64` → `avatar_url`.
- [ ] **Step 4: Verify** `npm run typecheck && npm run build && npm run test:unit` — PASS; `grep -n "not implemented" src/providers/gitlab.ts` — no output.
- [ ] **Step 5: Commit** `feat(providers): GitLab merge requests, pipelines and avatars`.

### Task 6: UI call sites, settings group, docs

**Files:**
- Modify: `src/views/pipelinesView.ts:24,88-92`, `src/views/dashboardPanel.ts:136-139`, `src/views/ticketPanel.ts:72,100`, `src/views/historyPanel.ts:189`, `src/extension.ts:259`, `src/settings/schema.pure.ts:36`, `README.md`, `package.json` (`categories`/keywords already done in Task 4)
- Test: `test/unit/settingsSchema.test.js`

- [ ] **Step 1: Failing test** in `settingsSchema.test.js`: a schema with `gitland.gitlab.hosts` places it in group `gitlab` titled `GitLab`.
- [ ] **Step 2: Run** `npm run test:unit` — FAIL; add `{ id: 'gitlab', title: 'GitLab', prefixes: ['gitlab.'] }` after `azure`; PASS.
- [ ] **Step 3: Update call sites:** sign-in command per kind (`azure` → `switchAzureAccount`, `github` → `switchGitHubAccount`, `gitlab` → `setGitLabToken`) in pipelines view and dashboard (dashboard uses the active repo's provider); titles `Sign in to GitLab`; ticket prefix `#` when kind ≠ `azure`; messages "Azure DevOps, GitHub or GitLab remote".
- [ ] **Step 4: README:** short GitLab section — supported hosts, `gitland.gitlab.hosts`, token with `api` scope via "Gitland: Set GitLab Token".
- [ ] **Step 5: Verify** `npm run typecheck && npm run test:unit && npm run render` — PASS (render snapshots unchanged for Azure/GitHub).
- [ ] **Step 6: Commit** `feat: GitLab in views, settings page and README`.

### Task 7: Manual end-to-end check

- [ ] **Step 1:** `npm run build`, then `node test/runTest.js <a gitlab.com clone> --real`. Set a token when prompted.
- [ ] **Step 2:** Check: Tickets view lists assigned issues; ticket page opens and comments; PRs view lists MRs with `!n`; MR page shows threads and approve works; Pipelines view shows runs for a branch with `/`, stages expand to jobs, a log opens; graph commit chips `MR !n` open the Gitland MR page.
- [ ] **Step 3:** Record anything that failed and fix it in the owning task's file, then re-run Step 2.
