# Gitland features

Everything Gitland does, view by view. Short tour with GIFs: [README](../README.md). Sign-in and settings: [setup.md](setup.md).

- [Commit Graph](#commit-graph)
- [Inline blame](#inline-blame)
- [CodeLens](#codelens)
- [File blame (on demand)](#file-blame-on-demand)
- [History](#history)
- [Changes](#changes)
- [My Tickets](#my-tickets)
- [Pull Requests](#pull-requests)
- [Releases](#releases)
- [Rebase, conflicts, cleanup, worktrees](#rebase-conflicts-cleanup-worktrees)
- [CI & reviews](#ci--reviews)
- [Pipelines](#pipelines)
- [Settings](#settings)
- [Search & dashboard](#search--dashboard)
- [Signing & hooks](#signing--hooks)

## Commit Graph

![Commit Graph](../media/readme/graph.gif)

**Where**
- The **Graph** view at the top of the Gitland sidebar, the **Graph** button in the status bar, and the first button of the Source Control title bar.
- A **Commit Graph** tab in the bottom panel, or *Show Commit Graph in Editor* for a full tab (`gitland.graph.layout`: `panel` | `editor`). Compact layout when narrow.

**What you see**
- Lanes colored by branch kind: main blue, dev green, feature violet, fix rose, hotfix red, release amber, chore slate; other names keep a stable color.
- Branch and tag badges (local + remote merged into one when in sync), open pull requests next to their branch (in review / approved / changes requested / draft), CI status on each commit.
- Author pictures: Azure DevOps profile photo, GitHub avatar, Gravatar, else a picture drawn locally in the graph colors. *Gitland: Choose Author Picture Style* previews them: pixel, geometric, marble, rings, initials (drawn locally), the 30 [DiceBear](https://www.dicebear.com) styles with their *neutral* face-only versions (downloaded once and cached), or Gravatar's robots…
- Stashes, an activity minimap (click a bar to jump to that day), a bubble with the number of uncommitted changes.
- Hover a commit for a card with the full message (markdown), stats and links to the pull requests / work items it mentions.

**Views and filters**
- **View mode**: *All* branches, one *Branch* history, or its *Timeline* — the main line only, one row per merged branch / pull request (click the chip to see what it brought).
- Click a branch/tag badge (or pick one from **Branches**, with filtering) to focus on it: its history stays bright, the rest fades; `Esc` shows everything again. **Branches** lists every branch and tag, even older than the loaded commits.
- **Filter**: only my commits, hide merges, last 7/30/90/365 days, by author — the graph stays connected. `Ctrl+F` to search.
- Drag column edges to resize them (double-click to reset).

**Actions**
- Commit details with changed files → click to diff.
- Right-click a commit to branch, tag, cherry-pick, revert, reset or open it on the remote; a branch badge to checkout, push, create a PR, merge, rebase or delete it. Double-click a badge to check it out. **Drag** a badge onto another to merge or rebase.
- Stashes: apply, pop, branch, drop.
- **Compare** branches or tags (toolbar, or right-click a badge → *Compare with…* / *Compare with the previous tag*): commits on each side, pull requests merged, files changed with their diffs, where they diverged, and *Copy release notes* as markdown. Or select a commit, then `Ctrl+click` another to list the files changed between them.

**Keyboard**: `↑/↓` or `j/k` move, `Home`/`End`, `PgUp`/`PgDn`, `Enter`/`Space` show the details, `←`/`→` parent / child, `m` merge base with the current branch, `c` compare with the next commit you pick, `?` lists the shortcuts.

## Inline blame

![Inline blame](../media/readme/blame.gif)

Author, age and message at the end of the current line, plus in the status bar. Hover it (or a file blame block) for the author (in their color), age, nearest branch, **the pull request that brought the change**, the full commit message as markdown, files changed with +/− lines, links to the pull requests / work items it mentions, and actions: show in graph, changes, file history, open on remote, copy SHA.

## CodeLens

Above the file and each class/function: *Author, 3 days ago* (click → graph) and *N authors (X and others)* (click → file blame).

## File blame (on demand)

`Ctrl+Alt+B` or the editor title button. GitLens-style annotations (message + age, heat bar: orange = recent, blue = old); lines from the same commit as the cursor are highlighted. `gitland.blame.toggleMode`: `file` or `window`.

## History

![History](../media/readme/explain.gif)

*Show File History* / *Show Line History* (right-click in an editor, or from a blame hover) opens a timeline: every commit that touched the file or the selected lines, with the diff of those lines (lines) or of the file (click to expand), PR / ticket chips, renames followed; diff with the previous version or the working tree, open the file at a version, tick two versions to compare them. ✨ **Explain** — *Why are these lines like this?* / *Explain this file's history*, on a commit (graph details) or from the blame hover (*Why?*): an AI summary from the commits, their diffs and the tickets / PRs they mention.

## Changes

Gitland sidebar → stage / unstage / discard files (hover buttons, double-click to stage), click a file for its diff. Commit box in the graph style: ✨ **generate the message with AI** from the diff (Copilot or any VS Code language model; follows your repo's style, adds the ticket; `Ctrl+Alt+G`; `gitland.changes.commitMessageInstructions` e.g. "Write in French"), subject length counter, the branch's ticket as a chip (click to add `AB#1234`), *Amend*, `Ctrl+Enter` to commit, `Ctrl+Shift+Enter` to commit & push. Ahead/behind with pull, push, sync and fetch.

## My Tickets

![My Tickets](../media/readme/tickets.gif)

Gitland activity bar → your open Azure Boards work items (or GitHub / GitLab issues). Click one to **see it in a tab**: description, acceptance criteria, comments, linked PRs, and the branches / commits of the repo that mention it. *Start work* (hover button) creates a branch `feature/1234-title` from the base you pick. The branch remembers its ticket. Tickets in another project than the code (a shared backlog)? ⚙ **Ticket Sources…** in the view adds Azure DevOps projects (even from other organizations), or **Jira** projects (see below). The ticket of your branch shows in the status bar (click to see it). From the ticket tab: change its **state**, **assign it to you**, **comment**. *Start work* can also push the branch and open a **draft pull request** linked to the ticket. Committing on a branch with no ticket? Gitland offers to link one (`gitland.changes.ticketReminder`).

## Pull Requests

*Create Pull Request* opens a form: target branch, title, and the description pre-filled with **the repository's PR template** (`.azuredevops/` / `.github/pull_request_template.md`, read from the target branch). ✨ *Generate* writes the title and description with AI (Copilot or any VS Code language model) from the commits and the diff, **following the template** (sections filled in, checkboxes ticked only when they apply); preview the markdown, link the branch's ticket, create as draft. It pushes the branch and opens the new PR. The view lists PRs by *mine / to review / others* with their review state; click one to **see it in a tab** (description, reviewers and votes, work items, commits, discussion, *Checkout*, *Files changed*). The PR of your branch shows in the status bar.

## Releases

![Releases](../media/readme/compare.gif)

Gitland sidebar → your tags, newest version first, with the commits and PRs each one added and what is *not released yet*. Click one to compare it with the previous release; ✨ **release notes** written with AI in the style of your `CHANGELOG.md` (copy, or insert into CHANGELOG.md for review). **New release…** suggests the next version from the commits (feat → minor, breaking → major), writes the notes, creates an annotated tag (optionally after committing the CHANGELOG) and pushes it. Commit hovers and details say which release first shipped a commit (*3.7.1* / *not released yet*).

## Rebase, conflicts, cleanup, worktrees

*Interactive rebase* (right-click a commit → *from here*, or the command): reorder by drag and drop, pick / reword (edit the message inline) / squash / fixup / edit / drop, with a warning when pushed commits get rewritten. A merge / rebase / cherry-pick in progress shows in the **Changes** view with *Continue / Skip / Abort*, and each conflicted file can keep a side, open the merge editor or be marked resolved. *Clean up branches* lists merged, gone (remote deleted) and stale branches, local and remote, to delete in bulk (main, dev, release/* and the current branch are protected). *Open in a new worktree* (right-click a branch) checks it out in its own folder and window.

## CI & reviews

CI status (Azure Pipelines / GitHub Actions / GitLab CI) next to each commit of the graph (✓ / ✗ / ⟳, click to open the run), in the commit card and details, on the pull request page (*Checks*), and for the current branch in the status bar. Review from the PR page: approve / approve with suggestions / wait for author / reject / reset, comment, reply to and resolve threads, publish a draft, complete (squash, merge, rebase…, optionally deleting the branch) or abandon.

## Pipelines

Gitland sidebar → the CI runs (Azure Pipelines / GitHub Actions / GitLab CI) of your branch: state, commit, duration. **Rerun**, **cancel**, open in the browser; click a run to see its jobs and steps and the end of the failed step's log. Refreshes every 30 s while something runs.

## Settings

*Gitland: Settings* (or the gear in the Changes view): every Gitland setting grouped by feature, with switches and lists, saved to your user settings.

## Search & dashboard

![Search & dashboard](../media/readme/dashboard.gif)

*Search Everywhere* (`Ctrl+Alt+Shift+F`, or 🔍 on the Graph view): branches and tags, commits (message, author, SHA), commits that added or removed some text (`git log -S`), pull requests and tickets; prefixes `b:` `c:` `s:` `pr:` `t:`. *Dashboard*: what needs you — PRs to review, your PRs with their votes and CI, tickets in progress, your branches (not pushed, ahead / behind, merged) with one-click checkout, push, PR or delete.

## Signing & hooks

Signed commits show in the commit details (verified, untrusted key, key not available, bad signature). The Changes view has a *Sign* switch when a signing key is configured, shows the commit hooks the repo runs, and when a hook refuses the commit, its output with *Retry* / *Commit anyway (skip hooks)*.
