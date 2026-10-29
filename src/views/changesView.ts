import * as path from 'path';
import * as vscode from 'vscode';
import { Repo, RepoStatus } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { getProvider } from '../providers';
import { log } from '../log';
import { config, errorMessage } from '../util';
import { generateCommitMessage } from '../commitMessage';
import { webviewHtml, webviewOptions, pageIcon } from './webviewHtml';
import { ChangesBadge } from './changesBadge';
import { capture } from '../devCapture';
import { needsTicketReminder, withTicketRef } from '../tickets/reminder.pure';
import { pickTicket } from '../commands/work';
import { ticketPrefix } from '../providers/ticketPrefix.pure';

type Message =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'stage' | 'unstage' | 'discard'; paths: string[] }
  | { type: 'stageAll' | 'unstageAll' | 'discardAll' }
  | { type: 'open'; path: string; oldPath?: string; status: string; staged: boolean; alt?: boolean }
  | { type: 'openFile'; path: string }
  | { type: 'preview'; key: string; path: string; oldPath?: string; status: string; staged: boolean }
  | { type: 'commit'; message: string; amend: boolean; push: boolean; sign?: boolean; noVerify?: boolean }
  | { type: 'lastMessage' }
  | { type: 'generate' }
  | { type: 'stopGenerate' }
  | { type: 'git'; action: 'push' | 'pull' | 'sync' | 'fetch' }
  | { type: 'operation'; action: 'continue' | 'abort' | 'skip' }
  | { type: 'resolve'; path: string; side: 'ours' | 'theirs' | 'mark' | 'editor' }
  | { type: 'openUrl'; url: string };

/**
 * "Changes" view: stage, discard, commit and push like the built-in Source Control view,
 * in the Gitland style (same look as the Commit Graph).
 */
export class ChangesView implements vscode.WebviewViewProvider, vscode.Disposable {
  /** In the Gitland sidebar; the same view can also be in the bottom panel (panelViewId). */
  static readonly viewId = 'gitland.changesView';
  static readonly panelViewId = 'gitland.changesPanelView';
  /** Where it shows: a view (sidebar, bottom panel) or an editor tab (showInEditor). */
  private view?: { webview: vscode.Webview; description?: string };
  private panel?: vscode.WebviewPanel;
  private repo?: Repo;
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;
  private busy = false;
  private generating?: vscode.CancellationTokenSource;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly badge: ChangesBadge,
    private readonly viewId: string = ChangesView.viewId,
  ) {
    this.disposables.push(
      repos.onDidChangeRepo((r) => r.root === this.repo?.root && this.schedule()),
      vscode.window.onDidChangeActiveTextEditor(async (e) => {
        if (e?.document.uri.scheme !== 'file') {
          return;
        }
        const r = await this.repos.getRepo(e.document.uri);
        if (r && r.root !== this.repo?.root) {
          this.repo = r;
          this.schedule();
        }
      }),
      vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.context.extensionUri);
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: Message) => this.onMessage(m), undefined, this.disposables);
    view.onDidChangeVisibility(() => view.visible && this.schedule(), undefined, this.disposables);
  }

  /** The same page in an editor tab (like the Commit Graph's "Open in Editor"). */
  attachPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    this.view = panel;
    panel.iconPath = pageIcon(this.context.extensionUri, 'changes');
    panel.webview.html = this.html(panel.webview, true);
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m), undefined, this.disposables);
    panel.onDidChangeViewState((e) => e.webviewPanel.visible && this.schedule(), undefined, this.disposables);
    panel.onDidDispose(() => this.dispose());
    this.schedule();
  }

  reveal(): void {
    this.panel?.reveal();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 150);
  }

  private post(m: unknown): void {
    capture('changes', 'message', m);
    this.view?.webview.postMessage(m);
  }

  private async currentRepo(): Promise<Repo | undefined> {
    this.repo ??= await this.repos.activeRepo(false);
    return this.repo;
  }

  async refresh(): Promise<void> {
    const repo = await this.currentRepo();
    if (!repo) {
      this.post({ type: 'error', message: 'No git repository in this workspace.' });
      return;
    }
    try {
      const [status, ticket, provider, operation] = await Promise.all([
        repo.status(),
        this.ticketOf(repo),
        getProvider(repo, this.context.secrets),
        repo.operation().catch(() => undefined),
      ]);
      const [hooks, gpgsign, signingKey, gpgFormat] = await Promise.all([
        repo.commitHooks().catch(() => []),
        repo.getConfig('commit.gpgsign'),
        repo.getConfig('user.signingkey'),
        repo.getConfig('gpg.format'),
      ]);
      // A file both staged and modified again counts once.
      const count = new Set([...status.staged, ...status.unstaged, ...status.conflicts].map((f) => f.path)).size;
      this.badge.set(count);
      if (this.panel) {
        this.panel.title = `Changes · ${status.branch ?? 'detached'}`;
      } else if (this.view) {
        this.view.description = status.branch ?? 'detached';
      }
      this.post({
        type: 'status',
        repoName: path.basename(repo.root),
        status,
        ticket,
        ticketPrefix: ticketPrefix(provider),
        operation,
        hooks,
        signing: { always: gpgsign === 'true', available: !!signingKey || gpgFormat === 'ssh' },
        busy: this.busy,
      });
    } catch (e) {
      log.error('Changes: status failed', e);
      this.post({ type: 'error', message: errorMessage(e) });
    }
  }

  /**
   * Before committing on a branch with no ticket: offer to link one (gitland.changes.ticketReminder).
   * Returns the message to commit (with the reference added when a ticket was linked), or undefined to cancel.
   */
  private async remindTicket(repo: Repo, message: string): Promise<string | undefined> {
    const branch = await repo.currentBranch();
    const [linked, skipped, provider] = await Promise.all([
      branch ? repo.getConfig(`branch.${branch}.gitlandTicket`) : undefined,
      branch ? repo.getConfig(`branch.${branch}.gitlandNoTicket`) : undefined,
      getProvider(repo, this.context.secrets).catch(() => undefined),
    ]);
    const prefix = ticketPrefix(provider);
    if (!provider || !needsTicketReminder({ enabled: config('changes.ticketReminder', true), branch, linkedTicket: linked, skipped: skipped === 'true', message, prefix, keys: Object.keys(provider?.ticketKeys ?? {}) })) {
      return message;
    }
    const link = 'Link a ticket…';
    const anyway = 'Commit anyway';
    const never = "Don't ask for this branch";
    const choice = await vscode.window.showWarningMessage(`${branch} has no ticket. Link one so this commit shows up on it?`, { modal: true }, link, anyway, never);
    if (choice === anyway) {
      return message;
    }
    if (choice === never) {
      await repo.setConfig(`branch.${branch}.gitlandNoTicket`, 'true');
      return message;
    }
    if (choice !== link) {
      return undefined;
    }
    const ticket = await pickTicket(provider);
    if (!ticket) {
      return undefined;
    }
    await repo.setConfig(`branch.${branch}.gitlandTicket`, ticket.id);
    await repo.setConfig(`branch.${branch}.gitlandTicketTitle`, ticket.title);
    void this.refresh();
    return withTicketRef(message, `${prefix}${ticket.id}`);
  }

  /** Ticket linked to the current branch by "Start work" (branch.<name>.gitlandTicket). */
  private async ticketOf(repo: Repo): Promise<{ id: string; title?: string } | undefined> {
    const branch = await repo.currentBranch();
    if (!branch) {
      return undefined;
    }
    const id = await repo.getConfig(`branch.${branch}.gitlandTicket`);
    return id ? { id, title: await repo.getConfig(`branch.${branch}.gitlandTicketTitle`) } : undefined;
  }

  private async onMessage(m: Message): Promise<void> {
    const repo = await this.currentRepo();
    if (!repo) {
      return;
    }
    try {
      switch (m.type) {
        case 'ready':
        case 'refresh':
          break;
        case 'stage':
          await repo.exec(['add', '--', ...m.paths]);
          break;
        case 'unstage':
          await repo.exec(['restore', '--staged', '--', ...m.paths]);
          break;
        case 'stageAll':
          await repo.exec(['add', '-A']);
          break;
        case 'unstageAll':
          await repo.exec(['restore', '--staged', '--', '.']);
          break;
        case 'discard':
          await this.discard(repo, m.paths);
          break;
        case 'discardAll':
          await this.discard(repo, (await repo.status()).unstaged.map((f) => f.path));
          break;
        case 'open':
          // gitland.changes.clickOpens picks the diff or the file; Alt+click opens the other one. A deleted file has only its diff.
          if (m.status !== 'D' && (config<string>('changes.clickOpens', 'changes') === 'file') !== !!m.alt)
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(repo.root, m.path)));
          else await this.openChange(repo, m.path, m.oldPath, m.status, m.staged);
          return;
        case 'preview': {
          const paths = ['--', ...(m.oldPath ? [m.oldPath] : []), m.path];
          const old = m.oldPath ?? m.path;
          const preview =
            m.status === 'U' ? await repo.diffPreview([], m.path, { path: m.path, before: undefined, after: { file: m.path } })
            : m.staged ? await repo.diffPreview(['diff', '--cached', ...paths], undefined, { path: m.path, before: m.status === 'A' ? undefined : { rev: 'HEAD', path: old }, after: m.status === 'D' ? undefined : { rev: '', path: m.path } })
            : await repo.diffPreview(['diff', ...paths], undefined, { path: m.path, before: { rev: '', path: m.path }, after: m.status === 'D' ? undefined : { file: m.path } });
          this.post({ type: 'preview', key: m.key, ...preview });
          return;
        }
        case 'openFile':
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(repo.root, m.path)));
          return;
        case 'generate':
          await this.generate(repo);
          return;
        case 'stopGenerate':
          this.generating?.cancel();
          return;
        case 'lastMessage':
          this.post({ type: 'lastMessage', message: (await repo.exec(['log', '-1', '--format=%B']).catch(() => '')).trim() });
          return;
        case 'commit':
          await this.commit(repo, m.message, m.amend, m.push, m.sign, m.noVerify);
          break;
        case 'git':
          await this.run(repo, m.action);
          break;
        case 'operation':
          await this.operation(repo, m.action);
          break;
        case 'resolve':
          await this.resolve(repo, m.path, m.side);
          break;
        case 'openUrl':
          await vscode.commands.executeCommand('gitland.openLink', m.url);
          return;
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`);
    }
    repo.invalidate();
    await this.refresh();
  }

  /** ✨ Commit message from the diff, streamed into the message box. */
  private async generate(repo: Repo): Promise<void> {
    this.generating?.cancel();
    const cts = (this.generating = new vscode.CancellationTokenSource());
    const [ticket, provider] = await Promise.all([this.ticketOf(repo), getProvider(repo, this.context.secrets)]);
    this.post({ type: 'genStart' });
    try {
      const text = await generateCommitMessage(
        repo,
        ticket && { ...ticket, prefix: ticketPrefix(provider) },
        (t) => this.post({ type: 'genText', text: t }),
        cts.token,
      );
      this.post({ type: 'genDone', text });
    } catch (e) {
      this.post({ type: 'genDone' });
      if (!cts.token.isCancellationRequested) {
        const msg = errorMessage(e);
        log.error('Commit message generation failed', e);
        vscode.window.showWarningMessage(`Gitland: ${/consent|permission|not allowed/i.test(msg) ? 'Allow Gitland to use the language model to generate commit messages.' : msg}`);
      }
    } finally {
      if (this.generating === cts) {
        this.generating = undefined;
      }
      cts.dispose();
    }
  }

  /** Continue / skip / abort the merge, rebase, cherry-pick or revert in progress. */
  private async operation(repo: Repo, action: 'continue' | 'abort' | 'skip'): Promise<void> {
    const op = await repo.operation();
    if (!op) {
      return;
    }
    if (action === 'continue' && (await repo.status()).conflicts.length) {
      throw new Error('Resolve the conflicts first (keep a side, or edit the files and mark them resolved).');
    }
    if (action === 'abort') {
      const ok = await vscode.window.showWarningMessage(`Abort the ${op.kind}? Your branch goes back to where it was before.`, { modal: true }, 'Abort');
      if (ok !== 'Abort') {
        return;
      }
    }
    // Keep the prepared messages instead of opening an editor.
    const env = { GIT_EDITOR: 'true' };
    await this.withBusy(`${action === 'continue' ? 'Continuing' : action === 'skip' ? 'Skipping' : 'Aborting'} the ${op.kind}…`, async () => {
      if (op.kind === 'merge') {
        await repo.exec(action === 'abort' ? ['merge', '--abort'] : ['commit', '--no-edit'], undefined, env);
      } else {
        await repo.exec([op.kind, `--${action}`], undefined, env);
      }
    });
  }

  /** Conflict of one file: keep a side, open the merge editor, or mark it resolved. */
  private async resolve(repo: Repo, rel: string, side: 'ours' | 'theirs' | 'mark' | 'editor'): Promise<void> {
    const uri = vscode.Uri.file(path.join(repo.root, rel));
    if (side === 'editor') {
      try {
        await vscode.commands.executeCommand('git.openMergeEditor', uri);
      } catch {
        await vscode.commands.executeCommand('vscode.open', uri);
      }
      return;
    }
    if (side === 'mark') {
      const text = (await vscode.workspace.fs.readFile(uri).then((b) => Buffer.from(b).toString('utf8'), () => ''));
      if (/^<{7}( |$)/m.test(text) && (await vscode.window.showWarningMessage(`${rel} still has conflict markers (<<<<<<<). Mark it resolved anyway?`, { modal: true }, 'Mark Resolved')) !== 'Mark Resolved') {
        return;
      }
    } else {
      await repo.exec(['checkout', `--${side}`, '--', rel]);
    }
    await repo.exec(['add', '--', rel]);
  }

  /** Throws away working tree changes (untracked files are deleted, after confirmation). */
  private async discard(repo: Repo, paths: string[]): Promise<void> {
    if (!paths.length) {
      return;
    }
    const status = await repo.status();
    const untracked = new Set(status.unstaged.filter((f) => f.status === 'U').map((f) => f.path));
    const what = paths.length === 1 ? `'${paths[0]}'` : `${paths.length} files`;
    const ok = await vscode.window.showWarningMessage(
      `Discard the changes to ${what}? This cannot be undone.${[...untracked].some((p) => paths.includes(p)) ? ' Untracked files will be deleted.' : ''}`,
      { modal: true },
      'Discard',
    );
    if (ok !== 'Discard') {
      return;
    }
    const tracked = paths.filter((p) => !untracked.has(p));
    const fresh = paths.filter((p) => untracked.has(p));
    if (tracked.length) {
      await repo.exec(['restore', '--worktree', '--', ...tracked]);
    }
    if (fresh.length) {
      await repo.exec(['clean', '-f', '-q', '--', ...fresh]);
    }
  }

  private async openChange(repo: Repo, rel: string, oldPath: string | undefined, status: string, staged: boolean): Promise<void> {
    const uri = vscode.Uri.file(path.join(repo.root, rel));
    const name = path.basename(rel);
    if (status === 'U' || (!staged && status === 'A')) {
      await vscode.commands.executeCommand('vscode.open', uri);
    } else if (status === 'D') {
      await vscode.commands.executeCommand('vscode.open', this.repos.toGitUri(vscode.Uri.file(path.join(repo.root, oldPath ?? rel)), staged ? 'HEAD' : '~'));
    } else if (staged) {
      // HEAD ↔ index
      const left = status === 'A' ? undefined : this.repos.toGitUri(vscode.Uri.file(path.join(repo.root, oldPath ?? rel)), 'HEAD');
      const right = this.repos.toGitUri(uri, '');
      await (left
        ? vscode.commands.executeCommand('vscode.diff', left, right, `${name} (Index)`)
        : vscode.commands.executeCommand('vscode.open', right));
    } else {
      // index ↔ working tree
      await vscode.commands.executeCommand('vscode.diff', this.repos.toGitUri(uri, '~'), uri, `${name} (Working Tree)`);
    }
  }

  private async commit(repo: Repo, message: string, amend: boolean, push: boolean, sign = false, noVerify = false): Promise<void> {
    const status = await repo.status();
    if (status.conflicts.length) {
      throw new Error('Resolve the merge conflicts before committing.');
    }
    if (!message.trim() && !amend) {
      throw new Error('Write a commit message first.');
    }
    if (!status.staged.length && !amend) {
      if (!status.unstaged.length) {
        throw new Error('Nothing to commit.');
      }
      const all = 'Stage All & Commit';
      const choice = config('changes.autoStageAll', false)
        ? all
        : await vscode.window.showWarningMessage('There are no staged changes. Stage all changes and commit them?', { modal: true }, all);
      if (choice !== all) {
        return;
      }
      await repo.exec(['add', '-A']);
    }
    // Not on amend (the commit exists) nor on "commit anyway" after a hook refused it (already asked).
    if (!amend && !noVerify) {
      const linked = await this.remindTicket(repo, message);
      if (linked === undefined) {
        return;
      }
      message = linked;
    }
    const hooks = noVerify ? [] : await repo.commitHooks().catch(() => []);
    let failed: string | undefined;
    await this.withBusy(hooks.length ? `Running ${hooks.join(', ')}…` : amend ? 'Amending…' : 'Committing…', async () => {
      const args = [
        'commit',
        ...(amend ? ['--amend'] : []),
        ...(sign ? ['-S'] : []),
        ...(noVerify ? ['--no-verify'] : []),
        ...(message.trim() ? ['-F', '-'] : ['--no-edit']),
      ];
      try {
        await repo.exec(args, message.trim() ? message.trim() + '\n' : undefined);
      } catch (e) {
        // A hook said no: show its output in the view (with "commit anyway"), not a vanishing error.
        if (!hooks.length) {
          throw e;
        }
        // Hooks print to stdout as well as stderr: show both.
        const stdout = (e as { stdout?: string }).stdout;
        failed = [stdout, errorMessage(e)].filter(Boolean).join('\n');
      }
    });
    if (failed) {
      this.post({ type: 'hookFailed', hooks, output: failed, push });
      return;
    }
    this.post({ type: 'committed' });
    vscode.window.setStatusBarMessage(`Gitland: ${amend ? 'amended' : 'committed'}`, 3000);
    if (push) {
      // Behind the upstream: pull first, or the push would be rejected.
      const after = await repo.status();
      await this.run(repo, after.behind && !amend ? 'sync' : 'push', amend);
    }
  }

  private async run(repo: Repo, action: 'push' | 'pull' | 'sync' | 'fetch', force = false): Promise<void> {
    const status = await repo.status();
    const remote = (await repo.defaultRemote()) ?? 'origin';
    const titles = { push: 'Pushing…', pull: 'Pulling…', sync: 'Syncing…', fetch: 'Fetching…' };
    await this.withBusy(titles[action], async () => {
      if (action === 'fetch') {
        await repo.exec(['fetch', '--prune']);
        return;
      }
      if (action === 'pull' || action === 'sync') {
        if (status.upstream) {
          await repo.exec(['pull', '--no-edit', ...(config('changes.pullRebase', false) ? ['--rebase'] : [])]);
        }
      }
      if (action === 'push' || action === 'sync') {
        if (!status.branch) {
          throw new Error('Cannot push a detached HEAD.');
        }
        if (force) {
          const ok = await vscode.window.showWarningMessage(
            `The commit was amended: push with --force-with-lease to ${remote}/${status.branch}?`,
            { modal: true },
            'Force Push',
          );
          if (ok !== 'Force Push') {
            return;
          }
        }
        await repo.exec(['push', ...(force ? ['--force-with-lease'] : []), ...(status.upstream ? [] : ['-u', remote, status.branch])]);
      }
    });
    vscode.window.setStatusBarMessage(`Gitland: ${action} done`, 3000);
  }

  private async withBusy(title: string, task: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.post({ type: 'busy', title });
    try {
      await vscode.window.withProgress({ location: this.panel ? vscode.ProgressLocation.Window : { viewId: this.viewId }, title }, task);
    } finally {
      this.busy = false;
      this.post({ type: 'busy', title: '' });
    }
  }

  private html(webview: vscode.Webview, inEditor = false): string {
    return webviewHtml(webview, this.context.extensionUri, {
      view: 'changes',
      title: 'Changes',
      body: CHANGES_BODY,
      script: ['diffpreview.js', 'changes.js'],
      styles: ['list.css', 'changes.css'],
      bodyClass: inEditor ? 'changes in-editor' : 'changes',
      // Reopened after a window reload when it is an editor tab.
      restore: { kind: 'changes' },
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Webview markup (also used by the screenshot harness). */
export const CHANGES_BODY = `<header class="sync">
  <span id="branch" class="branch"></span>
  <span id="ab" class="ab"></span>
  <span class="grow"></span>
  <button id="btnFetch" class="icon" title="Fetch"><i class="codicon codicon-cloud-download"></i></button>
  <button id="btnPull" class="icon" title="Pull"><i class="codicon codicon-arrow-down"></i></button>
  <button id="btnPush" class="icon" title="Push"><i class="codicon codicon-arrow-up"></i></button>
  <button id="btnSync" class="icon" title="Sync (pull then push)"><i class="codicon codicon-sync"></i></button>
  <button id="btnSyncMore" class="icon" title="More: fetch, pull, push, sync" aria-haspopup="menu"><i class="codicon codicon-ellipsis"></i></button>
</header>
<div id="syncMenu" class="gl-pop menu sync-menu" role="menu" hidden></div>
<div id="busy" class="busy" hidden></div>

<main id="groups"></main>
<section class="compose">
  <div id="hookOut" class="hook-out" hidden></div>
  <div class="msgwrap">
    <textarea id="msg" rows="1" spellcheck="true" placeholder="Message · Ctrl+Enter to commit"></textarea>
    <button id="btnGen" class="icon gen" title="Generate the commit message from the changes (AI)"><i class="codicon codicon-sparkle"></i></button>
  </div>
  <div class="meta">
    <span id="ticket" class="ticket" hidden></span>
    <span class="grow"></span>
  </div>
  <div class="row-options">
    <label class="switch" title="Amend the last commit (edits its message and adds the staged changes)"><input id="amend" type="checkbox"><span class="track"><span class="knob"></span></span><span>Amend</span></label>
    <label class="switch" id="signBox" hidden title="Sign the commit (git commit -S) with your GPG / SSH key"><input id="sign" type="checkbox"><span class="track"><span class="knob"></span></span><span>Sign</span></label>
    <span id="hooks"></span>
    <span class="grow"></span>
    <span id="counter" class="counter"></span>
  </div>
  <div class="split">
    <button id="btnCommit" class="main" title="Commit (Ctrl+Enter)"><i class="codicon codicon-check"></i><span id="commitLabel">Commit</span></button>
    <button id="btnCommitPush" class="alt" title="Commit, then push (Ctrl+Shift+Enter)"><i id="pushIcon" class="codicon codicon-arrow-up"></i><span id="pushLabel">Push</span></button>
  </div>
</section>
<div id="error" hidden></div>`;
