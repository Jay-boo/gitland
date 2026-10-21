import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { getProvider } from '../providers';
import { Provider, Ticket } from '../providers/types';
import { config, errorMessage, slugify } from '../util';
import { ticketIcon } from '../views/ticketsView';
import { createWorktree, listWorktrees, openFolderInNewWindow } from './worktrees';

export async function pickTicket(provider: Provider): Promise<Ticket | undefined> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { ticket?: Ticket }>();
  qp.placeholder = `Pick one of your ${provider.ticketNoun}s, or type an ID / text to search`;
  qp.matchOnDescription = true;
  qp.busy = true;
  const toItems = (tickets: Ticket[]) =>
    tickets.map((t) => ({
      label: `$(${ticketIcon(t.type).id}) ${t.title}`,
      description: `#${t.id} · ${t.type} · ${t.state}`,
      ticket: t,
      alwaysShow: true,
    }));
  let mine: ReturnType<typeof toItems> = [];
  provider
    .listMyTickets()
    .then((t) => {
      mine = toItems(t);
      if (!qp.value) {
        qp.items = mine;
      }
    })
    .catch((e) => (qp.placeholder = `Could not load your ${provider.ticketNoun}s: ${errorMessage(e)} — type an ID`))
    .finally(() => (qp.busy = false));

  let timer: NodeJS.Timeout | undefined;
  let seq = 0;
  qp.onDidChangeValue((value) => {
    clearTimeout(timer);
    if (!value.trim()) {
      qp.items = mine;
      return;
    }
    const lower = value.toLowerCase();
    qp.items = mine.filter((i) => `${i.label} ${i.description}`.toLowerCase().includes(lower));
    timer = setTimeout(async () => {
      const my = ++seq;
      qp.busy = true;
      try {
        const found = await provider.searchTickets(value);
        if (my === seq) {
          const known = new Set(qp.items.map((i) => i.ticket?.id));
          qp.items = [...qp.items, ...toItems(found).filter((i) => !known.has(i.ticket.id))];
        }
      } catch {
        /* keep local results */
      } finally {
        if (my === seq) {
          qp.busy = false;
        }
      }
    }, 350);
  });

  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]?.ticket);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

export function branchNameFor(ticket: Ticket, user?: string): string {
  const prefixes = config<Record<string, string>>('branch.prefixByType', {});
  const prefix = prefixes[ticket.type] ?? 'feature';
  return config('branch.template', '${prefix}/${id}-${title}')
    .replace(/\$\{prefix\}/g, prefix)
    .replace(/\$\{id\}/g, ticket.id)
    .replace(/\$\{title\}/g, slugify(ticket.title))
    .replace(/\$\{user\}/g, slugify(user ?? 'me', 20))
    .replace(/\/{2,}/g, '/')
    .replace(/-+$/, '');
}

async function pickBaseBranch(repo: Repo, remote: string | undefined): Promise<string | undefined> {
  const [branches, def, current] = await Promise.all([repo.branches(), repo.defaultBranch(remote), repo.currentBranch()]);
  const items: (vscode.QuickPickItem & { ref: string })[] = [];
  const seen = new Set<string>();
  const add = (ref: string, description: string) => {
    if (!seen.has(ref)) {
      seen.add(ref);
      items.push({ label: `$(git-branch) ${ref}`, description, ref });
    }
  };
  if (def) {
    const remoteDef = remote ? `${remote}/${def}` : def;
    add(branches.some((b) => b.shortName === remoteDef) ? remoteDef : def, 'default branch');
  }
  if (current) {
    add(current, 'current branch');
  }
  branches.filter((b) => b.remote).forEach((b) => add(b.shortName, 'remote'));
  branches.filter((b) => !b.remote).forEach((b) => add(b.shortName, 'local'));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Create the branch from…', matchOnDescription: true });
  return pick?.ref;
}

/**
 * Like GitLens' Start Work: switch this folder to the branch, or put it in its own worktree (a separate
 * folder and window) so another ticket — yours or an agent's — keeps going untouched in this one.
 */
async function pickWhere(repo: Repo, ticket: Ticket, create: boolean): Promise<'here' | 'worktree' | undefined> {
  const [current, dirty] = await Promise.all([repo.currentBranch(), repo.isDirty()]);
  const currentTicket = current ? await repo.getConfig(`branch.${current}.gitlandTicket`) : undefined;
  const busy = currentTicket && currentTicket !== ticket.id ? `#${currentTicket} keeps going in this window` : dirty ? 'your uncommitted changes stay in this window' : 'a separate folder, opened in a new window';
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: create ? '$(git-branch) Create & switch to branch' : '$(git-branch) Switch to branch',
        description: current ? `replaces ${current} in this window` : '',
        where: 'here' as const,
      },
      {
        label: create ? '$(folder-opened) Create branch in a new worktree' : '$(folder-opened) Open branch in a new worktree',
        description: busy,
        where: 'worktree' as const,
      },
    ],
    { placeHolder: `#${ticket.id} ${ticket.title}` },
  );
  return pick?.where;
}

export async function startWork(repos: RepoManager, secrets: vscode.SecretStorage, ticket?: Ticket): Promise<boolean> {
  const repo = await repos.activeRepo();
  if (!repo) {
    vscode.window.showWarningMessage('Gitland: no git repository found.');
    return false;
  }
  const provider = await getProvider(repo, secrets);
  if (!ticket) {
    if (!provider) {
      vscode.window.showWarningMessage('Gitland: no Azure DevOps or GitHub remote found for this repository.');
      return false;
    }
    ticket = await pickTicket(provider);
    if (!ticket) {
      return false;
    }
  }

  // Already have a branch for this ticket? Offer to switch to it.
  const branches = await repo.branches();
  const linked: string[] = [];
  for (const b of branches.filter((x) => !x.remote)) {
    if ((await repo.getConfig(`branch.${b.shortName}.gitlandTicket`)) === ticket.id) {
      linked.push(b.shortName);
    }
  }
  if (linked.length) {
    const choice = await vscode.window.showQuickPick(
      [
        ...linked.map((b) => ({ label: `$(git-branch) ${b}`, description: 'existing branch for this ticket', branch: b })),
        { label: '$(add) Create a new branch…', description: '', branch: '' },
      ],
      { placeHolder: `#${ticket.id} ${ticket.title}` },
    );
    if (!choice) {
      return false;
    }
    if (choice.branch) {
      // Already checked out in another worktree (e.g. a second ticket in parallel): open that window.
      const wt = (await listWorktrees(repo)).find((w) => w.branch === choice.branch);
      if (wt && wt.path !== repo.root) {
        await openFolderInNewWindow(wt.path);
        return true;
      }
      if (wt) {
        vscode.window.setStatusBarMessage(`Gitland: already on ${choice.branch}`, 4000);
        return true;
      }
      const where = await pickWhere(repo, ticket, false);
      if (!where) {
        return false;
      }
      if (where === 'worktree') {
        const folder = await createWorktree(repo, choice.branch);
        if (folder) {
          await openFolderInNewWindow(folder);
        }
        return !!folder;
      }
      await repo.checkout(choice.branch);
      vscode.window.setStatusBarMessage(`Gitland: switched to ${choice.branch}`, 4000);
      return true;
    }
  }

  const name = await vscode.window.showInputBox({
    title: `Start work on #${ticket.id}: ${ticket.title}`,
    prompt: 'Branch name',
    value: branchNameFor(ticket, await repo.getConfig('user.name')),
    validateInput: (v) =>
      !v.trim() || /[\s~^:?*[\\]|\.\.|@\{|\/$|\.lock$|^-/.test(v.trim()) ? 'Invalid branch name' : undefined,
  });
  if (!name) {
    return false;
  }
  const branch = name.trim();
  const exists = await repo.localBranchExists(branch);
  const where = await pickWhere(repo, ticket, !exists);
  if (!where) {
    return false;
  }
  let worktree: string | undefined;
  /** Branch a draft pull request would target: the base the new branch starts from. */
  let prTarget: string | undefined;
  let prRemote: string | undefined;
  if (exists) {
    if (where === 'worktree') {
      worktree = await createWorktree(repo, branch);
      if (!worktree) {
        return false;
      }
    } else {
      await repo.checkout(branch);
    }
  } else {
    const remote = await repo.defaultRemote();
    if (remote && config('branch.fetchBeforeCreate', true)) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Gitland: fetching…' },
        () => repo.fetch().catch(() => undefined),
      );
    }
    const base = await pickBaseBranch(repo, remote);
    if (!base) {
      return false;
    }
    prRemote = remote;
    prTarget = remote && base.startsWith(`${remote}/`) ? base.slice(remote.length + 1) : base;
    if (where === 'worktree') {
      worktree = await createWorktree(repo, branch, { startPoint: base });
      if (!worktree) {
        return false;
      }
    } else {
      await repo.exec(['checkout', '--no-track', '-b', branch, base]);
    }
  }
  await repo.setConfig(`branch.${branch}.gitlandTicket`, ticket.id);
  await repo.setConfig(`branch.${branch}.gitlandTicketTitle`, ticket.title);

  if (provider?.activateTicket && config('azureDevOps.activateOnStartWork', false)) {
    provider.activateTicket(ticket.id, ticket.org).catch((e) => vscode.window.showWarningMessage(`Could not activate work item: ${errorMessage(e)}`));
  }
  // GitHub refuses a pull request with no commits; Azure DevOps accepts a draft right away.
  if (provider?.kind === 'azure' && prTarget && prRemote) {
    await offerDraftPullRequest(repo, provider, ticket, branch, prTarget, prRemote);
  }
  if (worktree) {
    // Git config is shared by all worktrees, so the new window already sees the ticket link.
    await openFolderInNewWindow(worktree);
  }
  const open = 'Open ticket';
  const msg = worktree
    ? `Working on #${ticket.id} in branch '${branch}', in a new window (${worktree}).`
    : `Working on #${ticket.id} in branch '${branch}'.`;
  vscode.window.showInformationMessage(msg, open).then((c) => {
    if (c === open) {
      vscode.env.openExternal(vscode.Uri.parse(ticket!.url));
    }
  });
  return true;
}

/** Last step of Start work: optionally push the new branch and open a draft pull request linked to the ticket. */
async function offerDraftPullRequest(repo: Repo, provider: Provider, ticket: Ticket, branch: string, target: string, remote: string): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(git-branch) Branch only', draft: false },
      { label: '$(git-pull-request-draft) Branch + draft pull request', description: `into ${target}, linked to #${ticket.id}`, draft: true },
    ],
    { placeHolder: `Also create a draft pull request for ${branch}?` },
  );
  if (!pick?.draft) {
    return;
  }
  try {
    const pr = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Gitland: creating the draft pull request…' }, async () => {
      await repo.exec(['push', '-u', remote, branch]);
      return provider.createPullRequest({ source: branch, target, title: ticket.title, description: '', draft: true, ticketIds: [ticket.id], addMeAsReviewer: false });
    });
    const open = 'Open';
    vscode.window.showInformationMessage(`Draft pull request ${pr.label} created.`, open).then((c) => {
      if (c === open) {
        vscode.env.openExternal(vscode.Uri.parse(pr.url));
      }
    });
  } catch (e) {
    vscode.window.showWarningMessage(`Gitland: no draft pull request (${errorMessage(e)}). The branch is kept; create the pull request after your first commit.`);
  }
}
