import * as vscode from 'vscode';
import { BlameController } from './blame/blameController';
import { BlameCodeLensProvider } from './blame/codeLens';
import { fileHistory, lineHistory } from './commands/history';
import { checkoutPullRequest } from './commands/pullRequests';
import { startWork } from './commands/work';
import { RepoManager } from './git/repoManager';
import { GraphManager, openCommitFileDiff } from './graph/graphPanel';
import { AvatarService } from './avatars';
import { avatarSvg, isGravatarStyle, isLocalStyle, remoteAvatarUrl, STYLE_LABELS } from './avatarArt';
import { createHash } from 'crypto';
import { getProvider } from './providers';
import { manageTicketSources } from './commands/ticketSources';
import { ChangesView } from './views/changesView';
import { ChangesBadge } from './views/changesBadge';
import { TicketPanel } from './views/ticketPanel';
import { ComparePanel } from './views/comparePanel';
import { PrPanel } from './views/prPanel';
import { NewPrPanel } from './views/newPrPanel';
import { ReleasesView } from './views/releasesView';
import { PipelinesView } from './views/pipelinesView';
import { NewReleasePanel } from './views/newReleasePanel';
import { RebasePanel } from './views/rebasePanel';
import { CleanupPanel } from './views/cleanupPanel';
import { DashboardPanel } from './views/dashboardPanel';
import { HistoryPanel } from './views/historyPanel';
import { adoptRestoredPanel, createPanel, RestoreInfo, webviewOptions } from './views/webviewHtml';
import { searchEverywhere } from './commands/search';
import { manageWorktrees, openInWorktree } from './commands/worktrees';
import { PullRequest } from './providers/types';
import { Repo } from './git/repo';
import { AzureDevOpsProvider, PAT_SECRET_KEY, patSecretKey, signInToAzureDevOps } from './providers/azureDevOps';
import { GITHUB_SCOPES } from './providers/github';
import { AuthError } from './providers/types';
import { initLog, log } from './log';
import { config, errorMessage } from './util';
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
  // One bubble for the sidebar: on the Changes view, else on the Graph view.
  const changesBadge = new ChangesBadge(repos, ['gitland.changesView', 'gitland.graphView']);
  context.subscriptions.push(changesBadge);
  const graph = new GraphManager(context, repos, avatars, changesBadge);
  const blame = new BlameController(repos, avatars, secrets);
  const changes = new ChangesView(context, repos, changesBadge);
  const changesInPanel = new ChangesView(context, repos, changesBadge, ChangesView.panelViewId);
  /** Changes in an editor tab (one at a time), like the Commit Graph's "Open in Editor". */
  let changesInEditor: ChangesView | undefined;
  const showChangesInEditor = () => {
    if (changesInEditor) {
      changesInEditor.reveal();
      return;
    }
    const panel = createPanel('gitland.changes', 'Changes', vscode.ViewColumn.Active, { ...webviewOptions(context.extensionUri), retainContextWhenHidden: true });
    const view = new ChangesView(context, repos, changesBadge, 'gitland.changesEditor');
    changesInEditor = view;
    panel.onDidDispose(() => {
      if (changesInEditor === view) {
        changesInEditor = undefined;
      }
    });
    view.attachPanel(panel);
  };
  const tickets = new TicketsView(context, repos, secrets);
  const prs = new PullRequestsView(context, repos, secrets);
  const releases = new ReleasesView(context, repos, avatars);
  const pipelines = new PipelinesView(context, repos);

  let lastRoot: string | undefined;
  const repoFor = async (root?: string) => (root ? repos.getRepo(vscode.Uri.file(root)) : repos.activeRepo());

  /**
   * Pages open when the window reloaded come back: VS Code hands each tab back with what the page
   * saved (see restoreScript); its show() runs again and adopts that tab (same place among the tabs).
   */
  const reopen: Record<string, (r: RestoreInfo) => unknown> = {
    'gitland.pullRequest': (r) => PrPanel.show(context, repos, avatars, String(r.id)),
    'gitland.ticket': (r) => TicketPanel.show(context, repos, String(r.id), r.org as string | undefined),
    'gitland.compare': async (r) => {
      const repo = await repoFor(r.repoRoot as string);
      return repo && ComparePanel.show(context, repos, avatars, repo, r.from as string, r.to as string, false, (r.view as object) ?? {});
    },
    'gitland.history': async (r) => {
      const repo = await repoFor(r.repoRoot as string);
      return repo && HistoryPanel.show(context, repos, avatars, repo, r.rel as string, r.range as { start: number; end: number } | undefined);
    },
    'gitland.dashboard': () => DashboardPanel.show(context, repos, avatars),
    'gitland.changes': () => showChangesInEditor(),
    'gitland.cleanup': async (r) => {
      const repo = await repoFor(r.repoRoot as string);
      return repo && CleanupPanel.show(context, repo);
    },
    'gitland.newPullRequest': async (r) => {
      const repo = await repoFor(r.repoRoot as string);
      return repo && NewPrPanel.show(context, repos, avatars, repo);
    },
    'gitland.newRelease': async (r) => {
      const repo = await repoFor(r.repoRoot as string);
      return repo && NewReleasePanel.show(context, repos, repo, r.target as string | undefined);
    },
    'gitland.graph': async (r) => {
      const repo = await repoFor(r.repoRoot as string | undefined);
      return repo && graph.show(repo, undefined, 'editor');
    },
  };
  // One at a time: each reopening adopts "the" restored tab until its page takes it.
  let reopening: Promise<unknown> = Promise.resolve();
  for (const [viewType, open] of Object.entries(reopen)) {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(viewType, {
        async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { __restore?: RestoreInfo } | undefined) {
          const restore = state?.__restore;
          if (!restore) {
            panel.dispose();
            return;
          }
          const run = reopening.then(async () => {
            adoptRestoredPanel(panel);
            try {
              await open(restore);
            } catch (e) {
              log.error(`Reopening ${viewType} failed`, e);
            } finally {
              adoptRestoredPanel(undefined);
              // Not taken (the page was already open, or its repository is gone): close the empty tab.
              if (!panel.webview.html) {
                panel.dispose();
              }
            }
          });
          reopening = run;
          await run;
        },
      }),
    );
  }

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
    vscode.window.registerWebviewViewProvider(GraphManager.sidebarViewId, graph, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(GraphManager.bottomViewId, graph, { webviewOptions: { retainContextWhenHidden: true } }),
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
    command('gitland.showGraphView', async () => {
      const repo = await repoFor();
      if (repo) {
        await graph.show(repo, undefined, 'sidebar');
      }
    }),
    // Changes in the bottom panel (next to the Commit Graph) or back in the sidebar.
    command('gitland.showChangesInPanel', () => vscode.commands.executeCommand(`${ChangesView.panelViewId}.focus`)),
    command('gitland.showChangesView', () => vscode.commands.executeCommand(`${ChangesView.viewId}.focus`)),
    command('gitland.showChangesInEditor', () => showChangesInEditor()),
    command('gitland.showGraphInPanel', async () => {
      const repo = await repoFor();
      if (repo) {
        await graph.show(repo, undefined, 'bottom');
      }
    }),
    command('gitland.toggleChat', () => vscode.commands.executeCommand('workbench.action.chat.toggle')),
    command('gitland.clearAvatarCache', () => avatars.clear()),
    command('gitland.chooseAvatarStyle', async () => {
      const repo = await repos.activeRepo(false);
      const email = (await repo?.userEmail().catch(() => undefined)) || 'you@example.com';
      await chooseAvatarStyle(context, email);
    }),
    graphStatusBar(),
    command('gitland.toggleFileBlame', () => blame.toggleFileBlame()),
    command('gitland.toggleFileBlameOff', () => blame.toggleFileBlame()),
    command('gitland.toggleInlineBlame', () => blame.toggleInline()),
    command('gitland.toggleCodeLens', () => {
      const cfg = vscode.workspace.getConfiguration('gitland');
      return cfg.update('codeLens.enabled', !cfg.get('codeLens.enabled', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new BlameCodeLensProvider(blame)),
    command('gitland.fileHistory', (arg?: unknown) => fileHistory(context, repos, avatars, arg)),
    command('gitland.lineHistory', (arg?: { uri?: string; line?: number }) => lineHistory(context, repos, avatars, arg && typeof arg === 'object' && 'line' in arg ? arg : undefined)),
    command('gitland.explainLines', (arg?: { uri?: string; line?: number }) => lineHistory(context, repos, avatars, arg && typeof arg === 'object' && 'line' in arg ? arg : undefined, true)),

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

    changes,
    vscode.window.registerWebviewViewProvider(ChangesView.viewId, changes),
    vscode.window.registerWebviewViewProvider(ChangesView.panelViewId, changesInPanel),
    changesInPanel,
    command('gitland.tickets.refresh', () => tickets.refresh()),
    command('gitland.tickets.sources', async () => {
      if (await manageTicketSources(repos, secrets)) {
        tickets.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('gitland.tickets') && tickets.refresh()),
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
    command('gitland.tickets.show', async (arg?: TicketItem | string) => {
      let id = typeof arg === 'string' ? arg : arg?.ticket.id;
      const org = typeof arg === 'string' ? undefined : arg?.ticket.org;
      if (!id) {
        id = (await currentTicket(repos))?.id;
      }
      if (!id) {
        id = (await vscode.window.showInputBox({ prompt: 'Ticket ID', placeHolder: '1234' }))?.replace(/^(AB)?#/i, '').trim();
      }
      if (id) {
        await TicketPanel.show(context, repos, id, org);
      }
    }),
    ticketStatusBar(repos),
    command('gitland.compare', async (from?: string, to?: string) => {
      const repo = await repoFor();
      if (repo) {
        await ComparePanel.show(context, repos, avatars, repo, typeof from === 'string' ? from : undefined, typeof to === 'string' ? to : undefined);
      }
    }),
    command('gitland.tickets.open', (item: TicketItem) => vscode.env.openExternal(vscode.Uri.parse(item.ticket.url))),
    command('gitland.tickets.copyId', (item: TicketItem) => vscode.env.clipboard.writeText(item.ticket.id)),

    command('gitland.prs.refresh', () => prs.refresh()),
    command('gitland.prs.create', async (repoRoot?: string) => {
      const repo = await repoFor(typeof repoRoot === 'string' ? repoRoot : undefined);
      if (repo) {
        await NewPrPanel.show(context, repos, avatars, repo);
      }
    }),
    command('gitland.prs.show', async (arg?: PullRequestItem | string) => {
      const id = typeof arg === 'string' ? arg : arg?.pr.id ?? (await activePullRequest(repos, secrets))?.id;
      if (id) {
        PrPanel.show(context, repos, avatars, id);
      } else {
        vscode.window.showInformationMessage('Gitland: no pull request for the current branch.');
      }
    }),
    prStatusBar(repos, secrets),
    ciStatusBar(repos, secrets),
    releases,
    pipelines,
    command('gitland.releases.refresh', () => releases.refresh()),
    command('gitland.rebase.interactive', async (base?: string) => {
      const repo = await repoFor();
      if (repo) {
        await RebasePanel.show(context, repo, typeof base === 'string' ? base : undefined);
      }
    }),
    command('gitland.search', async () => {
      const repo = await repoFor();
      if (repo) {
        await searchEverywhere(repo, secrets, {
          commit: (sha) => graph.show(repo, sha),
          pr: (id) => PrPanel.show(context, repos, avatars, id),
          ticket: (id, org) => TicketPanel.show(context, repos, id, org),
        });
      }
    }),
    command('gitland.dashboard', () => DashboardPanel.show(context, repos, avatars)),
    command('gitland.branches.cleanup', async () => {
      const repo = await repoFor();
      if (repo) {
        CleanupPanel.show(context, repo);
      }
    }),
    command('gitland.worktrees', async () => {
      const repo = await repoFor();
      if (repo) {
        await manageWorktrees(repo);
      }
    }),
    command('gitland.worktrees.open', async (ref?: string, isRemote?: boolean) => {
      const repo = await repoFor();
      if (repo && typeof ref === 'string') {
        await openInWorktree(repo, ref, !!isRemote).catch((e) => vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`));
      }
    }),
    command('gitland.releases.create', async (target?: string) => {
      const repo = await repoFor();
      if (repo) {
        NewReleasePanel.show(context, repos, repo, typeof target === 'string' ? target : undefined);
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

/** "Graph" button in the status bar, like GitLens. */
function graphStatusBar(): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('gitland.graph', vscode.StatusBarAlignment.Left, 49);
  item.name = 'Gitland Commit Graph';
  item.text = '$(git-merge) Graph';
  item.tooltip = 'Show Commit Graph';
  item.command = 'gitland.showGraph';
  const update = () => (config('graph.statusBar.enabled', true) ? item.show() : item.hide());
  update();
  const sub = vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('gitland.graph.statusBar') && update());
  return vscode.Disposable.from(item, sub);
}

export function deactivate(): void {
  /* disposables are cleaned up by VS Code */
}

/** Quick pick with a preview of each style, drawn for the user's own email. */
async function chooseAvatarStyle(context: vscode.ExtensionContext, email: string): Promise<void> {
  const dir = vscode.Uri.joinPath(context.globalStorageUri, 'avatar-previews');
  await vscode.workspace.fs.createDirectory(dir);
  const current = config('avatars.defaultStyle', 'pixel');
  const styles = Object.keys(STYLE_LABELS);
  // Previews: local SVGs, DiceBear pictures downloaded once (short timeout).
  const icons = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Gitland: preparing picture previews…' },
    async () => {
      const out: (vscode.Uri | undefined)[] = [];
      // A few at a time: DiceBear throttles bursts.
      for (let i = 0; i < styles.length; i += 3) {
        out.push(...(await Promise.all(styles.slice(i, i + 3).map(preview))));
      }
      return out;
    },
  );
  async function preview(style: string): Promise<vscode.Uri | undefined> {
    try {
      if (isLocalStyle(style)) {
        const file = vscode.Uri.joinPath(dir, `${style}.svg`);
        await vscode.workspace.fs.writeFile(file, Buffer.from(avatarSvg(style, email)));
        return file;
      }
      const url = remoteAvatarUrl(style, email);
      if (!url) {
        return undefined;
      }
      const file = vscode.Uri.joinPath(dir, `${style}-${createHash('md5').update(email).digest('hex').slice(0, 8)}.svg`);
      try {
        await vscode.workspace.fs.stat(file);
        return file;
      } catch {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) {
          return undefined;
        }
        await vscode.workspace.fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
        return file;
      }
    } catch {
      return undefined;
    }
  }
  type Item = vscode.QuickPickItem & { style: string };
  const item = (style: string, i: number): Item => {
    const [name, detail] = STYLE_LABELS[style].split(' — ');
    return {
      style,
      label: name,
      description: [detail, style === current ? '(current)' : ''].filter(Boolean).join(' '),
      iconPath: icons[i] ?? new vscode.ThemeIcon('globe'),
    };
  };
  const all = styles.map(item);
  const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator, style: '' });
  const pick = await vscode.window.showQuickPick(
    [
      sep('Drawn locally (graph colors, offline)'),
      ...all.filter((i) => isLocalStyle(i.style)),
      sep('DiceBear (online)'),
      ...all.filter((i) => i.style.startsWith('dicebear-')),
      sep('Gravatar'),
      ...all.filter((i) => isGravatarStyle(i.style)),
    ],
    { placeHolder: `Picture for authors without a profile photo — preview for ${email}`, matchOnDescription: true },
  );
  if (pick?.style) {
    await vscode.workspace.getConfiguration('gitland').update('avatars.defaultStyle', pick.style, vscode.ConfigurationTarget.Global);
  }
}

/** Ticket linked to the current branch by "Start work". */
async function currentTicket(repos: RepoManager): Promise<{ id: string; title?: string } | undefined> {
  const repo: Repo | undefined = await repos.activeRepo(false);
  const branch = await repo?.currentBranch();
  const id = branch && (await repo!.getConfig(`branch.${branch}.gitlandTicket`));
  return id ? { id, title: await repo!.getConfig(`branch.${branch}.gitlandTicketTitle`) } : undefined;
}

/** "$(issues) AB#1234 Title" in the status bar while on a ticket's branch: click to see the ticket. */
function ticketStatusBar(repos: RepoManager): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('gitland.ticket', vscode.StatusBarAlignment.Left, 49);
  item.name = 'Gitland Ticket';
  item.command = 'gitland.tickets.show';
  let timer: NodeJS.Timeout | undefined;
  const update = async () => {
    const t = config('tickets.statusBar.enabled', true) ? await currentTicket(repos) : undefined;
    if (!t) {
      item.hide();
      return;
    }
    const title = t.title ? ` ${t.title.length > 28 ? t.title.slice(0, 27) + '…' : t.title}` : '';
    item.text = `$(issues) #${t.id}${title}`;
    item.tooltip = new vscode.MarkdownString(`**Ticket #${t.id}**${t.title ? ` — ${t.title}` : ''}\n\nThe ticket of the current branch. Click to see it.`);
    item.show();
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 400);
  };
  schedule();
  return vscode.Disposable.from(
    item,
    repos.onDidChangeRepo(schedule),
    vscode.window.onDidChangeActiveTextEditor(schedule),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('gitland.tickets') && schedule()),
    { dispose: () => clearTimeout(timer) },
  );
}

/** Open pull request of the current branch (cached a minute; never prompts to sign in). */
let prCache: { at: number; root: string; list: PullRequest[] } | undefined;
async function activePullRequest(repos: RepoManager, secrets: vscode.SecretStorage): Promise<PullRequest | undefined> {
  const repo: Repo | undefined = await repos.activeRepo(false);
  const branch = await repo?.currentBranch();
  if (!repo || !branch) {
    return undefined;
  }
  if (!prCache || prCache.root !== repo.root || Date.now() - prCache.at > 60_000) {
    const provider = await getProvider(repo, secrets);
    if (!provider || !(await provider.isSignedIn())) {
      return undefined;
    }
    prCache = { at: Date.now(), root: repo.root, list: await provider.listPullRequests().catch(() => []) };
  }
  return prCache.list.find((p) => p.sourceBranch === branch);
}

/** "$(git-pull-request) PR 528 · approved" in the status bar while on a branch with an open PR. */
function prStatusBar(repos: RepoManager, secrets: vscode.SecretStorage): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('gitland.pullRequest', vscode.StatusBarAlignment.Left, 48);
  item.name = 'Gitland Pull Request';
  item.command = 'gitland.prs.show';
  let timer: NodeJS.Timeout | undefined;
  const update = async () => {
    const pr = config('pr.statusBar.enabled', true) ? await activePullRequest(repos, secrets).catch(() => undefined) : undefined;
    if (!pr) {
      item.hide();
      return;
    }
    const state = pr.isDraft ? 'draft' : pr.review === 'approved' ? 'approved' : pr.review === 'changes' ? 'changes requested' : 'in review';
    const icon = pr.isDraft ? '$(git-pull-request-draft)' : pr.review === 'approved' ? '$(pass)' : pr.review === 'changes' ? '$(request-changes)' : '$(git-pull-request)';
    item.text = `${icon} ${pr.label} · ${state}`;
    item.tooltip = new vscode.MarkdownString(`**${pr.label}** ${pr.title}\n\n\`${pr.sourceBranch}\` → \`${pr.targetBranch}\` — ${state}\n\nClick to see the pull request.`);
    item.show();
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 600);
  };
  schedule();
  const refresh = setInterval(() => {
    prCache = undefined;
    schedule();
  }, 5 * 60_000);
  return vscode.Disposable.from(
    item,
    repos.onDidChangeRepo(schedule),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('gitland.pr') && schedule()),
    { dispose: () => (clearTimeout(timer), clearInterval(refresh)) },
  );
}

/** "$(pass) CI" / "$(error) CI failed" for the latest pipeline run of the current branch; click to open it. */
function ciStatusBar(repos: RepoManager, secrets: vscode.SecretStorage): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('gitland.pipeline', vscode.StatusBarAlignment.Left, 47);
  item.name = 'Gitland CI';
  let url: string | undefined;
  const open = vscode.commands.registerCommand('gitland.pipelines.openLatest', () => url && vscode.env.openExternal(vscode.Uri.parse(url)));
  item.command = 'gitland.pipelines.openLatest';
  let timer: NodeJS.Timeout | undefined;
  const update = async () => {
    try {
      const repo: Repo | undefined = config('pipelines.statusBar.enabled', true) ? await repos.activeRepo(false) : undefined;
      const branch = await repo?.currentBranch();
      const provider = repo && (await getProvider(repo, secrets));
      if (!repo || !branch || !provider?.pipelineRuns || !(await provider.isSignedIn())) {
        item.hide();
        return;
      }
      const runs = (await provider.pipelineRuns({ max: 40 })).filter((r) => r.branch === branch);
      if (!runs.length) {
        item.hide();
        return;
      }
      const latestSha = runs[0].sha;
      const current = runs.filter((r) => r.sha === latestSha);
      const state = ['failed', 'running', 'queued', 'partial', 'canceled', 'succeeded'].find((s) => current.some((r) => r.state === s))!;
      const icon = { failed: '$(error)', running: '$(sync~spin)', queued: '$(clock)', partial: '$(warning)', canceled: '$(circle-slash)', succeeded: '$(pass)' }[state];
      item.text = `${icon} CI${state === 'succeeded' ? '' : ` ${state}`}`;
      item.backgroundColor = state === 'failed' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
      item.tooltip = new vscode.MarkdownString(
        `**CI of ${branch}** (${latestSha?.slice(0, 7)})\n\n${current.map((r) => `- ${r.name}: ${r.state}`).join('\n')}\n\nClick to open the run.`,
      );
      url = (current.find((r) => r.state === state) ?? current[0]).url;
      item.show();
    } catch {
      item.hide();
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 1500);
  };
  schedule();
  const refresh = setInterval(update, 2 * 60_000);
  return vscode.Disposable.from(item, open, repos.onDidChangeRepo(schedule), { dispose: () => (clearTimeout(timer), clearInterval(refresh)) });
}
