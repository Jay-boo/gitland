import * as vscode from 'vscode';
import { BlameController } from './blame/blameController';
import { BlameCodeLensProvider } from './blame/codeLens';
import { fileHistory, lineHistory } from './commands/history';
import { checkoutPullRequest, createPullRequest } from './commands/pullRequests';
import { startWork } from './commands/work';
import { RepoManager } from './git/repoManager';
import { GraphManager, openCommitFileDiff } from './graph/graphPanel';
import { AvatarService } from './avatars';
import { getProvider } from './providers';
import { AzureDevOpsProvider, PAT_SECRET_KEY, patSecretKey, signInToAzureDevOps } from './providers/azureDevOps';
import { GITHUB_SCOPES } from './providers/github';
import { AuthError } from './providers/types';
import { initLog, log } from './log';
import { errorMessage } from './util';
import { PullRequestItem, PullRequestsView } from './views/prsView';
import { TicketItem, TicketsView } from './views/ticketsView';

interface CommitArgs {
  repoRoot: string;
  sha: string;
  path?: string;
  previousPath?: string;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(initLog());
  log.info(`Gitland ${context.extension.packageJSON.version} activating…`);
  const repos = new RepoManager();
  // Discovery runs in the background: commands must be registered right away.
  repos.init().catch((e) => log.error('Repository discovery failed', e));
  const { secrets } = context;

  const avatars = new AvatarService(context);
  const graph = new GraphManager(context, repos, avatars);
  const blame = new BlameController(repos, avatars);
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
        log.error(`Command ${id} failed`, e);
        if (!(e instanceof AuthError && e.handled)) {
          vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`);
        }
      }
    });

  /** Azure DevOps organization of the active repository, if any. */
  const activeAzureOrg = async (): Promise<string | undefined> => {
    const repo = await repos.activeRepo();
    const provider = repo && (await getProvider(repo, secrets));
    return provider instanceof AzureDevOpsProvider ? provider.organization : undefined;
  };
  const refreshViews = () => {
    tickets.refresh();
    prs.refresh();
  };

  context.subscriptions.push(
    repos,
    avatars,
    graph,
    vscode.window.registerWebviewViewProvider(GraphManager.viewId, graph, { webviewOptions: { retainContextWhenHidden: true } }),
    blame,
    tickets,
    prs,

    command('gitland.showGraph', async (arg?: Partial<CommitArgs>) => {
      const repo = await repoFor(arg?.repoRoot);
      if (!repo) {
        vscode.window.showWarningMessage('Gitland: no git repository found in this workspace.');
        return;
      }
      await graph.show(repo, arg?.sha);
    }),
    command('gitland.showGraphInEditor', async (arg?: Partial<CommitArgs>) => {
      const repo = await repoFor(arg?.repoRoot);
      if (repo) {
        await graph.show(repo, arg?.sha, 'editor');
      }
    }),
    command('gitland.clearAvatarCache', () => avatars.clear()),
    command('gitland.toggleFileBlame', () => blame.toggleFileBlame()),
    command('gitland.toggleFileBlameOff', () => blame.toggleFileBlame()),
    command('gitland.toggleInlineBlame', () => blame.toggleInline()),
    command('gitland.toggleCodeLens', () => {
      const cfg = vscode.workspace.getConfiguration('gitland');
      return cfg.update('codeLens.enabled', !cfg.get('codeLens.enabled', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new BlameCodeLensProvider(blame)),
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
      const org = await activeAzureOrg();
      const pat = await vscode.window.showInputBox({
        title: `Azure DevOps Personal Access Token${org ? ` for '${org}'` : ' (all organizations)'}`,
        prompt:
          'Scopes needed: Work Items (Read & write) and Code (Read & write). Leave empty to remove it and use your Microsoft account instead.',
        password: true,
        ignoreFocusOut: true,
      });
      if (pat === undefined) {
        return;
      }
      const key = org ? patSecretKey(org) : PAT_SECRET_KEY;
      if (pat.trim()) {
        await secrets.store(key, pat.trim());
        vscode.window.showInformationMessage(`Gitland: token saved${org ? ` for ${org}` : ''}.`);
      } else {
        await secrets.delete(key);
      }
      refreshViews();
    }),
    command('gitland.switchAzureAccount', async () => {
      const org = await activeAzureOrg();
      if (!org) {
        vscode.window.showWarningMessage('Gitland: open a repository hosted on Azure DevOps first.');
        return;
      }
      const session = await signInToAzureDevOps(org, true);
      vscode.window.showInformationMessage(`Gitland: Azure DevOps now uses ${session.account.label}.`);
      refreshViews();
    }),
    command('gitland.switchGitHubAccount', async () => {
      const session = await vscode.authentication.getSession('github', GITHUB_SCOPES, {
        clearSessionPreference: true,
        createIfNone: true,
      });
      vscode.window.showInformationMessage(`Gitland: GitHub now uses ${session.account.label}.`);
      refreshViews();
    }),
    command('gitland.clearCredentials', async () => {
      const org = await activeAzureOrg();
      await secrets.delete(PAT_SECRET_KEY);
      if (org) {
        await secrets.delete(patSecretKey(org));
      }
      vscode.window.showInformationMessage('Gitland: stored tokens cleared.');
      refreshViews();
    }),
    command('gitland.showLog', () => initLog().show()),

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
  repos.activeRepo(false).then((r) => {
    lastRoot = r?.root;
    log.info(r ? `Active repository: ${r.root}` : 'No git repository found in this workspace.');
  });
  log.info('Gitland activated.');
}

export function deactivate(): void {
  /* disposables are cleaned up by VS Code */
}
