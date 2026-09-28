# Gitland

A free, GitLens-style toolkit for VS Code, built for **Azure DevOps** (and GitHub).

## Features

| | |
|---|---|
| **Commit Graph** | Placed like GitLens: the **Graph** view at the top of the **Gitland sidebar** (activity bar), the **Graph** button in the status bar, and the first button of the Source Control title bar. *Show Commit Graph in Editor* for a full tab (`gitland.graph.layout`: `panel` | `editor`). Compact layout when narrow. Author pictures on each commit (Azure DevOps profile photo, GitHub avatar, Gravatar, else a generated default like GitLens). *Open Commit Graph in Editor* for a full tab. Colored lanes, branch/tag badges (local + remote merged into one when in sync), commit details with changed files → click to diff. Right-click a commit to branch, tag, cherry-pick, revert, reset or open it on the remote. Right-click a branch badge to checkout, push, create a PR, merge, rebase or delete it. Double-click a badge to check it out. `Ctrl+F` to search. |
| **Inline blame** | Author, age and message at the end of the current line, plus in the status bar. Hover it for links: show in graph, diff, file history, open on remote, copy SHA. |
| **CodeLens** | Above the file and each class/function: *Author, 3 days ago* (click → graph) and *N authors (X and others)* (click → file blame). |
| **File blame** (on demand) | `Ctrl+Alt+B` or the editor title button. GitLens-style annotations (message + age, heat bar: orange = recent, blue = old); lines from the same commit as the cursor are highlighted. `gitland.blame.toggleMode`: `file` or `window`. |
| **History** | Right-click in an editor: *Show File History* / *Show Line History* (works on selections). |
| **My Tickets** | Gitland activity bar → your open Azure Boards work items (or GitHub issues). Click one → create a branch `feature/1234-title` from the base you pick. The branch remembers its ticket. |
| **Pull Requests** | *Create Pull Request* pushes the branch, pre-fills the title from the ticket, links the work item and lists commits in the description. The view lists PRs by *mine / to review / others*; checkout any PR branch in one click. |

## Authentication

- **Azure DevOps**: uses your Microsoft work account through VS Code's built-in sign-in, **in the browser** by default (`gitland.azureDevOps.browserSignIn`): the Windows account dialog is often blocked on laptops the organization doesn't manage. The token is requested for the organization's own tenant, so the right account is used when several are signed in.
  If your organization blocks that, run **Gitland: Set Azure DevOps Personal Access Token** (scopes: *Work Items R/W*, *Code R/W*).
- **GitHub**: VS Code's built-in GitHub sign-in.

Tokens are stored in VS Code's secret storage.

## Settings

- `gitland.branch.template`: default `${prefix}/${id}-${title}`
- `gitland.branch.prefixByType`: e.g. `Bug → fix`
- `gitland.azureDevOps.wiql`: the query behind *My Tickets*
- `gitland.azureDevOps.activateOnStartWork`: move the work item to *Active* when you start it
- `gitland.blame.inline.format`: `${author}, ${ago} • ${message}`
- `gitland.codeLens.enabled`, `gitland.codeLens.scopes` (`document`, `containers`, `blocks`)
- `gitland.graph.layout` (`panel` | `editor`), `gitland.graph.statusBar.enabled`, `gitland.graph.avatars`, `gitland.blame.avatars`, `gitland.avatars.defaultStyle`
- `gitland.graph.maxCommits`, `gitland.pr.draftByDefault`

## Develop

```sh
npm install
npm run watch        # then F5 in VS Code ("Run Gitland")
npm run package      # builds gitland-x.y.z.vsix
code --install-extension gitland-0.1.0.vsix
```
