# GitLab support — design

Date: 2026-10-27
Status: design approved in chat ("go"), awaiting spec review

Adds GitLab (gitlab.com and self-hosted) as a third hosting provider, at parity with GitHub.
Existing Azure DevOps / GitHub behaviour is unchanged.

## Approach

Hand-written REST v4 client in `src/providers/gitlab.ts`, shaped like `src/providers/github.ts`
(`fetch` + a private `request<T>` / `requestText` pair). No new dependency. Rejected: `@gitbeaker/rest`
(bundle size, a second style) and GraphQL (no other provider uses it).

API base: `https://<host>/api/v4`. Project calls use `/projects/<encodeURIComponent(path)>` where `path`
is the full namespace path (`group/sub/repo`).

## 1. Remote detection — `src/providers/remote.ts`, `src/providers/index.ts`

- `RemoteInfo` gains `{ kind: 'gitlab'; host: string; path: string }`.
- `parseRemoteUrl(url, gitlabHosts: string[] = [])` recognizes a host as GitLab when it is `gitlab.com`,
  appears in `gitlabHosts` (case-insensitive), or starts with `gitlab.`. Azure DevOps and GitHub patterns
  are checked first.
- Accepted forms: `git@host:path(.git)`, `ssh://git@host[:port]/path(.git)`, `https://[user@]host[:port]/path(.git)`.
  `path` keeps every segment (subgroups), strips `.git` and a trailing `/`.
- `resolveRemoteUrl(url, resolveHost, gitlabHosts)` passes the hosts through, so SSH aliases resolving to
  a GitLab host work too.
- New setting `gitland.gitlab.hosts` (string array, default `[]`): extra self-hosted GitLab host names.
  `getProvider` reads it and builds `new GitLabProvider(host, path, secrets)`. The provider cache key adds
  the hosts setting so a change takes effect without reload.

## 2. Authentication

- Personal access token per host, scope `api`, stored in SecretStorage under `gitland.gitlab.token:<host>`
  (host lower-cased). Exported as `gitlabTokenKey(host)`.
- Command `gitland.setGitLabToken` ("Gitland: Set GitLab Token"): uses the active repo's GitLab host, or
  asks for a host (default `gitlab.com`). Password input box; empty value deletes the token.
- `isSignedIn()` = a token exists for the host. `request` with no token shows the same input box once
  (with a "Create token" button opening `https://<host>/-/user_settings/personal_access_tokens?name=Gitland&scopes=api`);
  cancelled → `AuthError(..., handled = true)`.
- Header `PRIVATE-TOKEN: <token>`. HTTP 401 → `AuthError('GitLab rejected the token for <host>. Run "Gitland: Set GitLab Token".')`.
  Other errors → `Error('GitLab: <message>')` from the JSON `message` / `error` field.
- Pipelines view and dashboard sign-in buttons run `gitland.setGitLabToken` for a GitLab repo. The
  command `gitland.switchGitLabAccount` is not added; setting a new token is the switch.

## 3. Provider — `src/providers/gitlab.ts`

`kind = 'gitlab'`, `ticketNoun = 'issue'`, `displayName = 'GitLab · <path>'` (plus host when not gitlab.com).
`me()` caches `GET /user` (`id`, `username`).

### Web URLs (`https://<host>/<path>`)
| Method | URL |
|---|---|
| `commitUrl` | `/-/commit/<sha>` |
| `branchUrl` | `/-/tree/<branch>` |
| `ticketUrl` | `/-/issues/<iid>` |
| `pullRequestUrl` | `/-/merge_requests/<iid>` |
| `releaseUrl` | `/-/releases/<tag>` |

### Issues (tickets)
- `listMyTickets`: `GET /projects/:id/issues?state=opened&assignee_id=<me.id>&per_page=50`.
- `searchTickets`: number (optionally `#`) → `getTicket`; else `?state=opened&search=<text>`.
- `getTicket` / `getTicketDetails`: `GET /issues/:iid`, `/notes?sort=asc&per_page=100` (drop `system` notes),
  `/closed_by` → `pullRequests`. Type `Bug` when a label matches `/bug/i`, else `Issue`; tags = labels;
  fields Opened by, Milestone, Due date; `format: 'markdown'`.
- `ticketStates`: `opened`, `closed`. `setTicketState`: `PUT /issues/:iid` with `state_event` close/reopen.
- `assignTicketToMe`: `PUT /issues/:iid` with `assignee_ids` = current assignees + me.
- `commentTicket`: `POST /issues/:iid/notes`.

### Merge requests (pull requests)
- `listPullRequests`: `GET /merge_requests?state=opened&per_page=100`. Label `!<iid>`, `isDraft` = `draft`.
  Group: `mine` when author is me, `review` when I am in `reviewers`, else `other`. `needsMyReview` = I am a
  reviewer and have not approved (approval state is fetched only in details; list uses reviewers only).
- `getPullRequestDetails`: in parallel `GET /merge_requests/:iid`, `/approvals`, `/commits`, `/discussions?per_page=100`.
  - status: `opened → active`, `merged`, `closed`.
  - reviewers: union of `reviewers` and `approved_by`; vote `approved` if in `approved_by`, else `waiting`.
  - `review`: `approved` when `approvals.approved`, else `waiting`.
  - discussions → `threads` (`id`, status `resolved`/`active` when resolvable, `file`/`line` from the first
    note's `position.new_path`/`new_line`); non-system notes of non-thread discussions → `comments`.
  - `workItems` from `Closes|Fixes|Resolves #n` in the description; `mergeStatus` = `detailed_merge_status`;
    `lastSourceCommit` = `sha`; `myVote` / `amReviewer` from the above.
- `votePullRequest`: `approve`/`suggestions` → `POST /approve` (then a note with the comment if any);
  `reset` → `POST /unapprove`; `reject`/`wait` → `Error('GitLab has no such review state: approve or revoke approval.')`.
- `requestMyReview`: `PUT /merge_requests/:iid` with `reviewer_ids` = current + me.
- `commentPullRequest(id, text, threadId?)`: thread reply → `POST /discussions/:threadId/notes`; else `POST /notes`.
- `resolveThread`: `PUT /discussions/:threadId?resolved=true|false`.
- `updatePullRequest`:
  - `publish`: `PUT` with `title` stripped of a leading `Draft:` / `[Draft]` / `(Draft)` / `WIP:`.
  - `abandon`: `PUT` with `state_event=close`.
  - `complete`: `PUT /merge` with `sha`, `squash` (strategy `squash`), `should_remove_source_branch`,
    `squash_commit_message` or `merge_commit_message` when a message is given. Rebase strategies merge normally.
- `createPullRequest`: `POST /merge_requests` with `source_branch`, `target_branch`, title (prefixed `Draft: `
  when draft), description + `Closes #n` lines, `remove_source_branch: false`.

### Pipelines
- `pipelineRuns`: `GET /pipelines?per_page=<max ?? 60>[&ref=<branch>]`, or for an MR `GET /merge_requests/:iid/pipelines`.
  name = `Pipeline #<id>` (`name` field when set), `definitionId` = `source`.
  Status map (pure, `src/providers/gitlabMap.pure.ts`): `success → succeeded`, `failed → failed`,
  `running → running`, `canceled|skipped → canceled`, `created|pending|preparing|waiting_for_resource|scheduled|manual → queued`.
- `pipelineJobs`: `GET /pipelines/:id/jobs?per_page=100&include_retried=false`, grouped by `stage` in first
  appearance order. Stage = job entry (state = worst of its jobs: failed > running > queued > canceled > succeeded),
  GitLab jobs = steps with `logId` = job id.
- `pipelineLog`: `GET /jobs/:logId/trace` (text); for a stage entry, the traces of its failed jobs, else its first job.
- `rerunPipeline`: `POST /pipelines/:id/retry`. `cancelPipeline`: `POST /pipelines/:id/cancel`.

### Avatars
`avatarFor(email)`: `GET /avatar?email=<email>&size=64` → `avatar_url` (cached per email by the existing avatar layer).

## 4. Provider-kind call sites

- `Provider['kind']`: `'azure' | 'github' | 'gitlab'`.
- `src/links.ts` and `media/graph.js` `linksIn` (kept identical): for GitLab, `!(\d+)` and
  `See merge request \S+!(\d+)` → MR links; `#n` stays an issue. Chip labels: `MR !n` / `Issue n` on GitLab.
- `ticketPanel.ts`, `historyPanel.ts`: ticket prefix `#` for GitHub and GitLab.
- `pipelinesView.ts`: sign-in command and title per kind; "No Azure DevOps, GitHub or GitLab remote".
- `dashboardPanel.ts` sign-in: by kind. `extension.ts` "no remote" message mentions GitLab.
- `media/graph.js` remote icon: `github` / `azure-devops` / `repo` for GitLab.
- Settings page: group `{ id: 'gitlab', title: 'GitLab', prefixes: ['gitlab.'] }`.
- `package.json`: command, setting, description/keywords mention GitLab. README section on GitLab and tokens.

## 5. Testing

- `test/unit/remote.test.js`: gitlab.com SSH/HTTPS, subgroup path, `ssh://` with port, self-hosted via
  `gitlabHosts`, `gitlab.` prefix heuristic, alias resolving to a GitLab host, unknown host stays undefined.
- New `test/unit/gitlab.test.js` for `gitlabMap.pure.ts` (status map, stage grouping, draft title strip) and
  `test/unit/linkTarget`-style test for `!42` link extraction if `findLinks` is testable without vscode.
- `npm run compile` / existing unit suite green.
- Manual: `node test/runTest.js <gitlab repo> --real` against a real gitlab.com repository (issues, MR page,
  pipelines view).

## Out of scope

GitLab OAuth sign-in, group-level issue boards / epics, GitLab "request changes" review state,
inline diff comments on MRs (no inline PR comments on other hosts either).
