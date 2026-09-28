import * as path from 'path';
import * as vscode from 'vscode';
import { runGit } from './exec';
import { GitApi, GitApiRepository, getGitApi } from './gitApi';
import { Repo } from './repo';

/** Discovers repositories (through the built-in git extension when available) and broadcasts changes. */
export class RepoManager implements vscode.Disposable {
  private api?: GitApi;
  private readonly repos = new Map<string, Repo>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watched = new Set<GitApiRepository>();
  private readonly changeEmitter = new vscode.EventEmitter<Repo>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /** Fires (debounced) when HEAD, refs or the working tree of a repository change. */
  readonly onDidChangeRepo = this.changeEmitter.event;

  async init(): Promise<void> {
    try {
      this.api = await getGitApi();
    } catch {
      this.api = undefined;
    }
    if (!this.api) {
      return;
    }
    this.api.repositories.forEach((r) => this.watch(r));
    this.disposables.push(
      this.api.onDidOpenRepository((r) => this.watch(r)),
      this.api.onDidCloseRepository((r) => this.repos.delete(r.rootUri.fsPath)),
    );
  }

  get gitApi(): GitApi | undefined {
    return this.api;
  }

  private watch(r: GitApiRepository): void {
    if (this.watched.has(r)) {
      return;
    }
    this.watched.add(r);
    this.disposables.push(
      r.state.onDidChange(() => {
        const root = r.rootUri.fsPath;
        clearTimeout(this.timers.get(root));
        this.timers.set(
          root,
          setTimeout(() => {
            const repo = this.fromApi(r);
            repo.invalidate();
            this.changeEmitter.fire(repo);
          }, 400),
        );
      }),
    );
  }

  private fromApi(r: GitApiRepository): Repo {
    const root = r.rootUri.fsPath;
    let repo = this.repos.get(root);
    if (!repo) {
      repo = new Repo(root, r);
      this.repos.set(root, repo);
    }
    return repo;
  }

  async getRepo(uri: vscode.Uri): Promise<Repo | undefined> {
    const r = this.api?.getRepository(uri);
    if (r) {
      return this.fromApi(r);
    }
    if (uri.scheme !== 'file') {
      return undefined;
    }
    for (const repo of this.repos.values()) {
      if (uri.fsPath === repo.root || uri.fsPath.startsWith(repo.root + path.sep)) {
        return repo;
      }
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const dir = stat.type & vscode.FileType.Directory ? uri.fsPath : path.dirname(uri.fsPath);
      const root = (await runGit(dir, ['rev-parse', '--show-toplevel'])).trim();
      if (!root) {
        return undefined;
      }
      const normalized = path.normalize(root);
      let repo = this.repos.get(normalized);
      if (!repo) {
        repo = new Repo(normalized);
        this.repos.set(normalized, repo);
      }
      return repo;
    } catch {
      return undefined;
    }
  }

  /** Repository of the active editor, or the only/first workspace repository (asking if ambiguous). */
  async activeRepo(ask = true): Promise<Repo | undefined> {
    const editorUri = vscode.window.activeTextEditor?.document.uri;
    if (editorUri && editorUri.scheme === 'file') {
      const repo = await this.getRepo(editorUri);
      if (repo) {
        return repo;
      }
    }
    const apiRepos = this.api?.repositories ?? [];
    if (apiRepos.length === 1 || (apiRepos.length > 1 && !ask)) {
      return this.fromApi(apiRepos[0]);
    }
    if (apiRepos.length > 1) {
      const pick = await vscode.window.showQuickPick(
        apiRepos.map((r) => ({ label: path.basename(r.rootUri.fsPath), description: r.rootUri.fsPath, r })),
        { placeHolder: 'Select a repository' },
      );
      return pick ? this.fromApi(pick.r) : undefined;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const repo = await this.getRepo(folder.uri);
      if (repo) {
        return repo;
      }
    }
    return undefined;
  }

  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri {
    if (this.api) {
      return this.api.toGitUri(uri, ref);
    }
    return uri.with({ scheme: 'git', path: uri.path, query: JSON.stringify({ path: uri.fsPath, ref }) });
  }

  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.disposables.forEach((d) => d.dispose());
    this.changeEmitter.dispose();
  }
}
