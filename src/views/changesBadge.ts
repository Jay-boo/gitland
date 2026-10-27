import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { log } from '../log';

/**
 * Bubble with the number of uncommitted changes on the Gitland activity bar icon, like Source Control's.
 * VS Code adds up the badges of a container's views, but a webview view only exists once the
 * container has been opened. A tree view exists from activation, even hidden (`when: false`),
 * so the count goes on an empty, never shown tree view of the sidebar.
 */
export class ChangesBadge implements vscode.Disposable {
  static readonly viewId = 'gitland.changesBadge';

  private readonly view: vscode.TreeView<never>;
  private count = -1;
  private timer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly repos: RepoManager) {
    this.view = vscode.window.createTreeView<never>(ChangesBadge.viewId, { treeDataProvider: { getTreeItem: (e) => e, getChildren: () => [] } });
    this.disposables.push(
      this.view,
      repos.onDidChangeRepo(() => this.schedule()),
      vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
    );
    this.schedule();
  }

  /** New count from a view that already computed the status. */
  set(count: number): void {
    if (count === this.count) {
      return;
    }
    this.count = count;
    this.view.badge = count ? { value: count, tooltip: `${count} uncommitted change${count === 1 ? '' : 's'}` } : undefined;
    log.info(`Changes badge: ${count}`);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.update(), 300);
  }

  private async update(): Promise<void> {
    const repo: Repo | undefined = await this.repos.activeRepo(false);
    if (!repo) {
      return this.set(0);
    }
    try {
      const s = await repo.status();
      // A file both staged and modified again counts once.
      this.set(new Set([...s.staged, ...s.unstaged, ...s.conflicts].map((f) => f.path)).size);
    } catch {
      /* not a repository any more */
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}
