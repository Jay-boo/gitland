import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { checkoutRef } from '../graph/graphPanel';
import { getProvider } from '../providers';
import { PullRequest } from '../providers/types';
import { config } from '../util';

function ticketIdFromBranch(branch: string): string | undefined {
  const m = /(?:^|[/_-])#?(\d{1,7})(?=$|[/_-])/.exec(branch);
  return m?.[1];
}

function humanize(branch: string): string {
  const last = branch.split('/').pop() ?? branch;
  const words = last.replace(/^\d+[-_]?/, '').replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : branch;
}

export async function createPullRequest(repos: RepoManager, secrets: vscode.SecretStorage, repoRoot?: string): Promise<boolean> {
  const repo = repoRoot ? await repos.getRepo(vscode.Uri.file(repoRoot)) : await repos.activeRepo();
  if (!repo) {
    vscode.window.showWarningMessage('Gitland: no git repository found.');
    return false;
  }
  const provider = await getProvider(repo, secrets);
  if (!provider) {
    vscode.window.showWarningMessage('Gitland: no Azure DevOps or GitHub remote found for this repository.');
    return false;
  }
  const branch = await repo.currentBranch();
  if (!branch) {
    vscode.window.showWarningMessage('Gitland: checkout a branch before creating a pull request.');
    return false;
  }

  const existingPromise = provider.listPullRequests().then((prs) => prs.find((p) => p.sourceBranch === branch));
  const remote = (await repo.defaultRemote()) ?? 'origin';
  const [branches, def] = await Promise.all([repo.branches(), repo.defaultBranch(remote)]);

  const existing = await existingPromise;
  if (existing) {
    const open = 'Open pull request';
    const choice = await vscode.window.showInformationMessage(
      `A pull request already exists for '${branch}': ${existing.label} ${existing.title}`,
      open,
    );
    if (choice === open) {
      await vscode.env.openExternal(vscode.Uri.parse(existing.url));
    }
    return false;
  }

  // Target branch
  const targets = branches
    .filter((b) => b.remote && b.shortName.startsWith(remote + '/'))
    .map((b) => b.shortName.slice(remote.length + 1))
    .filter((b) => b !== branch);
  targets.sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));
  const target = await vscode.window.showQuickPick(
    targets.map((t) => ({ label: `$(git-branch) ${t}`, description: t === def ? 'default' : '', t })),
    { placeHolder: `Merge '${branch}' into…`, title: 'Create Pull Request (1/3)' },
  );
  if (!target) {
    return false;
  }

  // Ticket + title
  const ticketId = (await repo.getConfig(`branch.${branch}.gitlandTicket`)) ?? ticketIdFromBranch(branch);
  let ticketTitle = await repo.getConfig(`branch.${branch}.gitlandTicketTitle`);
  if (ticketId && !ticketTitle) {
    ticketTitle = (await provider.getTicket(ticketId).catch(() => undefined))?.title;
  }
  const base = `${remote}/${target.t}`;
  let commits: string[] = [];
  try {
    commits = (await repo.exec(['log', '--format=%s', '--no-merges', `${base}..HEAD`])).split('\n').filter(Boolean);
  } catch {
    /* target not fetched */
  }
  const defaultTitle = ticketTitle ?? (commits.length === 1 ? commits[0] : humanize(branch));
  const title = await vscode.window.showInputBox({
    title: 'Create Pull Request (2/3)',
    prompt: `Title${ticketId ? ` — linked to ${provider.ticketNoun} #${ticketId}` : ''}`,
    value: defaultTitle,
    validateInput: (v) => (v.trim() ? undefined : 'Title is required'),
  });
  if (!title) {
    return false;
  }

  const draftDefault = config('pr.draftByDefault', false);
  const mode = await vscode.window.showQuickPick(
    [
      { label: '$(git-pull-request) Create', draft: false, picked: !draftDefault },
      { label: '$(git-pull-request-draft) Create as draft', draft: true, picked: draftDefault },
    ].sort((a, b) => Number(b.picked) - Number(a.picked)),
    { title: 'Create Pull Request (3/3)', placeHolder: `${branch} → ${target.t} · ${commits.length} commit(s)` },
  );
  if (!mode) {
    return false;
  }

  const description = commits.length ? commits.map((c) => `- ${c}`).join('\n') : '';
  const pr = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Creating pull request…' },
    async (progress) => {
      const { upstream, ahead } = await repo.aheadBehind(branch);
      if (!upstream || ahead > 0) {
        progress.report({ message: `pushing ${branch}…` });
        await repo.push(remote, branch, !upstream);
      }
      progress.report({ message: 'creating…' });
      return provider.createPullRequest({
        source: branch,
        target: target.t,
        title: title.trim(),
        description,
        draft: mode.draft,
        ticketIds: ticketId ? [ticketId] : [],
      });
    },
  );
  const open = 'Open in browser';
  const copy = 'Copy link';
  vscode.window.showInformationMessage(`Pull request ${pr.label} created: ${pr.title}`, open, copy).then((c) => {
    if (c === open) {
      vscode.env.openExternal(vscode.Uri.parse(pr.url));
    } else if (c === copy) {
      vscode.env.clipboard.writeText(pr.url);
    }
  });
  return true;
}

export async function checkoutPullRequest(repo: Repo, pr: PullRequest): Promise<void> {
  const remote = (await repo.defaultRemote()) ?? 'origin';
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Checking out ${pr.label}…` },
    async () => {
      await repo.fetch().catch(() => undefined);
      if (await repo.localBranchExists(pr.sourceBranch)) {
        await repo.checkout(pr.sourceBranch);
        try {
          await repo.exec(['merge', '--ff-only', `${remote}/${pr.sourceBranch}`]);
        } catch {
          /* local branch diverged; leave it */
        }
      } else {
        await checkoutRef(repo, `${remote}/${pr.sourceBranch}`, true);
      }
    },
  );
}
