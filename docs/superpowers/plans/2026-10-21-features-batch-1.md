# Features batch 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add graph keyboard navigation, a branch↔ticket reminder at commit, ticket quick actions (+ draft PR on Start work), a Pipelines view and a Settings page.

**Architecture:** Pure logic in modules without `vscode` imports (webview: `media/*.js` classic scripts exporting via `module.exports` like `common.js`; extension: `src/**/` TS files bundled for tests), unit-tested with `node:test`; UI on the restyle's `base.css` / `window.gl`; provider calls as optional `Provider` methods.

**Tech Stack:** TypeScript (esbuild), VS Code webviews, `node:test`, render harness `test/render/render.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-21-features-batch-1-design.md`

## Global Constraints

- Existing behaviour unchanged unless the spec says so; engine `vscode ^1.85.0`; CSP unchanged.
- New UI uses `gl-*` components / `--gl-*` tokens only; no hex literals in `media/*.css` (tokens test enforces).
- New settings: only `gitland.changes.ticketReminder` (boolean, default `true`).
- Protected branches for the reminder: `/^(main|master|dev|develop)$|^(release|hotfix)\//`.
- Commits as Jay-boo, no `Co-Authored-By: Claude` trailer. Branch `feat/batch-1` from `main`.
- Version `0.2.0` at the end.

## Review Focus

1. Keys pressed while typing in the search box, picker, or the commit textarea must not move the graph selection. Test: `graphKeys.test.js` `keyAction` returns `null` when `inInput` is true.
2. Reminder must never block commits on protected/detached branches or when the message already references a ticket. Test: `reminder.test.js` cases.
3. Pipelines polling must stop when the view is hidden or disposed (no timers leaking). Test: `pipelinesPoll.test.js` on `nextPollDelay`, plus code review of `dispose`.
4. Azure DevOps log endpoint returns `text/plain`; the provider's `request()` treats non-JSON as an auth error. Test: none possible offline — Task 6 adds a dedicated `requestText()`; manual check in Task 9.
5. Settings writes must go to the user (global) scope and survive a missing workspace. Test: `settingsSchema.test.js` + manual check in Task 9.

## Shared test setup (part of Task 1)

`test/unit/build.mjs`: esbuild-bundles each `src/**/*.pure.ts` entry listed in it to `out/unit/<name>.js` (cjs, node18). `npm run test:unit` becomes `node test/unit/build.mjs && node --test test/unit/`. `out/` is already git-ignored? — check; add `out/unit/` to `.gitignore` if not.

---

### Task 1: Graph keyboard navigation

**Files:**
- Create: `media/graphKeys.js`, `test/unit/graphKeys.test.js`, `test/unit/build.mjs`
- Modify: `media/graph.js` (keydown handler ~1364, toolbar button wiring), `src/graph/graphPanel.ts` (GRAPH_BODY toolbar `?` button + shortcuts card; `mergeBase` message), `src/views/webviewHtml.ts` callers for graph (script list adds `graphKeys.js` before `graph.js`), `media/graph.css` (shortcuts card), `package.json` (test:unit script)

**Interfaces:**
- Produces `window.glKeys` / `module.exports`:
  - `keyAction(e: { key: string, ctrlKey, altKey, metaKey, shiftKey }, inInput: boolean): null | 'up'|'down'|'home'|'end'|'pageUp'|'pageDown'|'toggleDetails'|'parent'|'child'|'mergeBase'|'compare'|'help'`
  - `moveIndex(action, index: number, count: number, pageRows: number): number` — clamps to `[0, count-1]`; `index === -1` (nothing selected) → `0` for any move.
  - `childIndex(commits: {sha, parents: string[]}[], index: number): number` — the nearest row above `index` whose parents include `commits[index].sha`, or `-1`.
  - `parentIndex(commits, index): number` — row of `commits[index].parents[0]`, or `-1`.
- Webview → host: `{ type: 'mergeBase', sha }`; host → webview: `{ type: 'jump', sha }` or `{ type: 'notice', text }`.

- [ ] **Step 1: Write failing tests** `graphKeys.test.js`: `keyAction({key:'j'}, false)` → `'down'`; `'k'` → `'up'`; `'ArrowDown'` → `'down'`; `'Home'` → `'home'`; `'PageDown'` → `'pageDown'`; `'Enter'` and `' '` → `'toggleDetails'`; `'ArrowLeft'` → `'parent'`; `'ArrowRight'` → `'child'`; `'m'` → `'mergeBase'`; `'c'` → `'compare'`; `'?'` → `'help'`; `{key:'j'}, true` → `null`; `{key:'j', ctrlKey:true}` → `null`; `{key:'x'}` → `null`. `moveIndex('down', 9, 10, 5)` → `9`; `moveIndex('pageDown', 2, 10, 5)` → `7`; `moveIndex('up', -1, 10, 5)` → `0`; `moveIndex('end', 0, 10, 5)` → `9`. `parentIndex` / `childIndex` on a 4-commit fixture with a merge (`[{sha:'d',parents:['c','b']},{sha:'c',parents:['a']},{sha:'b',parents:['a']},{sha:'a',parents:[]}]`): `parentIndex(f,0)` → `1`, `childIndex(f,3)` → `2`, `childIndex(f,0)` → `-1`, `parentIndex(f,3)` → `-1`.
- [ ] **Step 2:** `npm run test:unit` → FAIL (module missing).
- [ ] **Step 3:** Implement `media/graphKeys.js` (classic script like `common.js`).
- [ ] **Step 4:** `npm run test:unit` → PASS.
- [ ] **Step 5:** Wire into `graph.js`: replace the ArrowUp/ArrowDown branch of the keydown handler with `keyAction` → `moveIndex` / `parentIndex` / `childIndex` → `select(sha, false)` + `scrollIntoView({block:'nearest'})`; `toggleDetails` → `closeDetails()` if open else `select(selected, false)`; `mergeBase` → post `{type:'mergeBase', sha}`; `compare` → enter the existing pending-compare state (the ctrl+click path) from `selected`; `help` → toggle `#keysCard`. `inInput` = target is `input`, `textarea`, `select` or `contenteditable`. `pageRows` = `Math.floor(listEl.clientHeight / rowH())`. On `{type:'jump'}` select + center if loaded, else show notice; on `{type:'notice'}` show it for 3 s in a `.gl-pill` at the top of the list.
- [ ] **Step 6:** Host: `case 'mergeBase'`: `git merge-base <sha> HEAD` via `this.currentRepo.exec`; reply `jump` with the sha (trim) or `notice` "No common ancestor with HEAD".
- [ ] **Step 7:** Toolbar `?` button (`codicon-keyboard`) + `#keysCard` (`gl-pop`) listing the table from the spec. Render: add interaction `['keys', page => press '?']` and `['jdown', press 'j' x3 then Enter]` in `render.mjs` INTERACTIONS.graph; `npm run render -- --only graph` exit 0; inspect dark/light shots.
- [ ] **Step 8:** `npm run typecheck`, `npm run test:unit` PASS. Commit `feat(graph): keyboard navigation`.

### Task 2: Branch ↔ ticket reminder at commit

**Files:**
- Create: `src/tickets/reminder.pure.ts`, `test/unit/reminder.test.js`
- Modify: `src/views/changesView.ts` (`commit()` ~367, `ticketOf()` ~157), `test/unit/build.mjs` (entry), `package.json` (setting)

**Interfaces:**
- Produces `needsTicketReminder(o: { enabled: boolean; branch?: string; linkedTicket?: string; skipped: boolean; message: string; prefix: string }): boolean` and `withTicketRef(message: string, ref: string): string` (appends ` <ref>` to the first line; empty message → `<ref>`).

- [ ] **Step 1: Failing tests:** true for `{enabled:true, branch:'feature/login', skipped:false, message:'add form', prefix:'AB#'}`; false when `enabled:false`; false for branches `main`, `master`, `dev`, `develop`, `release/1.2`, `hotfix/x`; false when `branch` undefined (detached); false when `linkedTicket:'12'`; false when `skipped:true`; false when message contains `AB#123`; with prefix `'#'` false when message has `fix #42`, true when it has `#tag-like` text without digits. `withTicketRef('fix: x\n\nbody', 'AB#7')` → `'fix: x AB#7\n\nbody'`; `withTicketRef('', 'AB#7')` → `'AB#7'`.
- [ ] **Step 2:** RED. **Step 3:** implement. **Step 4:** GREEN.
- [ ] **Step 5:** In `commit()`, before staging checks: read `branch.<b>.gitlandNoTicket`; if `needsTicketReminder(...)` → `vscode.window.showWarningMessage('This branch has no ticket. Link one so the commit shows up on it?', 'Link a ticket…', 'Commit anyway', "Don't ask for this branch")`. Link → `pickTicket(provider)` (from `src/commands/work.ts`); on a pick set `branch.<b>.gitlandTicket` / `gitlandTicketTitle` like work.ts:249-250, `message = withTicketRef(message, prefix + id)`, `this.refresh()`; on no pick → return without committing. Don't ask → `git config branch.<b>.gitlandNoTicket true`. Undefined (dismissed) → return.
- [ ] **Step 6:** Setting `gitland.changes.ticketReminder` in `package.json` (description: "Before committing on a branch that has no ticket, offer to link one."). Typecheck, unit tests, `npm test` PASS. Commit `feat(changes): remind to link a ticket before committing`.

### Task 3: Ticket provider actions

**Files:**
- Modify: `src/providers/types.ts`, `src/providers/azureDevOps.ts`, `src/providers/github.ts`

**Interfaces (all optional on `Provider`):**
- `ticketStates?(id: string, org?: string): Promise<{ name: string; category?: string }[]>`
- `setTicketState?(id: string, state: string, org?: string): Promise<void>`
- `assignTicketToMe?(id: string, org?: string): Promise<void>`
- `commentTicket?(id: string, text: string, org?: string): Promise<void>`

- [ ] **Step 1:** Azure DevOps: `ticketStates` = GET work item (`fields=System.WorkItemType,System.TeamProject`) then GET `https://dev.azure.com/{org}/{project}/_apis/wit/workitemtypes/{type}/states?api-version=7.1` → `{name, category}`; `setTicketState` = the `activateTicket` PATCH with the given value (refactor `activateTicket` to call it with `'Active'`); `assignTicketToMe` = PATCH `/fields/System.AssignedTo` with the authenticated user's unique name (`GET https://dev.azure.com/{org}/_apis/connectionData` → `authenticatedUser.properties.Account.$value`); `commentTicket` = POST `{project}/_apis/wit/workItems/{id}/comments?api-version=7.1-preview.4` `{ text }` (text escaped, newlines → `<br>`).
- [ ] **Step 2:** GitHub: `ticketStates` → `[{name:'open'},{name:'closed'}]`; `setTicketState` = PATCH `/repos/{o}/{r}/issues/{n}` `{state}`; `assignTicketToMe` = POST `/issues/{n}/assignees` `{assignees:[login]}`; `commentTicket` = POST `/issues/{n}/comments` `{body}`.
- [ ] **Step 3:** `npm run typecheck` PASS. Commit `feat(providers): ticket state, assign and comment`.

### Task 4: Ticket tab actions + draft PR on Start work

**Files:**
- Modify: `src/views/ticketPanel.ts` (messages, `load()` adds `states`, `me`), `media/ticket.js`, `media/ticket.css`, `src/commands/work.ts` (`startWork` last step), `test/render/static/ticket.jsonl` (+ `states`, `canAssign`, `canComment`)

**Interfaces:**
- Host → page `details` message gains `states?: string[]`, `canAssign: boolean`, `canComment: boolean`.
- Page → host: `{type:'setState', state}`, `{type:'assign'}`, `{type:'comment', text}`; host refreshes after each, errors via `showErrorMessage`.

- [ ] **Step 1:** Page: a `<select class="gl-input">` State in `.t-actions` (current state selected), **Assign to me** button when `canAssign`, comment box (`.gl-composer` textarea + primary **Comment** button, Ctrl+Enter) at the end of the Comments section when `canComment`.
- [ ] **Step 2:** Host handlers call the Task 3 methods with the ticket's `org`.
- [ ] **Step 3:** `startWork`: after the branch exists, quick pick *Branch only* / *Branch + draft pull request*. Draft: `git push -u origin <branch>` (existing push helper in the repo class), then `provider.createPullRequest({ source: branch, target: base, title: ticket.title, description: '', draft: true, ticketIds: [ticket.id], addMeAsReviewer: false })`; on success offer **Open**; on error show it ("…the branch is kept").
- [ ] **Step 4:** Update the static fixture; `npm run render -- --only ticket` exit 0, inspect three themes. Typecheck PASS. Commit `feat(tickets): state, assign and comment from the ticket tab; draft PR on Start work`.

### Task 5: Pipeline provider API + formatting

**Files:**
- Create: `src/pipelines/format.pure.ts`, `test/unit/pipelines.test.js`
- Modify: `src/providers/types.ts`, `src/providers/azureDevOps.ts` (add `requestText()`), `src/providers/github.ts` (add `requestText()`), `test/unit/build.mjs`

**Interfaces:**
- `PipelineRun` adds `id: string; started?: number; definitionId?: string`.
- `PipelineJob = { id: string; name: string; state: PipelineRun['state']; logId?: string; steps?: PipelineJob[] }`.
- Provider (optional): `rerunPipeline?(run)`, `cancelPipeline?(run)`, `pipelineJobs?(run): Promise<PipelineJob[]>`, `pipelineLog?(run, job): Promise<string>`.
- Pure: `tailLog(text: string, lines: number): string` (drops trailing empty lines, strips ANSI and Azure/GitHub timestamp prefixes `^\d{4}-\d\d-\d\dT[\d:.]+Z `), `formatDuration(ms: number): string` (`'45s'`, `'3m 05s'`, `'1h 02m'`), `nextPollDelay(runs: {state}[], visible: boolean): number | undefined` (`undefined` when not visible; `30000` when any running/queued; else `120000`), `firstFailed(jobs: PipelineJob[]): PipelineJob | undefined` (depth-first).

- [ ] **Step 1: Failing tests** for the four pure functions with those exact values (e.g. `formatDuration(185000)` → `'3m 05s'`, `formatDuration(3720000)` → `'1h 02m'`; `tailLog('a\nb\nc\n\n', 2)` → `'b\nc'`; `tailLog('\u001b[31m2026-10-21T10:00:00.1234567Z boom', 5)` → `'boom'`; `nextPollDelay([{state:'running'}], true)` → `30000`; `nextPollDelay([{state:'succeeded'}], true)` → `120000`; `nextPollDelay([], false)` → `undefined`).
- [ ] **Step 2:** RED. **Step 3:** implement. **Step 4:** GREEN.
- [ ] **Step 5:** Providers: map `id`, `started` (`startTime` / `run_started_at`), `definitionId`. Azure: rerun = POST `{project}/_apis/build/builds?api-version=7.1` `{definition:{id}, sourceBranch: 'refs/heads/'+branch, sourceVersion: sha}`; cancel = PATCH `builds/{id}` `{status:'cancelling'}`; jobs = GET `builds/{id}/timeline` → records of type `Job` with child `Task` records as steps (`log.id` → `logId`); log = `requestText` GET `builds/{id}/logs/{logId}`. GitHub: rerun POST `actions/runs/{id}/rerun`; cancel POST `actions/runs/{id}/cancel`; jobs GET `actions/runs/{id}/jobs` (steps from `steps[]`, `logId` = job id on the job); log = `requestText` GET `actions/jobs/{id}/logs`.
- [ ] **Step 6:** Typecheck PASS (existing callers of `PipelineRun` compile). Commit `feat(providers): pipeline runs with id, rerun, cancel, jobs and logs`.

### Task 6: Pipelines view

**Files:**
- Create: `src/views/pipelinesView.ts`, `media/pipelines.js`, `media/pipelines.css`, `test/render/static/pipelines.jsonl`, `test/render/static/pipelines.page.json`
- Modify: `package.json` (view `gitland.pipelines` "Pipelines", `visibility: collapsed`, after Releases; title button refresh), `src/extension.ts` (register), `test/render/render.mjs` (`pipelines` in SIDEBAR)

**Interfaces:**
- Host → page: `{type:'runs', branch, runs: (PipelineRun & { duration?: string; ago?: string })[] }`, `{type:'jobs', id, jobs, failedLog?: string}`, `{type:'state', state:'signin'|'empty'|'error', title, text}`, `{type:'loading'}`.
- Page → host: `ready`, `refresh`, `expand{id}`, `rerun{id}`, `cancel{id}`, `open{id}`, `signIn`.

- [ ] **Step 1:** View provider modelled on `releasesView.ts` (`webviewHtml` with `view: 'pipelines'`, `capture`, `list.css` + `pipelines.css`). Poll with `setTimeout(nextPollDelay(runs, view.visible))`; reschedule on `onDidChangeVisibility`, `repos.onDidChangeRepo`; clear on dispose.
- [ ] **Step 2:** Page: runs as `.item`s in a `.gb` card (glyph by state, title = pipeline name, meta = short SHA · ago · duration, `.pill` state), `.acts` rerun / cancel / open; expanded run shows jobs/steps rows and the failed log in a `pre` (`gl-inset`, editor font, max-height 240px).
- [ ] **Step 3:** Static fixtures: 4 runs (running, failed with expanded jobs + log, succeeded, canceled). `npm run render -- --only pipelines` exit 0 at 220/320 in three themes.
- [ ] **Step 4:** Typecheck, unit tests, `npm test` PASS. Commit `feat: Pipelines view (runs, rerun, cancel, logs)`.

### Task 7: Settings page

**Files:**
- Create: `src/settings/schema.pure.ts`, `test/unit/settingsSchema.test.js`, `src/views/settingsPanel.ts`, `media/settings.js`, `media/settings.css`, `test/render/static/settings.page.json`, `test/render/static/settings.jsonl`
- Modify: `package.json` (command `gitland.settings` "Settings", `view/title` gear on `gitland.changesView`), `src/extension.ts`, `test/unit/build.mjs`

**Interfaces:**
- `settingsGroups(properties: Record<string, {type?, enum?, default?, description?, markdownDescription?}>): { id: string; title: string; settings: { key: string; title: string; type: 'boolean'|'enum'|'number'|'string'|'text'|'json'; options?: string[]; default: unknown; description: string }[] }[]`
  - Group by key: `graph.*` Graph; `blame.*`, `codeLens.*` Blame & CodeLens; `changes.*`, `ai.*` Changes & AI; `branch.*`, `tickets.*` Tickets & branches; `pr.*` Pull requests; `pipelines.*` Pipelines; `avatars.*` Avatars; `azureDevOps.*` Azure DevOps; in that order; unknown prefixes → "Other".
  - `type`: boolean → `'boolean'`; has `enum` → `'enum'`; number/integer → `'number'`; string ending `Instructions` → `'text'`; string → `'string'`; array/object → `'json'`.
  - `title`: key after `gitland.` → last segments, camelCase split and capitalised (`graph.statusBar.enabled` → `Status Bar Enabled` with group prefix dropped).
- Page ↔ host: `{type:'settings', groups, values}`; page → `{type:'set', key, value}`, `{type:'reset', key}`, `{type:'openJson', key}` (`workbench.action.openSettings` with `@id:gitland.<key>`).

- [ ] **Step 1: Failing tests** with a small properties fixture: group order, `'text'` for `changes.commitMessageInstructions`, `'enum'` options for `blame.toggleMode`, `'json'` for `branch.prefixByType`, title `'Max Commits'` for `graph.maxCommits`, unknown key → "Other".
- [ ] **Step 2:** RED. **Step 3:** implement. **Step 4:** GREEN.
- [ ] **Step 5:** Panel (singleton editor tab, icon `settings`), reads `context.extension.packageJSON.contributes.configuration.properties`, values via `vscode.workspace.getConfiguration('gitland')`, writes with `ConfigurationTarget.Global`, re-posts on `onDidChangeConfiguration('gitland')`. Page: one `.gl-card` per group, rows with title, description, control (`.switch`, `select.gl-input`, `input.gl-input`, `textarea` in `.gl-composer`), "Reset" link when value ≠ default, gear link → `openJson`.
- [ ] **Step 6:** Static fixture from the real schema; `npm run render -- --only settings` exit 0 at 1000px, three themes. Typecheck PASS. Commit `feat: Gitland settings page`.

### Task 8: README

**Files:** Modify `README.md` (features table: keyboard shortcuts in the Commit Graph row, ticket reminder + quick actions in My Tickets, new Pipelines and Settings rows; settings list adds `gitland.changes.ticketReminder`).

- [ ] **Step 1:** Edit; commit `docs: README for batch 1 features`.

### Task 9: Final verification and install

- [ ] **Step 1:** `npm run test:unit && npm run typecheck && npm test && npm run render` — all pass.
- [ ] **Step 2:** Bump `package.json` to `0.2.0` (edit the version line only — do not re-serialise the file). `npm run package`; `code --install-extension gitland-0.2.0.vsix --force`.
- [ ] **Step 3:** Ask the user to reload and check against their Azure DevOps: ticket state/assign/comment, reminder, draft PR on Start work, Pipelines rerun/cancel/log, settings writes. Commit `chore: release 0.2.0`.
