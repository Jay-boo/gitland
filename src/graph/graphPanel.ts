import { createPanel, pageIcon, webviewHtml } from '../views/webviewHtml';
import * as path from 'path';
import * as vscode from 'vscode';
import { applyNumstat, Commit, DiffPreview, Repo, WORKTREE_SHA } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { AvatarService } from '../avatars';
import { getProvider } from '../providers';
import { log } from '../log';
import { config, errorMessage, formatDate } from '../util';
import { computeGraph } from './layout';
import { branchColor, conventionalType, mergedBranchName } from './colors';
import { commitMatcher, filterCommits, GraphFilters, hasFilters, insertStashes } from './filter';
import { PipelineRun, PullRequest } from '../providers/types';
import { ComparePanel } from '../views/comparePanel';
import { explainHistory } from '../commitMessage';
import { mentionedContext } from '../views/historyPanel';
import { capture } from '../devCapture';

type WebviewMessage =
  | { type: 'ready'; filters?: GraphFilters }
  | { type: 'log'; level: 'info' | 'error'; message: string }
  | { type: 'refresh' }
  | { type: 'loadMore' }
  | { type: 'select'; sha: string }
  | { type: 'hover'; sha: string }
  | { type: 'mergeBase'; sha: string }
  | { type: 'openUrl'; url: string }
  | { type: 'filters'; filters: GraphFilters }
  | { type: 'listRefs' }
  | { type: 'reveal'; ref: string; sha: string }
  | { type: 'compare'; a: string; b: string }
  | { type: 'compareRefs'; from?: string; to?: string; previous?: boolean }
  | { type: 'explain'; sha: string }
  | { type: 'stopExplain' }
  | { type: 'openCompareDiff'; a: string; b: string; path: string; oldPath?: string; status: string }
  | { type: 'openDiff'; sha: string; path: string; oldPath?: string; status: string }
  | { type: 'preview'; key: string; sha?: string; a?: string; b?: string; path: string; oldPath?: string; status?: string }
  | { type: 'action'; action: string; sha?: string; ref?: string; refType?: string; target?: string };

/** Where a graph is rendered: the bottom panel view or an editor tab. */
interface GraphHost {
  readonly webview: vscode.Webview;
  readonly visible: boolean;
  setTitle(title: string): void;
  /** Number of uncommitted changes, shown as a bubble on the view (0 = none). */
  setBadge?(count: number): void;
  readonly onDidBecomeVisible: vscode.Event<void>;
  readonly onDidDispose: vscode.Event<void>;
}

export type GraphPlace = 'sidebar' | 'bottom' | 'editor';

/**
 * Opens the graph like GitLens: the "Graph" view of the Gitland sidebar (default), the
 * "Commit Graph" view of the bottom panel, or an editor tab.
 */
export class GraphManager implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly sidebarViewId = 'gitland.graphView';
  static readonly bottomViewId = 'gitland.graphPanelView';
  private readonly views = new Map<string, GraphController>();
  private editor?: { panel: vscode.WebviewPanel; controller: GraphController };
  private readonly pending = new Map<string, { repo: Repo; sha?: string }>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly avatars: AvatarService,
  ) {}

  async show(repo: Repo, sha?: string, where?: GraphPlace): Promise<void> {
    where ??= config<'panel' | 'editor'>('graph.layout', 'panel') === 'editor' ? 'editor' : 'sidebar';
    if (where === 'editor') {
      this.showInEditor(repo, sha);
      return;
    }
    const viewId = where === 'bottom' ? GraphManager.bottomViewId : GraphManager.sidebarViewId;
    const controller = this.views.get(viewId);
    if (controller) {
      controller.setRepo(repo, sha);
    } else {
      this.pending.set(viewId, { repo, sha });
    }
    await vscode.commands.executeCommand(`${viewId}.focus`);
  }

  private showInEditor(repo: Repo, sha?: string): void {
    if (this.editor) {
      this.editor.panel.reveal(undefined, false);
      this.editor.controller.setRepo(repo, sha);
      return;
    }
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = createPanel('gitland.graph', 'Commit Graph', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    panel.iconPath = pageIcon(this.context.extensionUri, 'graph');
    const visible = new vscode.EventEmitter<void>();
    panel.onDidChangeViewState((e) => e.webviewPanel.visible && visible.fire());
    const host: GraphHost = {
      webview: panel.webview,
      get visible() {
        return panel.visible;
      },
      setTitle: (t) => (panel.title = `Commit Graph · ${t}`),
      onDidBecomeVisible: visible.event,
      onDidDispose: panel.onDidDispose,
    };
    const controller = new GraphController(this.context, this.repos, this.avatars, host, repo, sha);
    this.editor = { panel, controller };
    panel.onDidDispose(() => {
      controller.dispose();
      visible.dispose();
      this.editor = undefined;
    });
  }

  /** Same provider for both views (sidebar and bottom panel); each gets its own controller. */
  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    const viewId = view.viewType;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const visible = new vscode.EventEmitter<void>();
    view.onDidChangeVisibility(() => view.visible && visible.fire());
    const host: GraphHost = {
      webview: view.webview,
      get visible() {
        return view.visible;
      },
      setTitle: (t) => (view.description = t),
      // VS Code adds up the badges of a container's views: the sidebar's is on ChangesBadge's hidden view.
      setBadge:
        viewId === GraphManager.bottomViewId
          ? (n) => (view.badge = n ? { value: n, tooltip: `${n} uncommitted change${n === 1 ? '' : 's'}` } : undefined)
          : undefined,
      onDidBecomeVisible: visible.event,
      onDidDispose: view.onDidDispose,
    };
    const pending = this.pending.get(viewId);
    this.pending.delete(viewId);
    const repo = pending?.repo ?? (await this.repos.activeRepo(false));
    const controller = new GraphController(this.context, this.repos, this.avatars, host, repo, pending?.sha);
    this.views.set(viewId, controller);
    view.onDidDispose(() => {
      controller.dispose();
      visible.dispose();
      this.views.delete(viewId);
    });
  }

  dispose(): void {
    this.views.forEach((c) => c.dispose());
    this.editor?.panel.dispose();
  }
}

export class GraphController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private repo?: Repo;
  private max: number;
  private pendingSelect?: string;
  private pendingFocus?: string;
  private commits: Commit[] = [];
  private filters: GraphFilters = {};
  private prs?: { at: number; list: Promise<PullRequest[]> };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly avatars: AvatarService,
    private readonly host: GraphHost,
    repo: Repo | undefined,
    selectSha?: string,
  ) {
    this.repo = repo;
    this.max = config('graph.maxCommits', 400);
    this.pendingSelect = selectSha;
    host.webview.html = this.html(context.extensionUri);
    this.disposables.push(
      host.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m)),
      repos.onDidChangeRepo((r) => {
        if (r.root !== this.repo?.root) {
          return;
        }
        if (this.host.visible) {
          this.load();
        } else {
          this.updateBadge();
        }
      }),
      host.onDidBecomeVisible(() => this.load()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitland.avatars') || e.affectsConfiguration('gitland.graph')) {
          this.load();
        }
      }),
      avatars.onDidResolve(({ email, url }) => {
        if (this.commits.some((c) => c.email.toLowerCase() === email)) {
          this.post({ type: 'avatars', avatars: { [email]: url } });
        }
      }),
      // Follow the repository of the active editor when several are open.
      vscode.window.onDidChangeActiveTextEditor(async (e) => {
        if (!e || e.document.uri.scheme !== 'file') {
          return;
        }
        const r = await this.repos.getRepo(e.document.uri);
        if (r && r.root !== this.repo?.root) {
          this.setRepo(r);
        }
      }),
    );
  }

  setRepo(repo: Repo, selectSha?: string): void {
    if (repo.root !== this.repo?.root) {
      this.repo = repo;
      this.max = config('graph.maxCommits', 400);
    }
    this.pendingSelect = selectSha;
    this.load();
  }

  private post(message: unknown): Thenable<boolean> {
    capture('graph', 'message', message);
    return this.host.webview.postMessage(message);
  }

  private async load(): Promise<void> {
    if (!this.repo) {
      this.repo = await this.repos.activeRepo(false);
      if (!this.repo) {
        await this.post({ type: 'error', message: 'No git repository found in this workspace.' });
        return;
      }
    }
    // The editor tab reopens on this repository after a window reload.
    void this.post({ type: '__restore', restore: { kind: 'graph', repoRoot: this.repo.root } });
    const repo = this.repo;
    log.info(`Graph: loading ${repo.root}`);
    try {
      const filtered = hasFilters(this.filters);
      const scope = this.filters.scope ?? 'all';
      const scopeRef = this.filters.ref || (await this.repo.currentBranch()) || 'HEAD';
      // Filtering needs a deeper scan to still fill the view.
      const scan = filtered ? Math.min(this.max * 5, 10000) : this.max + 1;
      const [commits, head, branch, changes, provider, stashes, email, name] = await Promise.all([
        scope === 'all' ? this.repo.log(scan) : this.repo.log(scan, { refs: [scopeRef], firstParent: scope === 'timeline' }),
        this.repo.headSha(),
        this.repo.currentBranch(),
        this.repo.workingTreeChanges().catch(() => []),
        getProvider(this.repo, this.context.secrets),
        config('graph.showStashes', true) ? this.repo.stashes() : Promise.resolve([]),
        this.repo.userEmail(),
        this.repo.getConfig('user.name'),
      ]);
      let hasMore = commits.length > (filtered ? scan - 1 : this.max);
      let list = filtered ? filterCommits(commits, commitMatcher(this.filters, { email, name })) : commits;
      hasMore ||= list.length > this.max;
      // Timeline: keep the main line only; a merge shows the branch it brought in.
      const mergedFrom = new Map<string, { label: string; color: number; title: string }>();
      if (scope === 'timeline') {
        list = list.map((c) => {
          if (c.parents.length > 1) {
            mergedFrom.set(c.sha, timelineMerge(c.subject));
          }
          return c.parents.length > 1 ? { ...c, parents: [c.parents[0]] } : c;
        });
      }
      list = insertStashes(list.slice(0, this.max), filtered || scope !== 'all' ? [] : stashes);
      const dirty = changes.length > 0;
      this.host.setBadge?.(changes.length);
      if (dirty && head && !filtered && (scope === 'all' || scopeRef === branch)) {
        list.unshift({
          sha: WORKTREE_SHA,
          parents: [head],
          author: '',
          email: '',
          date: Date.now(),
          subject: 'Uncommitted changes',
          refs: [],
        });
      }
      this.commits = list;
      const remotes = await repo.remoteNames();
      const refColor = (r: { type: string; name: string }) => {
        const remote = r.type === 'remote' ? remotes.find((x) => r.name.startsWith(x + '/')) : undefined;
        return branchColor(remote ? r.name.slice(remote.length + 1) : r.name);
      };
      // A lane takes the color of its branch: the ref at its tip, else the branch named by the merge.
      const graph = computeGraph(list, (c, merge) => {
        if (c.sha === WORKTREE_SHA) {
          return branch ? branchColor(branch) : undefined;
        }
        const ref = c.refs.find((r) => r.type === 'branch') ?? c.refs.find((r) => r.type === 'remote');
        if (ref) {
          return refColor(ref);
        }
        const merged = merge && mergedBranchName(merge.subject);
        return merged ? branchColor(merged) : undefined;
      });
      this.host.setTitle(path.basename(repo.root));
      const avatars = this.avatarMap(repo, list);
      await this.post({
        type: 'data',
        repoName: path.basename(this.repo.root),
        branch,
        head,
        hasMore,
        width: graph.width,
        remote: provider?.displayName,
        // "{id}" is replaced in the webview by PR / work item numbers found in commit messages.
        links: provider && {
          kind: provider.kind,
          pr: provider.pullRequestUrl('{id}'),
          ticket: provider.ticketUrl('{id}'),
        },
        commits: list.map((c, i) => ({
          sha: c.sha,
          short: c.sha === WORKTREE_SHA ? '' : c.sha.slice(0, 7),
          parents: c.parents,
          author: c.author,
          email: c.email,
          date: c.sha === WORKTREE_SHA ? '' : formatDate(c.date),
          ts: c.date,
          subject: c.subject,
          mergedFrom: mergedFrom.get(c.sha)?.label,
          mergedColor: mergedFrom.get(c.sha)?.color,
          mergedTitle: mergedFrom.get(c.sha)?.title,
          refs: c.refs.map((r) => (r.type === 'branch' || r.type === 'remote' ? { ...r, color: refColor(r) } : r)),
          graph: graph.rows[i],
        })),
        select: this.pendingSelect,
        focus: this.pendingFocus,
        avatars,
        showAvatars: config('graph.avatars', true),
        changes: changes.length,
        changeStats: summarizeChanges(changes),
        filters: this.filters,
        scope,
        scopeRef: scope === 'all' ? undefined : scopeRef,
        scanned: filtered ? commits.length : undefined,
        me: email,
        authors: authorList(commits),
      });
      if (process.env.GITLAND_CAPTURE_DIR) {
        // Dev capture: a sample details reply for test/render (it answers hover / details requests).
        const sample = list.find((c) => c.sha !== WORKTREE_SHA && c.refs.length) ?? list.find((c) => c.sha !== WORKTREE_SHA);
        if (sample) {
          await this.sendDetails(sample.sha);
        }
      }
      this.pendingSelect = undefined;
      this.pendingFocus = undefined;
      this.sendPullRequests(repo);
      this.sendPipelines(repo);
    } catch (e) {
      log.error('Graph: loading failed', e);
      await this.post({ type: 'error', message: errorMessage(e) });
    }
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    try {
      switch (m.type) {
        case 'log':
          m.level === 'error' ? log.error(`Graph webview: ${m.message}`) : log.info(`Graph webview: ${m.message}`);
          break;
        case 'ready':
          this.filters = m.filters ?? {};
          await this.load();
          break;
        case 'refresh':
          await this.load();
          break;
        case 'loadMore':
          this.max += config('graph.maxCommits', 400);
          await this.load();
          break;
        case 'select':
          await this.sendDetails(m.sha);
          break;
        case 'hover':
          await this.sendDetails(m.sha, 'hover');
          break;
        case 'mergeBase': {
          if (!/^[0-9a-f]{7,64}$/i.test(m.sha)) {
            break;
          }
          const base = (await this.currentRepo.exec(['merge-base', m.sha, 'HEAD']).catch(() => '')).trim();
          await this.post(base ? { type: 'jump', sha: base } : { type: 'notice', text: 'No common ancestor with HEAD.' });
          break;
        }
        case 'openUrl':
          await vscode.commands.executeCommand('gitland.openLink', m.url, this.repo?.root);
          break;
        case 'openDiff':
          await this.openDiff(m.sha, m.path, m.oldPath, m.status);
          break;
        case 'preview':
          await this.post({ type: 'preview', key: m.key, ...(await this.diffPreview(m)) });
          break;
        case 'filters':
          this.filters = m.filters;
          await this.load();
          break;
        case 'listRefs':
          await this.post({ type: 'refs', refs: await this.currentRepo.allRefs() });
          break;
        case 'reveal':
          await this.reveal(m.ref, m.sha);
          break;
        case 'compare':
          await this.sendCompare(m.a, m.b);
          break;
        case 'explain':
          await this.explainCommit(m.sha);
          break;
        case 'stopExplain':
          this.explaining?.cancel();
          break;
        case 'compareRefs': {
          const from = m.previous && m.to ? await this.currentRepo.previousTag(m.to) : m.from;
          if (m.previous && !from) {
            vscode.window.showInformationMessage(`Gitland: no tag before ${m.to}.`);
          }
          await ComparePanel.show(this.context, this.repos, this.avatars, this.currentRepo, from, m.to);
          break;
        }
        case 'openCompareDiff':
          await this.openCompareDiff(m.a, m.b, m.path, m.oldPath, m.status);
          break;
        case 'action':
          await this.runAction(m.action, m.sha, m.ref, m.refType, m.target);
          break;
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`);
    }
  }

  private get currentRepo(): Repo {
    if (!this.repo) {
      throw new Error('No git repository is open in the graph.');
    }
    return this.repo;
  }

  /** Bubble with the number of uncommitted changes, also while the view is hidden. */
  private async updateBadge(): Promise<void> {
    if (this.repo && this.host.setBadge) {
      this.host.setBadge((await this.repo.workingTreeChanges().catch(() => [])).length);
    }
  }

  private explaining?: vscode.CancellationTokenSource;

  /** ✨ What a commit does and why, streamed into the details pane. */
  private async explainCommit(sha: string): Promise<void> {
    this.explaining?.cancel();
    const cts = (this.explaining = new vscode.CancellationTokenSource());
    const repo = this.currentRepo;
    this.post({ type: 'explainStart', sha });
    try {
      const [d, patch, provider] = await Promise.all([
        repo.commitDetails(sha),
        repo.exec(['show', '--format=', '--stat', '--patch', '-M', '--first-parent', sha]).catch(() => ''),
        getProvider(repo, this.context.secrets),
      ]);
      const nl = d.message.indexOf('\n');
      const text = await explainHistory(
        {
          kind: 'commit',
          subject: `commit ${sha.slice(0, 7)}`,
          commits: [{ sha, author: d.author, date: d.authorDate, subject: nl < 0 ? d.message : d.message.slice(0, nl), body: nl < 0 ? '' : d.message.slice(nl + 1) }],
          patches: patch,
          context: await mentionedContext(provider, [d.message]),
        },
        (t) => this.post({ type: 'explainText', sha, text: t }),
        cts.token,
      );
      this.post({ type: 'explainDone', sha, text });
    } catch (e) {
      this.post({ type: 'explainDone', sha });
      if (!cts.token.isCancellationRequested) {
        vscode.window.showWarningMessage(`Gitland: ${errorMessage(e)}`);
      }
    } finally {
      cts.dispose();
    }
  }

  /** CI status of the commits (latest run per commit and pipeline), for the dots in the graph. */
  private ci?: { at: number; runs: Promise<PipelineRun[]> };
  private async sendPipelines(repo: Repo): Promise<void> {
    if (!config('graph.pipelines', true)) {
      return;
    }
    try {
      const provider = await getProvider(repo, this.context.secrets);
      if (!provider?.pipelineRuns || !(await provider.isSignedIn())) {
        return;
      }
      if (!this.ci || Date.now() - this.ci.at > 90_000) {
        this.ci = { at: Date.now(), runs: provider.pipelineRuns({ max: 100 }) };
      }
      const runs = await this.ci.runs;
      if (repo === this.repo) {
        await this.post({ type: 'ci', runs: runs.filter((r) => r.sha) });
      }
    } catch (e) {
      this.ci = undefined;
      log.info(`Graph: pipelines unavailable (${errorMessage(e)})`);
    }
  }

  /** Open pull requests per source branch, for the PR badges (never prompts to sign in). */
  private async sendPullRequests(repo: Repo): Promise<void> {
    try {
      const provider = await getProvider(repo, this.context.secrets);
      if (!provider || !(await provider.isSignedIn())) {
        return;
      }
      if (!this.prs || Date.now() - this.prs.at > 120_000) {
        this.prs = { at: Date.now(), list: provider.listPullRequests() };
      }
      const list = await this.prs.list;
      if (repo !== this.repo) {
        return;
      }
      await this.post({
        type: 'prs',
        prs: list.map((p) => ({ branch: p.sourceBranch, target: p.targetBranch, id: p.id, title: p.title, url: p.url, draft: p.isDraft, review: p.review })),
      });
    } catch (e) {
      this.prs = undefined;
      log.info(`Graph: pull requests unavailable (${errorMessage(e)})`);
    }
  }

  /** Loads enough history to show `sha` (a branch older than the loaded commits), then focuses `ref`. */
  private async reveal(ref: string, sha: string): Promise<void> {
    const repo = this.currentRepo;
    if (!this.commits.some((c) => c.sha === sha)) {
      const ts = (await repo.exec(['show', '-s', '--format=%ct', sha])).trim();
      const newer = Number((await repo.exec(['rev-list', '--all', '--exclude=refs/stash', '--count', `--max-age=${ts}`])).trim());
      this.max = Math.min(20000, Math.max(this.max, newer + 200));
      this.filters = {};
    }
    this.pendingSelect = sha;
    this.pendingFocus = ref;
    await this.load();
  }

  /** Files changed between two commits (older → newer). */
  private async sendCompare(a: string, b: string): Promise<void> {
    const repo = this.currentRepo;
    const [older, newer] = (this.commits.find((c) => c.sha === a)?.date ?? 0) <= (this.commits.find((c) => c.sha === b)?.date ?? 0) ? [a, b] : [b, a];
    const [nameStatus, numstat, counts] = await Promise.all([
      repo.exec(['diff', '--name-status', '-M', older, newer]),
      repo.exec(['diff', '--numstat', '-z', '-M', older, newer]).catch(() => ''),
      repo.exec(['rev-list', '--left-right', '--count', `${older}...${newer}`]).catch(() => '0\t0'),
    ]);
    const files = parseNameStatusLines(nameStatus);
    applyNumstat(files, numstat);
    const [onlyOlder, onlyNewer] = counts.trim().split(/\s+/).map(Number);
    await this.post({ type: 'compare', a: older, b: newer, files, onlyOlder, onlyNewer });
  }

  private async openCompareDiff(a: string, b: string, relPath: string, oldPath: string | undefined, status: string): Promise<void> {
    const repo = this.currentRepo;
    const uri = vscode.Uri.file(path.join(repo.root, relPath));
    const oldUri = vscode.Uri.file(path.join(repo.root, oldPath ?? relPath));
    const title = `${path.basename(relPath)} (${a.slice(0, 7)} ↔ ${b.slice(0, 7)})`;
    if (status === 'A') {
      await vscode.commands.executeCommand('vscode.open', this.repos.toGitUri(uri, b));
    } else if (status === 'D') {
      await vscode.commands.executeCommand('vscode.open', this.repos.toGitUri(oldUri, a));
    } else {
      await vscode.commands.executeCommand('vscode.diff', this.repos.toGitUri(oldUri, a), this.repos.toGitUri(uri, b), title);
    }
  }

  /** Commit details for the details pane ('details') or the hover card ('hover'). */
  private async sendDetails(sha: string, type: 'details' | 'hover' = 'details'): Promise<void> {
    if (sha === WORKTREE_SHA) {
      const [files, numstat] = await Promise.all([
        this.currentRepo.workingTreeChanges(),
        this.currentRepo.exec(['diff', 'HEAD', '--numstat', '-z']).catch(() => ''),
      ]);
      applyNumstat(files, numstat);
      await this.post({ type, sha, details: { sha, message: 'Uncommitted changes', files, parents: [] } });
      return;
    }
    const [d, release, signature] = await Promise.all([this.currentRepo.commitDetails(sha), this.currentRepo.releaseOf(sha), this.currentRepo.signature(sha)]);
    const commit = this.commits.find((c) => c.sha === sha);
    await this.post({
      type,
      sha,
      details: {
        ...d,
        authorTs: d.authorDate,
        release,
        signature,
        authorDate: formatDate(d.authorDate),
        commitDate: formatDate(d.commitDate),
        refs: commit?.refs ?? [],
      },
    });
  }

  /** First hunks of a file's diff: in a commit (vs its first parent), uncommitted, or between two commits. */
  private diffPreview(m: { sha?: string; a?: string; b?: string; path: string; oldPath?: string; status?: string }): Promise<DiffPreview> {
    const repo = this.currentRepo;
    const paths = ['--', ...(m.oldPath ? [m.oldPath] : []), m.path];
    const old = m.oldPath ?? m.path;
    if (m.a && m.b) {
      return repo.diffPreview(['diff', m.a, m.b, ...paths], undefined, { path: m.path, before: { rev: m.a, path: old }, after: { rev: m.b, path: m.path } });
    }
    if (m.sha === WORKTREE_SHA) {
      return m.status === 'U'
        ? repo.diffPreview([], m.path, { path: m.path, before: undefined, after: { file: m.path } })
        : repo.diffPreview(['diff', 'HEAD', ...paths], undefined, { path: m.path, before: { rev: 'HEAD', path: old }, after: { file: m.path } });
    }
    return repo.diffPreview(['show', '--format=', '--first-parent', '-m', m.sha!, ...paths], undefined, {
      path: m.path,
      before: m.status === 'A' ? undefined : { rev: `${m.sha}^`, path: old },
      after: m.status === 'D' ? undefined : { rev: m.sha!, path: m.path },
    });
  }

  async openDiff(sha: string, relPath: string, oldPath: string | undefined, status: string): Promise<void> {
    await openCommitFileDiff(this.repos, this.currentRepo, sha, relPath, oldPath, status);
  }

  private async runAction(action: string, sha?: string, ref?: string, refType?: string, target?: string): Promise<void> {
    const repo = this.currentRepo;
    const short = sha?.slice(0, 7);
    const confirm = async (msg: string, button: string) =>
      (await vscode.window.showWarningMessage(msg, { modal: true }, button)) === button;

    switch (action) {
      case 'copySha':
        await vscode.env.clipboard.writeText(sha ?? '');
        vscode.window.setStatusBarMessage('Gitland: SHA copied', 2000);
        return;
      case 'copyMessage': {
        const d = await repo.commitDetails(sha!);
        await vscode.env.clipboard.writeText(d.message);
        vscode.window.setStatusBarMessage('Gitland: message copied', 2000);
        return;
      }
      case 'copyRef':
        await vscode.env.clipboard.writeText(ref ?? '');
        return;
      case 'showRelease':
        await vscode.commands.executeCommand('gitland.releases.show', ref, repo.root);
        return;
      case 'openRemote':
      case 'openBranchRemote': {
        const provider = await getProvider(repo, this.context.secrets);
        if (!provider) {
          vscode.window.showInformationMessage('No Azure DevOps / GitHub / GitLab remote found for this repository.');
          return;
        }
        const url = action === 'openRemote' ? provider.commitUrl(sha!) : provider.branchUrl(stripRemote(ref!, await repo.remoteNames()));
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      case 'checkoutCommit':
        if (await confirm(`Checkout commit ${short}? You will be in 'detached HEAD' state.`, 'Checkout')) {
          await repo.checkout(sha!);
        }
        break;
      case 'checkoutBranch':
        await checkoutRef(repo, ref!, refType === 'remote');
        break;
      case 'createBranch': {
        const name = await vscode.window.showInputBox({ prompt: `New branch at ${short}`, placeHolder: 'feature/my-branch' });
        if (!name) {
          return;
        }
        await repo.exec(['checkout', '-b', name.trim(), sha!]);
        break;
      }
      case 'createTag': {
        const name = await vscode.window.showInputBox({ prompt: `New tag at ${short}`, placeHolder: 'v1.0.0' });
        if (!name) {
          return;
        }
        await repo.exec(['tag', name.trim(), sha!]);
        break;
      }
      case 'cherryPick':
        if (await confirm(`Cherry-pick ${short} onto the current branch?`, 'Cherry-pick')) {
          await repo.exec(['cherry-pick', sha!]);
        }
        break;
      case 'revert':
        if (await confirm(`Revert ${short} (creates a new commit)?`, 'Revert')) {
          await repo.exec(['revert', '--no-edit', sha!]);
        }
        break;
      case 'reset': {
        const mode = await vscode.window.showQuickPick(
          [
            { label: 'Soft', description: 'keep changes staged', value: '--soft' },
            { label: 'Mixed', description: 'keep changes in working tree', value: '--mixed' },
            { label: 'Hard', description: 'DISCARD all changes', value: '--hard' },
          ],
          { placeHolder: `Reset current branch to ${short}` },
        );
        if (!mode) {
          return;
        }
        if (mode.value === '--hard' && !(await confirm(`Hard reset to ${short}? Uncommitted changes will be lost.`, 'Reset'))) {
          return;
        }
        await repo.exec(['reset', mode.value, sha!]);
        break;
      }
      case 'merge':
        if (await confirm(`Merge '${ref}' into the current branch?`, 'Merge')) {
          await repo.exec(['merge', '--no-edit', ref!]);
        }
        break;
      case 'rebase':
        if (await confirm(`Rebase the current branch onto '${ref}'?`, 'Rebase')) {
          await repo.exec(['rebase', ref!]);
        }
        break;
      case 'push':
        await repo.push((await repo.defaultRemote()) ?? 'origin', ref!, true);
        vscode.window.setStatusBarMessage(`Gitland: pushed ${ref}`, 3000);
        break;
      case 'createPr':
        if ((await repo.currentBranch()) !== ref) {
          await checkoutRef(repo, ref!, false);
        }
        await vscode.commands.executeCommand('gitland.prs.create', repo.root);
        break;
      case 'deleteBranch':
        if (refType === 'remote') {
          const remotes = await repo.remoteNames();
          const remote = remotes.find((r) => ref!.startsWith(r + '/'))!;
          if (await confirm(`Delete remote branch '${ref}'?`, 'Delete')) {
            await repo.exec(['push', remote, '--delete', ref!.slice(remote.length + 1)]);
          }
        } else if (await confirm(`Delete branch '${ref}'?`, 'Delete')) {
          try {
            await repo.exec(['branch', '-d', ref!]);
          } catch (e) {
            if (await confirm(`'${ref}' is not fully merged. Force delete?\n\n${errorMessage(e)}`, 'Force Delete')) {
              await repo.exec(['branch', '-D', ref!]);
            }
          }
        }
        break;
      case 'deleteTag':
        if (await confirm(`Delete tag '${ref}'?`, 'Delete')) {
          await repo.exec(['tag', '-d', ref!]);
        }
        break;
      case 'rebaseFrom':
        await vscode.commands.executeCommand('gitland.rebase.interactive', sha);
        return;
      case 'worktree':
        await vscode.commands.executeCommand('gitland.worktrees.open', ref, refType === 'remote');
        return;
      case 'cleanup':
        await vscode.commands.executeCommand('gitland.branches.cleanup');
        return;
      case 'worktrees':
        await vscode.commands.executeCommand('gitland.worktrees');
        return;
      case 'createRelease':
        await vscode.commands.executeCommand('gitland.releases.create', sha);
        return;
      case 'stashApply':
        await repo.exec(['stash', 'apply', ref!]);
        break;
      case 'stashPop':
        await repo.exec(['stash', 'pop', ref!]);
        break;
      case 'stashDrop':
        if (await confirm(`Drop ${ref}? Its changes will be lost.`, 'Drop')) {
          await repo.exec(['stash', 'drop', ref!]);
        }
        break;
      case 'stashBranch': {
        const name = await vscode.window.showInputBox({ prompt: `New branch from ${ref}`, placeHolder: 'feature/from-stash' });
        if (!name) {
          return;
        }
        await repo.exec(['stash', 'branch', name.trim(), ref!]);
        break;
      }
      // Drag and drop of a branch badge onto another one.
      case 'mergeInto': {
        const current = await repo.currentBranch();
        const msg = current === target ? `Merge '${ref}' into '${target}'?` : `Checkout '${target}' and merge '${ref}' into it?`;
        if (await confirm(msg, 'Merge')) {
          if (current !== target) {
            await repo.checkout(target!);
          }
          await repo.exec(['merge', '--no-edit', ref!]);
        }
        break;
      }
      case 'rebaseOnto': {
        const current = await repo.currentBranch();
        const msg = current === ref ? `Rebase '${ref}' onto '${target}'?` : `Checkout '${ref}' and rebase it onto '${target}'?`;
        if (await confirm(msg, 'Rebase')) {
          if (current !== ref) {
            await repo.checkout(ref!);
          }
          await repo.exec(['rebase', target!]);
        }
        break;
      }
      case 'fetch':
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Fetching…' },
          () => repo.fetch(),
        );
        break;
      default:
        return;
    }
    await this.load();
  }

  private html(extensionUri: vscode.Uri): string {
    return webviewHtml(this.host.webview, extensionUri, {
      view: 'graph',
      title: 'Git Graph',
      body: GRAPH_BODY,
      script: ['diffpreview.js', 'graphKeys.js', 'graph.js'],
      restore: { kind: 'graph', repoRoot: this.repo?.root },
    });
  }

  /** Immediate avatar URLs per email; better pictures are looked up in the background. */
  private avatarMap(repo: Repo, commits: Commit[]): Record<string, string> {
    const map: Record<string, string> = {};
    if (!config('graph.avatars', true)) {
      return map;
    }
    for (const c of commits) {
      const email = c.email.toLowerCase();
      if (email && !map[email]) {
        map[email] = this.avatars.urlFor(email);
        this.avatars.resolve(repo, email, c.sha);
      }
    }
    return map;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Webview markup (also used by the screenshot harness). */
export const GRAPH_BODY = `<header id="toolbar">
  <div class="title">
    <span class="repo"><i class="codicon codicon-repo"></i><span id="repoName"></span></span>
    <button id="branchName" class="branch" title="Pick a branch to focus on" aria-haspopup="listbox"></button>
    <span id="remoteName" class="remote"></span>
  </div>
  <div class="tools">
    <span class="seg gl-seg" id="scope" title="What the graph shows">
      <button data-scope="all" title="All branches"><i class="codicon codicon-repo-forked"></i><span class="label">All</span></button>
      <button data-scope="branch" title="Only the history of one branch (the current one, or the one you focus)"><i class="codicon codicon-git-branch"></i><span class="label">Branch</span></button>
      <button data-scope="timeline" title="Timeline: the main line of the branch, one row per merged branch / pull request"><i class="codicon codicon-history"></i><span class="label">Timeline</span></button>
    </span>
    <button id="btnBranches" class="branches" title="Pick a branch to focus on"><i class="codicon codicon-git-branch"></i><span class="label" id="branchesLabel">Branches</span><i class="codicon codicon-chevron-down"></i></button>
    <label class="search"><i class="codicon codicon-search"></i><input id="search" type="search" placeholder="Search commits, authors, SHAs, branches" spellcheck="false" /><span id="searchCount"></span><kbd>Enter</kbd></label>
    <button id="btnFilter" class="icon" title="Filter commits"><i class="codicon codicon-filter"></i><span id="filterCount" class="count"></span></button>
    <button id="btnFetch" class="icon" title="Fetch from remotes"><i class="codicon codicon-cloud-download"></i><span class="label">Fetch</span></button>
    <button id="btnOverflow" class="icon" title="More actions" aria-haspopup="menu"><i class="codicon codicon-ellipsis"></i></button>
    <span class="tb-overflow" hidden>
      <button id="btnCompare" title="Compare branches or tags…"></button>
      <button id="btnMinimap" title="Toggle activity minimap"></button>
      <button id="btnRefresh" title="Refresh"></button>
      <button id="btnKeys" title="Keyboard shortcuts (?)"></button>
    </span>
  </div>
</header>
<div id="minimap" hidden></div>
<div id="state" class="gl-empty is-loading" role="status"><i class="codicon codicon-loading codicon-modifier-spin"></i><span>Loading commits…</span></div>
<main id="main">
  <div id="list" tabindex="0">
    <div id="header" class="row header">
      <div class="c-graph">Graph<span class="grip" data-col="graph" data-dir="1"></span></div>
      <div class="c-msg">Commit</div>
      <div class="c-author"><span class="grip left" data-col="author" data-dir="-1"></span>Author</div>
      <div class="c-date"><span class="grip left" data-col="date" data-dir="-1"></span>When</div>
      <div class="c-sha"><span class="grip left" data-col="sha" data-dir="-1"></span>SHA</div>
    </div>
    <div id="rows"></div>
    <div id="more"></div>
  </div>
  <section id="details" hidden></section>
</main>
<div id="card" class="card gl-pop" hidden></div>
<div id="picker" class="picker gl-pop" hidden><label class="search"><i class="codicon codicon-filter"></i><input id="pickerInput" type="text" placeholder="Filter branches and tags" spellcheck="false" /></label><div id="pickerList"></div></div>
<div id="menu" class="menu gl-pop" hidden></div>
<div id="notice" class="gl-pill c-link" hidden></div>
<div id="keysCard" class="gl-pop" hidden>
  <div class="kc-h"><i class="codicon codicon-keyboard"></i>Keyboard</div>
  <dl>
    <dt><kbd>↑</kbd><kbd>↓</kbd> <kbd>k</kbd><kbd>j</kbd></dt><dd>Previous / next commit</dd>
    <dt><kbd>Home</kbd><kbd>End</kbd></dt><dd>First / last commit</dd>
    <dt><kbd>PgUp</kbd><kbd>PgDn</kbd></dt><dd>One screen up / down</dd>
    <dt><kbd>Enter</kbd><kbd>Space</kbd></dt><dd>Show / hide the details</dd>
    <dt><kbd>←</kbd><kbd>→</kbd></dt><dd>Parent / child</dd>
    <dt><kbd>m</kbd></dt><dd>Merge base with the current branch</dd>
    <dt><kbd>c</kbd></dt><dd>Compare with the next commit you pick</dd>
    <dt><kbd>Ctrl</kbd><kbd>F</kbd></dt><dd>Search</dd>
    <dt><kbd>Esc</kbd></dt><dd>Close / clear the focus</dd>
  </dl>
</div>`;

/**
 * How a merge reads in the timeline: the chip (branch, or "PR 12" for Azure DevOps "Merged PR 12: title")
 * and the text next to it, so the branch name is not repeated.
 */
function timelineMerge(subject: string): { label: string; color: number; title: string } {
  let m = /^Merged PR (\d+):\s*(.*)$/i.exec(subject);
  if (m) {
    return { label: `PR ${m[1]}`, color: branchColor(conventionalType(m[2]) ?? 'merge'), title: m[2] };
  }
  m = /^Merge pull request #?(\d+) from (?:[\w.-]+:)?(\S+?)(?: into (\S+))?$/i.exec(subject);
  if (m) {
    return { label: m[2], color: branchColor(m[2]), title: `PR ${m[1]}${m[3] ? ` → ${m[3]}` : ''}` };
  }
  const branch = mergedBranchName(subject);
  return { label: branch ?? 'merge', color: branchColor(branch ?? 'merge'), title: subject };
}

/** "2 modified, 1 added, 1 untracked" counts for the uncommitted changes row. */
function summarizeChanges(changes: { status: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of changes) {
    out[c.status] = (out[c.status] ?? 0) + 1;
  }
  return out;
}

/** Authors of the loaded history, most active first (for the author filter). */
function authorList(commits: Commit[]): { name: string; email: string; count: number }[] {
  const by = new Map<string, { name: string; email: string; count: number }>();
  for (const c of commits) {
    const key = c.email.toLowerCase();
    const a = by.get(key) ?? { name: c.author, email: c.email, count: 0 };
    a.count++;
    by.set(key, a);
  }
  return [...by.values()].sort((a, b) => b.count - a.count).slice(0, 50);
}

function parseNameStatusLines(out: string): { status: string; path: string; oldPath?: string; added?: number; deleted?: number }[] {
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const p = l.split('\t');
      const st = p[0][0];
      return (st === 'R' || st === 'C') && p.length >= 3 ? { status: st, oldPath: p[1], path: p[2] } : { status: st, path: p[1] };
    });
}

function stripRemote(ref: string, remotes: string[]): string {
  const r = remotes.find((x) => ref.startsWith(x + '/'));
  return r ? ref.slice(r.length + 1) : ref;
}

export async function checkoutRef(repo: Repo, ref: string, isRemote: boolean): Promise<void> {
  if (!isRemote) {
    await repo.checkout(ref);
    return;
  }
  const local = stripRemote(ref, await repo.remoteNames());
  if (await repo.localBranchExists(local)) {
    await repo.checkout(local);
  } else {
    await repo.exec(['checkout', '-b', local, '--track', ref]);
  }
}

/** Opens the diff of one file as changed by `sha` (or the working tree when sha is WORKTREE). */
export async function openCommitFileDiff(
  repos: RepoManager,
  repo: Repo,
  sha: string,
  relPath: string,
  oldPath: string | undefined,
  status: string,
): Promise<void> {
  const uri = vscode.Uri.file(path.join(repo.root, relPath));
  const oldUri = vscode.Uri.file(path.join(repo.root, oldPath ?? relPath));
  const name = path.basename(relPath);
  if (sha === WORKTREE_SHA) {
    if (status === 'U' || status === 'A') {
      await vscode.commands.executeCommand('vscode.open', uri);
    } else if (status === 'D') {
      await vscode.commands.executeCommand('vscode.open', repos.toGitUri(oldUri, 'HEAD'));
    } else {
      await vscode.commands.executeCommand('vscode.diff', repos.toGitUri(oldUri, 'HEAD'), uri, `${name} (Working Tree)`);
    }
    return;
  }
  const short = sha.slice(0, 7);
  if (status === 'A') {
    await vscode.commands.executeCommand('vscode.open', repos.toGitUri(uri, sha));
  } else if (status === 'D') {
    await vscode.commands.executeCommand('vscode.open', repos.toGitUri(oldUri, `${sha}^`));
  } else {
    await vscode.commands.executeCommand(
      'vscode.diff',
      repos.toGitUri(oldUri, `${sha}^`),
      repos.toGitUri(uri, sha),
      `${name} (${short}^ ↔ ${short})`,
    );
  }
}
