import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { log } from '../log';

/**
 * Bubble with the number of uncommitted changes on the Gitland activity bar icon.
 * VS Code adds up the badges of a container's views, and a webview view only exists once it has
 * been shown: the count goes on exactly one existing view, the first of `order` (Changes, else Graph).
 */
export class ChangesBadge implements vscode.Disposable {
  private readonly views = new Map<string, vscode.WebviewView>();
  private count = 0;
  private last = '';
  private timer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly repos: RepoManager,
    private readonly order: string[],
  ) {
    this.disposables.push(
      repos.onDidChangeRepo(() => this.schedule()),
      vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
    );
    this.schedule();
  }

  /** A sidebar view became available (resolveWebviewView). */
  attach(viewId: string, view: vscode.WebviewView): void {
    this.views.set(viewId, view);
    view.onDidDispose(() => {
      if (this.views.get(viewId) === view) {
        this.views.delete(viewId);
        this.apply();
      }
    });
    this.apply();
  }

  /** New count from a view that already computed the status. */
  set(count: number): void {
    this.count = count;
    this.apply();
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

  private apply(): void {
    const target = this.order.find((id) => this.views.has(id));
    const badge = this.count ? { value: this.count, tooltip: `${this.count} uncommitted change${this.count === 1 ? '' : 's'}` } : undefined;
    for (const [id, view] of this.views) {
      view.badge = id === target ? badge : undefined;
    }
    const now = `${this.count} on ${target ?? 'no view yet'}`;
    if (now !== this.last) {
      this.last = now;
      log.info(`Changes badge: ${now}`);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}
