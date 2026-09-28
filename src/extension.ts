import * as vscode from 'vscode';
import { BlameController } from './blame/blameController';
import { fileHistory, lineHistory } from './commands/history';
import { checkoutPullRequest, createPullRequest } from './commands/pullRequests';
import { startWork } from './commands/work';
import { RepoManager } from './git/repoManager';
import { GraphPanel, openCommitFileDiff } from './graph/graphPanel';
import { getProvider } from './providers';
import { PAT_SECRET_KEY } from './providers/azureDevOps';
import { errorMessage } from './util';
import { PullRequestItem, PullRequestsView } from './views/prsView';
import { TicketItem, TicketsView } from './views/ticketsView';

interface CommitArgs {
  repoRoot: string;
  sha: string;
  path?: string;
  previousPath?: string;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const repos = new RepoManager();
  await repos.init();
  const { secrets } = context;

  const blame = new BlameController(repos);
  const tickets = new TicketsView(repos, secrets);
  const prs = new PullRequestsView(repos, secrets);

  let lastRoot: string | undefined;
  const repoFor = async (root?: string) => (root ? repos.getRepo(vscode.Uri.file(root)) : repos.activeRepo());

  /** Registers a command whose errors are shown to the user instead of failing silently. */
  const command = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch (e) {
        vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`);
      }
    });

  context.subscriptions.push(
    repos,
    blame,
    tickets,
    prs,

    command('gitland.showGraph', async (arg?: Partial<CommitArgs>) => {
      const repo = await repoFor(arg?.repoRoot);
      if (!repo) {
        vscode.window.showWarningMessage('Gitland: no git repository found in this workspace.');
        return;
      }
      GraphPanel.show(context, repos, repo, arg?.sha);
    }),
    command('gitland.toggleFileBlame', () => blame.toggleFileBlame()),
    command('gitland.toggleInlineBlame', () => blame.toggleInline()),
    command('gitland.fileHistory', (arg?: unknown) => fileHistory(repos, arg)),
    command('gitland.lineHistory', () => lineHistory(repos)),

    command('gitland.openCommitFileDiff', async (a: CommitArgs) => {
      const repo = await repoFor(a.repoRoot);
      if (repo && a.path) {
        await openCommitFileDiff(repos, repo, a.sha, a.path, a.previousPath, a.previousPath ? 'M' : 'A');
      }
    }),
    command('gitland.openCommitOnRemote', async (a: CommitArgs) => {
      const repo = await repoFor(a.repoRoot);
      const provider = repo && (await getProvider(repo, secrets));
      if (!provider) {
        vscode.window.showInformationMessage('Gitland: no Azure DevOps / GitHub remote found.');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(provider.commitUrl(a.sha)));
    }),
    command('gitland.copyText', async (text: string) => {
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage('Gitland: copied to clipboard', 2000);
    }),

    command('gitland.tickets.refresh', () => tickets.refresh()),
    command('gitland.tickets.startWork', async (item?: TicketItem) => {
      if (await startWork(repos, secrets, item?.ticket)) {
        tickets.refresh();
      }
    }),
    command('gitland.tickets.startWorkById', async () => {
      if (await startWork(repos, secrets)) {
        tickets.refresh();
      }
    }),
    command('gitland.tickets.open', (item: TicketItem) => vscode.env.openExternal(vscode.Uri.parse(item.ticket.url))),
    command('gitland.tickets.copyId', (item: TicketItem) => vscode.env.clipboard.writeText(item.ticket.id)),

    command('gitland.prs.refresh', () => prs.refresh()),
    command('gitland.prs.create', async (repoRoot?: string) => {
      if (await createPullRequest(repos, secrets, typeof repoRoot === 'string' ? repoRoot : undefined)) {
        prs.refresh();
      }
    }),
    command('gitland.prs.open', (item: PullRequestItem) => vscode.env.openExternal(vscode.Uri.parse(item.pr.url))),
    command('gitland.prs.checkout', async (item: PullRequestItem) => {
      const repo = await repos.activeRepo();
      if (repo) {
        await checkoutPullRequest(repo, item.pr);
        prs.refresh();
      }
    }),

    command('gitland.setAzurePat', async () => {
      const pat = await vscode.window.showInputBox({
        title: 'Azure DevOps Personal Access Token',
        prompt:
          'Scopes needed: Work Items (Read & write) and Code (Read & write). Leave empty to use your Microsoft account sign-in instead.',
        password: true,
        ignoreFocusOut: true,
      });
      if (pat === undefined) {
        return;
      }
      if (pat.trim()) {
        await secrets.store(PAT_SECRET_KEY, pat.trim());
        vscode.window.showInformationMessage('Gitland: Azure DevOps token saved.');
      } else {
        await secrets.delete(PAT_SECRET_KEY);
      }
      tickets.refresh();
      prs.refresh();
    }),
    command('gitland.clearCredentials', async () => {
      await secrets.delete(PAT_SECRET_KEY);
      vscode.window.showInformationMessage('Gitland: stored credentials cleared.');
      tickets.refresh();
      prs.refresh();
    }),

    vscode.window.onDidChangeActiveTextEditor(async (e) => {
      // Switching to a file of another repository refreshes the tickets / PR views.
      if (!e || e.document.uri.scheme !== 'file') {
        return;
      }
      const repo = await repos.getRepo(e.document.uri);
      if (repo && repo.root !== lastRoot) {
        lastRoot = repo.root;
        tickets.refresh();
        prs.refresh();
      }
    }),
  );
  lastRoot = (await repos.activeRepo(false))?.root;
}

export function deactivate(): void {
  /* disposables are cleaned up by VS Code */
}
