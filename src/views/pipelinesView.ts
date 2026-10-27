import * as vscode from 'vscode';
import { RepoManager } from '../git/repoManager';
import { getProvider, signIn } from '../providers';
import { AuthError, PipelineJob, PipelineRun, Provider } from '../providers/types';
import { log } from '../log';
import { errorMessage } from '../util';
import { webviewHtml, webviewOptions } from './webviewHtml';
import { LIST_BODY } from './ticketsView';
import { capture } from '../devCapture';
import { firstFailed, formatDuration, nextPollDelay, tailLog } from '../pipelines/format.pure';

type Message =
  | { type: 'ready' | 'refresh' | 'signIn' }
  | { type: 'expand' | 'rerun' | 'cancel' | 'open'; id: string };

/** "Pipelines": the CI runs of the current branch, with rerun / cancel and the failed step's log. */
export class PipelinesView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'gitland.pipelines';
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private poll?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private runs: PipelineRun[] = [];
  private signInCommand = 'gitland.switchAzureAccount';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
  ) {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(PipelinesView.viewId, this),
      repos.onDidChangeRepo(() => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.view?.visible && this.refresh(), 1500);
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.context.extensionUri);
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri, {
      view: 'pipelines',
      title: 'Pipelines',
      body: LIST_BODY('Filter pipelines'),
      script: 'pipelines.js',
      styles: ['list.css', 'pipelines.css'],
      bodyClass: 'list',
    });
    view.webview.onDidReceiveMessage((m: Message) => this.onMessage(m), undefined, this.disposables);
    view.onDidChangeVisibility(() => (view.visible ? this.refresh() : this.schedule()), undefined, this.disposables);
    view.onDidDispose(() => {
      clearTimeout(this.poll);
      this.view = undefined;
    }, undefined, this.disposables);
  }

  refresh(): void {
    this.load().catch((e) => log.error('Pipelines: refresh failed', e));
  }

  private post(m: unknown): void {
    capture('pipelines', 'message', m);
    this.view?.webview.postMessage(m);
  }

  /** Next refresh: 30 s while something runs, 2 min otherwise, none while hidden. */
  private schedule(): void {
    clearTimeout(this.poll);
    const delay = nextPollDelay(this.runs, !!this.view?.visible);
    if (delay !== undefined) {
      this.poll = setTimeout(() => this.refresh(), delay);
    }
  }

  private async provider(): Promise<Provider | undefined> {
    const repo = await this.repos.activeRepo(false);
    return repo ? getProvider(repo, this.context.secrets) : undefined;
  }

  private async load(): Promise<void> {
    const repo = await this.repos.activeRepo(false);
    if (!repo) {
      return this.post({ type: 'state', state: 'empty', title: 'No git repository', text: '' });
    }
    const provider = await getProvider(repo, this.context.secrets);
    if (!provider?.pipelineRuns) {
      return this.post({ type: 'state', state: 'empty', title: 'No Azure DevOps, GitHub or GitLab remote', text: 'Pipelines come from the remote of this repository.' });
    }
    this.signInCommand = signIn(provider.kind).command;
    if (!(await provider.isSignedIn())) {
      return this.post({ type: 'state', state: 'signin', title: `Sign in to ${signIn(provider.kind).host}`, text: 'to see the pipeline runs' });
    }
    const branch = await repo.currentBranch();
    if (!this.runs.length) {
      this.post({ type: 'loading' });
    }
    try {
      this.runs = await provider.pipelineRuns({ branch, max: 30 });
      const now = Date.now();
      this.post({
        type: 'runs',
        branch,
        canRerun: !!provider.rerunPipeline,
        canCancel: !!provider.cancelPipeline,
        runs: this.runs.map((r) => ({
          ...r,
          duration: r.started ? formatDuration((r.finished ?? now) - r.started) : undefined,
        })),
      });
    } catch (e) {
      this.post(
        e instanceof AuthError
          ? { type: 'state', state: 'signin', title: 'Sign in to load the pipelines', text: errorMessage(e) }
          : { type: 'state', state: 'error', title: 'Could not load the pipelines', text: errorMessage(e) },
      );
    }
    this.schedule();
  }

  /** Jobs of a run and, for its first failed step, the end of the log. */
  private async expand(provider: Provider, run: PipelineRun): Promise<void> {
    const jobs: PipelineJob[] = provider.pipelineJobs ? await provider.pipelineJobs(run) : [];
    const failed = firstFailed(jobs);
    let failedLog: string | undefined;
    if (failed && provider.pipelineLog) {
      failedLog = tailLog(await provider.pipelineLog(run, failed).catch((e) => `Could not read the log: ${errorMessage(e)}`), 50);
    }
    this.post({ type: 'jobs', id: run.id, jobs, failed: failed?.id, failedLog });
  }

  private async onMessage(m: Message): Promise<void> {
    try {
      if (m.type === 'ready' || m.type === 'refresh') {
        return this.refresh();
      }
      if (m.type === 'signIn') {
        await vscode.commands.executeCommand(this.signInCommand);
        return this.refresh();
      }
      const id = 'id' in m ? m.id : '';
      const run = this.runs.find((r) => r.id === id);
      const provider = await this.provider();
      if (!run || !provider) {
        return;
      }
      switch (m.type) {
        case 'open':
          await vscode.env.openExternal(vscode.Uri.parse(run.url));
          return;
        case 'expand':
          return this.expand(provider, run);
        case 'rerun':
          await provider.rerunPipeline?.(run);
          vscode.window.setStatusBarMessage(`Gitland: ${run.name} queued again`, 3000);
          return this.refresh();
        case 'cancel':
          await provider.cancelPipeline?.(run);
          vscode.window.setStatusBarMessage(`Gitland: cancelling ${run.name}`, 3000);
          return this.refresh();
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`);
    }
  }

  dispose(): void {
    clearTimeout(this.poll);
    clearTimeout(this.debounce);
    this.disposables.forEach((d) => d.dispose());
  }
}
