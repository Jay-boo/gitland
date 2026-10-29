# Gitland setup

Sign-in for each host and the main settings. Every setting is also in **Gitland: Settings**, grouped by feature.

## Authentication

- **Azure DevOps**: uses your Microsoft work account through VS Code's built-in sign-in, **in the browser** by default (`gitland.azureDevOps.browserSignIn`): the Windows account dialog is often blocked on laptops the organization doesn't manage. The token is requested for the organization's own tenant, so the right account is used when several are signed in.
  If your organization blocks that, run **Gitland: Set Azure DevOps Personal Access Token** (scopes: *Work Items R/W*, *Code R/W*).
- **GitHub**: VS Code's built-in GitHub sign-in.
- **GitLab** (gitlab.com and self-hosted): a personal access token with the *api* scope, per host. Gitland asks for it the first time it needs it, or run **Gitland: Set GitLab Token**. Remotes on `gitlab.com` and on hosts named `gitlab.*` are recognized; add other self-hosted instances to `gitland.gitlab.hosts` (e.g. `["git.mycompany.com"]`). Issues are the tickets, merge requests the pull requests (`!42`), GitLab CI the pipelines (one row per stage, its jobs inside).
- **Jira** (Cloud and Server / Data Center), for tickets only, on any code host: ⚙ **Ticket Sources…** in the Tickets view → **Add a Jira project…**, enter the site (`https://your-company.atlassian.net`, or your Jira Server address with its path, e.g. `https://jira.mycompany.com/jira`) and pick the project. Jira Cloud asks for your Atlassian email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens); Server / Data Center asks for a personal access token (**Gitland: Set Jira Token** changes it). Jira issues then replace the host's tickets (Tickets view, *Start work*, ticket tab, search); pull requests and pipelines stay on Azure DevOps / GitHub / GitLab. Branches are named after the key (`feature/DATA-12-fix-login`), keys of the configured projects in commit messages link to the ticket tab, and a pull request created from such a branch starts its title with the key, so Jira's own integrations link it. `gitland.jira.transitionOnStartWork` moves the issue to *In Progress* on *Start work*.

Tokens are stored in VS Code's secret storage.

## Settings

- `gitland.branch.template`: default `${prefix}/${id}-${title}`
- `gitland.branch.prefixByType`: e.g. `Bug → fix`
- `gitland.azureDevOps.wiql`: the query behind *My Tickets*
- `gitland.azureDevOps.activateOnStartWork`: move the work item to *Active* when you start it
- `gitland.blame.inline.format`: `${author}, ${ago} • ${message}`
- `gitland.codeLens.enabled`, `gitland.codeLens.scopes` (`document`, `containers`, `blocks`)
- `gitland.graph.layout` (`panel` | `editor`), `gitland.graph.statusBar.enabled`, `gitland.graph.avatars`, `gitland.graph.showStashes`, `gitland.blame.avatars`, `gitland.avatars.defaultStyle`
- `gitland.graph.maxCommits`, `gitland.pr.draftByDefault`
- `gitland.changes.ticketReminder`: offer to link a ticket before committing on a branch without one
