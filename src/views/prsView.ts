import * as vscode from 'vscode';
import { RepoManager } from '../git/repoManager';
import { getProvider } from '../providers';
import { AuthError, PullRequest } from '../providers/types';
import { log } from '../log';
import { errorMessage } from '../util';
import { webviewHtml, webviewOptions } from './webviewHtml';
import { LIST_BODY } from './ticketsView';
import { capture } from '../devCapture';

/** What the pull request commands receive (from the webview). */
export interface PullRequestItem {
  pr: PullRequest;
}

type Message = { type: 'ready' | 'refresh' | 'create' | 'signIn' } | { type: 'open' | 'checkout' | 'show'; id: string };

/** "Pull Requests": mine / to review / others, in the Gitland style. */
export class PullRequestsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'gitland.prs';
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private prs: PullRequest[] = [];
  private signInCommand = 'gitland.switchAzureAccount';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.disposables.push(vscode.window.registerWebviewViewProvider(PullRequestsView.viewId, this));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.context.extensionUri);
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri, {
      view: 'prs',
      title: 'Pull Requests',
      body: LIST_BODY('Filter pull requests'),
      script: 'prs.js',
      styles: ['list.css'],
      bodyClass: 'list',
    });
    view.webview.onDidReceiveMessage((m: Message) => this.onMessage(m), undefined, this.disposables);
    view.onDidChangeVisibility(() => view.visible && this.refresh(), undefined, this.disposables);
  }

  refresh(): void {
    this.load().catch((e) => log.error('Pull requests: refresh failed', e));
  }

  private post(m: unknown): void {
    capture('prs', 'message', m);
    this.view?.webview.postMessage(m);
  }

  private async load(): Promise<void> {
    if (!this.view) {
      return;
    }
    const repo = await this.repos.activeRepo(false);
    if (!repo) {
      return this.post({ type: 'state', state: 'empty', title: 'No git repository', text: 'Open a folder with an Azure DevOps or GitHub remote.' });
    }
    const provider = await getProvider(repo, this.secrets);
    if (!provider) {
      return this.post({ type: 'state', state: 'empty', title: 'No Azure DevOps or GitHub remote', text: 'Pull requests come from the remote of this repository.' });
    }
    this.signInCommand = provider.kind === 'azure' ? 'gitland.switchAzureAccount' : 'gitland.switchGitHubAccount';
    this.view.description = provider.displayName.replace(/^(Azure DevOps|GitHub) · /, '');
    if (!(await provider.isSignedIn())) {
      return this.post({ type: 'state', state: 'signin', title: `Sign in to ${provider.kind === 'azure' ? 'Azure DevOps' : 'GitHub'}`, text: 'to see the pull requests' });
    }
    this.post({ type: 'loading' });
    try {
      const [prs, current] = await Promise.all([provider.listPullRequests(), repo.currentBranch()]);
      this.prs = prs;
      const count = (g: string) => prs.filter((p) => p.group === g).length;
      const onBranch = prs.find((p) => p.sourceBranch === current);
      log.info(
        `Pull requests: ${prs.length} active (mine ${count('mine')}, to review ${prs.filter((p) => p.group === 'review' || p.needsMyReview).length}, others ${count('other')}); ` +
          `current branch ${current ?? '(detached)'} → ${onBranch ? onBranch.label : 'no PR'}`,
      );
      this.view.description = `${prs.length} active${count('mine') ? ` · ${count('mine')} mine` : ''}`;
      this.post({ type: 'prs', prs, current });
    } catch (e) {
      log.error(`Loading from ${provider.displayName} failed`, e);
      this.post(
        e instanceof AuthError
          ? { type: 'state', state: 'signin', title: 'Sign in to load pull requests', text: errorMessage(e) }
          : { type: 'state', state: 'error', title: 'Could not load the pull requests', text: errorMessage(e) },
      );
    }
  }

  private async onMessage(m: Message): Promise<void> {
    const pr = 'id' in m ? this.prs.find((p) => p.id === m.id) : undefined;
    switch (m.type) {
      case 'ready':
      case 'refresh':
        return this.refresh();
      case 'create':
        await vscode.commands.executeCommand('gitland.prs.create');
        return;
      case 'signIn':
        await vscode.commands.executeCommand(this.signInCommand);
        return this.refresh();
      case 'show':
        if (pr) {
          await vscode.commands.executeCommand('gitland.prs.show', { pr } satisfies PullRequestItem);
        }
        return;
      case 'open':
        if (pr) {
          await vscode.commands.executeCommand('gitland.prs.open', { pr } satisfies PullRequestItem);
        }
        return;
      case 'checkout':
        if (pr) {
          await vscode.commands.executeCommand('gitland.prs.checkout', { pr } satisfies PullRequestItem);
        }
        return;
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
