# Jira support — design

Date: 2026-10-27
Status: design approved in chat ("go"), awaiting spec review

Adds Jira (Cloud and Server / Data Center) as a **ticket source** for any repository, whatever its host
(Azure DevOps, GitHub, GitLab). Some teams use Jira only for tickets: pull requests and pipelines stay on
the code host. Existing behaviour is unchanged for repositories without a Jira source.

## Approach

`getProvider` stays the single entry point. When the repository has Jira ticket sources, it returns the
host provider wrapped in a `TicketOverlay` (`src/providers/ticketOverlay.ts`): ticket members are served
by a new `JiraTickets` (`src/providers/jira.ts`), everything else is forwarded to the host provider.
The ~20 call sites that use ticket members keep working; only ticket-id parsing learns Jira keys.

Rejected: a separate `getTicketProvider()` (every call site changes, pages would juggle two providers);
a Jira-only Tickets view (Start Work, ticket page and links would not know Jira).

One tracker per repository: when Jira sources are set, Jira **replaces** the host's tickets (Tickets view,
Start Work, ticket page, link chips, search, new-PR ticket linking). No mixing, so `#12` and `DATA-12`
never compete.

## 1. Configuration — `gitland.tickets.sources`

- Entries become a union. Azure entries are unchanged (`{ organization, project, wiql? }`).
  Jira entries: `{ "type": "jira", "site": "https://acme.atlassian.net", "project": "DATA", "jql"?: "…" }`.
  `TicketSource` in `types.ts` becomes `AzureTicketSource | JiraTicketSource`; `isJiraSource(s)` = `s.type === 'jira'`.
  The Azure provider ignores Jira entries.
- Several Jira projects may be listed, on one or several sites.
- Default "My Tickets" JQL per source:
  `project = "<KEY>" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`.
  `jql` replaces it for that source. Results of all sources are merged, sorted by `updated` desc.
- `site` is normalized: trailing `/` removed, lower-cased host.
- **Ticket Sources…** (`src/commands/ticketSources.ts`) gets "Add Jira project…": ask the site URL,
  sign in (section 2), pick from `GET /project` (search box, key + name), then workspace or user scope —
  same flow and storage as Azure entries. Jira entries show as `Jira · DATA` with the site as description
  and can be removed like Azure ones.
- New setting `gitland.jira.transitionOnStartWork` (boolean, default `false`): on Start Work, run the first
  available transition whose target status category is `indeterminate` ("In Progress").
- `gitland.branch.prefixByType` default gains `"Story": "feature"`, `"Sub-task": "feature"`.

## 2. Flavour and authentication

- `*.atlassian.net` → **Cloud**: REST `/rest/api/3`, Basic auth `email:apiToken`. Input boxes for the email,
  then the API token (button "Create token" → `https://id.atlassian.com/manage-profile/security/api-tokens`).
- Any other site → **Server / Data Center**: REST `/rest/api/2`, `Authorization: Bearer <PAT>`. One input box
  (button "Create token" → `<site>/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens`).
- Stored in SecretStorage under `gitland.jira.token:<site>` as JSON `{ email?, token }`; `jiraTokenKey(site)` exported.
- Command `gitland.setJiraToken` ("Gitland: Set Jira Token"): pick one of the configured sites (or type one);
  empty token deletes it.
- `isSignedIn()` = a token exists for every configured site. A request with no token prompts once (like
  GitLab); cancelled → `AuthError(..., handled = true)`. HTTP 401 / 403 on `/myself` → `AuthError('Jira rejected
  the token for <site>. Run "Gitland: Set Jira Token".')`. Other errors → `Error('Jira: <message>')` from
  `errorMessages[0]` / `errors` / `message`.
- `signIn()` in `providers/index.ts` takes the provider (not only its kind) so the overlay can answer
  `{ command: 'gitland.setJiraToken', host: 'Jira' }` for ticket sign-in. The Tickets view uses the overlay's
  ticket sign-in; PR / pipeline sign-in stays the host's.

## 3. `JiraTickets` — ticket members

`ticketNoun = 'issue'`, `ticketSourceLabel = 'Jira · DATA, OPS'`, `ticketKind = 'jira'`.
`me()` caches `GET /myself` per site (`accountId` on Cloud, `name` on Server, `displayName`).

### Ticket
`id` = issue key, `title` = `summary`, `type` = `issuetype.name`, `state` = `status.name`,
`assignee` = `assignee.displayName`, `project` = project key, `org` = site, `url` = `<site>/browse/<KEY>`.
List / search use `POST /search` (Server) or `POST /search/jql` (Cloud) with
`fields: summary,issuetype,status,assignee,project,updated`, `maxResults: 50`.

### Ticket ids
- `KEY-123` (case-insensitive, key upper-cased) → that issue, any site whose sources include `KEY`
  (first configured site when unknown).
- Bare `123` / `#123` → `<first source project>-123`.
- `org` on ticket calls carries the site.

### `searchTickets(text)`
Id → `getTicket`; else JQL `project in (<keys>) AND text ~ "<escaped text>" ORDER BY updated DESC` per site.

### `getTicketDetails`
`GET /issue/<KEY>?expand=renderedFields` and `GET /issue/<KEY>/comment?expand=renderedBody&orderBy=created`.
- `format: 'html'`, `description` = `renderedFields.description` (rendered by Jira on both flavours — no ADF or
  wiki-markup converter). Rendered HTML goes through the existing HTML sanitizing of the ticket page.
- fields: Status, Priority, Reporter, Sprint (first `customfield_*` whose values have a sprint `name` /
  `state`, when present), Fix versions, Due date.
- tags: labels + components.
- related: `parent` (kind "parent"), `subtasks` ("child"), `issuelinks` (kind = `type.outward` / `type.inward`).
- comments: author `displayName`, `created`, `renderedBody`.
- `pullRequests: []` (Jira's development panel API is private). `changed` = `updated`.
Payload → `Ticket` / `TicketDetails` mapping lives in `src/providers/jiraMap.pure.ts`.

### Actions
- `ticketStates`: `GET /issue/<KEY>/transitions` → `{ name: transition.name, category: to.statusCategory.key }`.
- `setTicketState(name)`: `POST /issue/<KEY>/transitions` with the transition of that name.
- `assignTicketToMe`: `PUT /issue/<KEY>/assignee` with `{ accountId }` (Cloud) or `{ name }` (Server).
- `commentTicket`: `POST /issue/<KEY>/comment`; Cloud body = ADF doc with one paragraph per line, Server
  body = the plain string.
- `activateTicket`: used by Start Work when `gitland.jira.transitionOnStartWork` is on (the Azure setting
  keeps gating the Azure provider).

## 4. `TicketOverlay` — `src/providers/ticketOverlay.ts`

- Implements `Provider`. Ticket members (`ticketNoun`, `ticketSourceLabel`, `listMyTickets`, `searchTickets`,
  `getTicket`, `getTicketDetails`, `activateTicket`, `ticketStates`, `setTicketState`, `assignTicketToMe`,
  `commentTicket`, `ticketUrl`) → `JiraTickets`; all others → host. `kind` and `displayName` stay the host's.
- New optional `Provider` members: `ticketKind?: 'jira'` and `ticketKeys?: string[]` (configured project keys).
- `createPullRequest`: `ticketIds` are **not** forwarded to the host; the first ticket key prefixes the title
  (`DATA-123: …`) unless already present, so Jira's GitHub / GitLab / Azure integrations link it.
- Start Work's draft-PR offer (Azure only) uses the same rule.
- `getProvider` builds the overlay when `tickets.sources` (resolved for the repo's workspace folder) has Jira
  entries; the cache key adds a hash of `tickets.sources`.

## 5. Keys in branches, commits and links

- Branch template `${id}` gives `feature/DATA-123-fix-login`; `branch.<name>.gitlandTicket` stores the key.
- `src/links.ts` `findLinks` and `media/graph.js` `linksIn` (kept identical): when `ticketKeys` is set, match
  `\b(KEY)-(\d+)\b` for those keys only (so `UTF-8`, `SHA-256` never link) and stop treating `#n` as a ticket;
  PR rules unchanged. Webviews receive `links.ticketKeys`. Chips: `Jira DATA-123`.
- `src/linkTarget.pure.ts`: `<site>/browse/<KEY-n>` for a configured site → `{ kind: 'ticket', id, org: site }`,
  so it opens Gitland's ticket page. `LinkUrls` gains `ticketKeys?` / `jiraSites?`.
- Ticket labels: places printing `#${id}` (ticket page, history, Start Work titles / messages, new PR page)
  print the bare key when `ticketKind === 'jira'`. A small `ticketLabel(provider, id)` helper replaces the
  inline prefixes.
- Commit "link a ticket" reminder and new-PR linked tickets read ids through `findLinks`, so they get Jira keys.

## 6. Other call sites

- `package.json`: command `gitland.setJiraToken`, setting `gitland.jira.transitionOnStartWork`, `tickets.sources`
  item schema `oneOf` Azure / Jira, description / keywords mention Jira.
- Settings page: group `{ id: 'jira', title: 'Jira', prefixes: ['jira.'] }`.
- README: "Jira tickets" section (adding a source, Cloud vs Server tokens, keys in commits).

## 7. Testing

- Unit (`test/unit/jira.test.js`) on pure code: flavour detection, site normalization, id parsing and
  bare-number expansion, JQL building / text escaping, Cloud and Server payload → `Ticket` / `TicketDetails`,
  ADF comment body, sprint field detection.
- `test/unit/links.test.js`: Jira keys only for configured keys, `#n` not a ticket when Jira is on, PR rules intact.
- `test/unit/linkTarget.test.js`: `/browse/DATA-1` on a configured site → ticket; other sites → undefined.
- `npm run compile` and the whole unit suite green.
- Manual: `node test/runTest.js <repo> --real` with a Jira Cloud source on a GitHub or GitLab repo
  (Tickets view, Start Work, ticket page transitions / comment / assign, graph link chips).
  Server / DC is covered by unit tests on v2 payloads only.

## Out of scope

OAuth sign-in, creating Jira issues, board / sprint views, Jira's development panel (linked PRs on the ticket
page), mixing Jira with host tickets in one repository, Jira custom field configuration.
