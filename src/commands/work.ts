import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { getProvider } from '../providers';
import { Provider, Ticket } from '../providers/types';
import { config, errorMessage, slugify } from '../util';
import { ticketIcon } from '../views/ticketsView';

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
  if (await repo.localBranchExists(branch)) {
    await repo.checkout(branch);
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
    await repo.exec(['checkout', '--no-track', '-b', branch, base]);
  }
  await repo.setConfig(`branch.${branch}.gitlandTicket`, ticket.id);
  await repo.setConfig(`branch.${branch}.gitlandTicketTitle`, ticket.title);

  if (provider?.activateTicket && config('azureDevOps.activateOnStartWork', false)) {
    provider.activateTicket(ticket.id).catch((e) => vscode.window.showWarningMessage(`Could not activate work item: ${errorMessage(e)}`));
  }
  const open = 'Open ticket';
  vscode.window.showInformationMessage(`Working on #${ticket.id} in branch '${branch}'.`, open).then((c) => {
    if (c === open) {
      vscode.env.openExternal(vscode.Uri.parse(ticket!.url));
    }
  });
  return true;
}
