import * as path from 'path';
import * as vscode from 'vscode';
import { Commit, Repo, WORKTREE_SHA } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { getProvider } from '../providers';
import { config, errorMessage, formatDate } from '../util';
import { computeGraph } from './layout';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'loadMore' }
  | { type: 'select'; sha: string }
  | { type: 'openDiff'; sha: string; path: string; oldPath?: string; status: string }
  | { type: 'action'; action: string; sha?: string; ref?: string; refType?: string };

export class GraphPanel implements vscode.Disposable {
  private static current?: GraphPanel;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private repo: Repo;
  private max: number;
  private pendingSelect?: string;
  private commits: Commit[] = [];

  static show(context: vscode.ExtensionContext, repos: RepoManager, repo: Repo, selectSha?: string): void {
    if (GraphPanel.current) {
      const p = GraphPanel.current;
      p.panel.reveal(undefined, false);
      if (p.repo.root !== repo.root) {
        p.repo = repo;
        p.max = config('graph.maxCommits', 400);
      }
      p.pendingSelect = selectSha;
      p.load();
      return;
    }
    GraphPanel.current = new GraphPanel(context, repos, repo, selectSha);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    repo: Repo,
    selectSha?: string,
  ) {
    this.repo = repo;
    this.max = config('graph.maxCommits', 400);
    this.pendingSelect = selectSha;
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('gitland.graph', 'Git Graph', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'activity.svg');
    this.panel.webview.html = this.html(media);
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m)),
      repos.onDidChangeRepo((r) => {
        if (r.root === this.repo.root && this.panel.visible) {
          this.load();
        }
      }),
      this.panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          this.load();
        }
      }),
    );
  }

  private post(message: unknown): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  private async load(): Promise<void> {
    try {
      const [commits, head, branch, dirty, provider] = await Promise.all([
        this.repo.log(this.max + 1),
        this.repo.headSha(),
        this.repo.currentBranch(),
        this.repo.isDirty().catch(() => false),
        getProvider(this.repo, this.context.secrets),
      ]);
      const hasMore = commits.length > this.max;
      const list = commits.slice(0, this.max);
      if (dirty && head) {
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
      const graph = computeGraph(list);
      this.panel.title = `Git Graph · ${path.basename(this.repo.root)}`;
      await this.post({
        type: 'data',
        repoName: path.basename(this.repo.root),
        branch,
        head,
        hasMore,
        width: graph.width,
        remote: provider?.displayName,
        commits: list.map((c, i) => ({
          sha: c.sha,
          short: c.sha === WORKTREE_SHA ? '' : c.sha.slice(0, 7),
          parents: c.parents,
          author: c.author,
          email: c.email,
          date: c.sha === WORKTREE_SHA ? '' : formatDate(c.date),
          subject: c.subject,
          refs: c.refs,
          graph: graph.rows[i],
        })),
        select: this.pendingSelect,
      });
      this.pendingSelect = undefined;
    } catch (e) {
      await this.post({ type: 'error', message: errorMessage(e) });
    }
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
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
        case 'openDiff':
          await this.openDiff(m.sha, m.path, m.oldPath, m.status);
          break;
        case 'action':
          await this.runAction(m.action, m.sha, m.ref, m.refType);
          break;
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`);
    }
  }

  private async sendDetails(sha: string): Promise<void> {
    if (sha === WORKTREE_SHA) {
      const files = await this.repo.workingTreeChanges();
      await this.post({ type: 'details', sha, details: { sha, message: 'Uncommitted changes', files, parents: [] } });
      return;
    }
    const d = await this.repo.commitDetails(sha);
    const commit = this.commits.find((c) => c.sha === sha);
    await this.post({
      type: 'details',
      sha,
      details: {
        ...d,
        authorDate: formatDate(d.authorDate),
        commitDate: formatDate(d.commitDate),
        refs: commit?.refs ?? [],
      },
    });
  }

  async openDiff(sha: string, relPath: string, oldPath: string | undefined, status: string): Promise<void> {
    await openCommitFileDiff(this.repos, this.repo, sha, relPath, oldPath, status);
  }

  private async runAction(action: string, sha?: string, ref?: string, refType?: string): Promise<void> {
    const repo = this.repo;
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
      case 'openRemote':
      case 'openBranchRemote': {
        const provider = await getProvider(repo, this.context.secrets);
        if (!provider) {
          vscode.window.showInformationMessage('No Azure DevOps / GitHub remote found for this repository.');
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

  private html(media: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Git Graph</title>
</head>
<body>
<header id="toolbar">
  <div class="title"><span id="repoName"></span><span id="branchName" class="pill"></span><span id="remoteName" class="muted"></span></div>
  <div class="tools">
    <input id="search" type="search" placeholder="Search message, author, SHA, branch…  (Enter = next)" />
    <span id="searchCount" class="muted"></span>
    <button id="btnFetch" title="Fetch">⤓ Fetch</button>
    <button id="btnRefresh" title="Refresh">⟳</button>
  </div>
</header>
<main id="main">
  <div id="list" tabindex="0">
    <div id="header" class="row header"><div class="c-graph">Graph</div><div class="c-msg">Description</div><div class="c-author">Author</div><div class="c-date">Date</div><div class="c-sha">SHA</div></div>
    <div id="rows"></div>
    <div id="more"></div>
  </div>
  <section id="details" hidden></section>
</main>
<div id="menu" class="menu" hidden></div>
<div id="error" hidden></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    GraphPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
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
