# Gitland features, batch 1 — design

Date: 2026-10-21
Status: design approved in chat ("go"), awaiting spec review

Part 4 of the improvement plan. Five features; inline PR comments get their own spec later.
All new UI uses the restyle's base (`media/base.css` tokens + `gl-*` components, `window.gl` helpers).
Existing behaviour is unchanged unless stated.

## 1. Graph keyboard navigation

| Key | Action |
|---|---|
| `↑`/`↓`, `k`/`j` | previous / next commit |
| `Home` / `End` | first / last loaded commit |
| `PgUp` / `PgDn` | one screen up / down |
| `Enter`, `Space` | toggle the details pane of the selected commit |
| `←` | first parent of the selected commit |
| `→` | a child of the selected commit (the first loaded one) |
| `m` | merge base of the selected commit and the checked-out branch (`git merge-base <sha> HEAD`) |
| `c` | start a compare from the selected commit (same as the existing ctrl+click flow, waiting for the second commit) |
| `?` | toggle the shortcuts card (also a `?` toolbar button) |

Keys are ignored while typing in an input or textarea, and with Ctrl/Alt/Meta held (except the existing Ctrl+F).
Nothing selected: the first key that moves selects the first commit. A target that is not loaded (parent beyond
`maxCommits`, merge base not in the list) shows a short notice in the graph instead of moving.

## 2. Branch ↔ ticket reminder at commit

When committing (Commit, Commit & Push, Ctrl+Enter) and **all** hold:
`gitland.changes.ticketReminder` is on; the branch is not `main|master|dev|develop|release/*|hotfix/*` and not
detached; the branch has no linked ticket (`branch.<b>.gitlandTicket`); the message has no ticket reference
(`AB#123` / `#123` per provider); the branch is not marked skipped (`branch.<b>.gitlandNoTicket=true`) —
a warning offers:

- **Link a ticket…** — `pickTicket(provider)`; links the branch (same git config as Start work), appends the
  reference to the subject line, then commits.
- **Commit anyway** — commits unchanged.
- **Don't ask for this branch** — sets `branch.<b>.gitlandNoTicket=true`, commits.
- Dismiss — no commit.

New setting `gitland.changes.ticketReminder` (boolean, default `true`).

## 3. Ticket quick actions

Ticket tab, in the header card's action bar:
- **State** dropdown: Azure DevOps lists the states of the work item's type
  (`GET {project}/_apis/wit/workitemtypes/{type}/states`), GitHub offers `open` / `closed`. Changing it updates
  the ticket and refreshes the page.
- **Assign to me** (hidden when already assigned to me).
- A **comment box** under the comments (markdown on GitHub, plain text → HTML paragraphs on Azure DevOps).

Start work gets a last step "Also create a draft pull request" (quick pick: *Branch only* / *Branch + draft pull
request*). The draft PR targets the chosen base branch, is titled after the ticket, links it, and is created after
pushing the branch. If the host refuses an empty PR (GitHub: no commits), Gitland says so and keeps the branch.

Provider additions (optional methods, `types.ts`): `ticketStates?(id, org?)`, `setTicketState?(id, state, org?)`,
`assignTicketToMe?(id, org?)`, `commentTicket?(id, text, org?)`.

## 4. Pipelines view

New webview view `gitland.pipelines` ("Pipelines") in the Gitland sidebar, collapsed by default, after Releases.
- Runs of the current branch, newest first (max 30): status pill, pipeline name, short SHA, start time, duration.
- Hover actions: **Rerun**, **Cancel** (running/queued only), **Open in browser**.
- Click a run: expands its jobs/steps with their state; for the first failed step, the last 50 lines of its log.
- Refresh: every 30 s while a run is running/queued and the view is visible, else every 2 min; plus on branch change
  and a toolbar refresh button.
- Empty / signed-out / error states like the other lists.

`PipelineRun` gains `id: string`, `started?: number`, `definitionId?: string`. Provider additions:
`rerunPipeline?(run)`, `cancelPipeline?(run)`, `pipelineJobs?(run): PipelineJob[]`,
`pipelineLog?(run, job): string`.
- Azure DevOps: rerun = queue a new build of the same definition and commit; cancel = PATCH `status: cancelling`;
  jobs = build timeline records (Job/Task); log = `builds/{id}/logs/{logId}` (plain text).
- GitHub: `actions/runs/{id}/rerun`, `/cancel`, `/jobs` (steps), `actions/jobs/{id}/logs` (plain text).

## 5. Settings page

Command **Gitland: Settings** (Command Palette, and a gear icon in the Changes view's title bar) opens an
editor tab:
- Groups: Graph, Blame & CodeLens, Changes & AI, Tickets & branches, Pull requests, Pipelines, Avatars, Azure DevOps.
- Controls from the manifest schema: boolean → switch, enum → dropdown, number → number input, string → text input
  (multi-line for `*Instructions`), array/object → "Edit in settings.json" link.
- Each row: title, the manifest description, a reset link when it differs from the default, and a link opening
  VS Code's settings editor on that key. Changes write to the user (global) settings.
- The page follows changes made elsewhere (`onDidChangeConfiguration`).

## Testing

Pure logic lives in modules without `vscode` imports and is unit-tested first (keyboard mapping, reminder rule,
log tail / duration formatting, settings grouping). Each new screen gets a static render fixture and screenshots in
the three themes. `npm run typecheck`, `npm test` and `npm run render` pass. Provider calls are verified by type
checks and a manual check against the user's Azure DevOps (they cannot be unit-tested without the network).
