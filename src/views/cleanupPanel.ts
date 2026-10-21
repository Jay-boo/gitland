import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { errorMessage } from '../util';
import { createPanel, webviewHtml, webviewOptions, pageIcon } from './webviewHtml';
import { capture } from '../devCapture';

type Message = { type: 'ready' | 'prune' } | { type: 'delete'; branches: { name: string; remote: boolean; force: boolean }[] };

const PROTECTED = /^(main|master|dev|develop|development|staging|qa|qual|production|prod|release[/_-].*|releases\/.*|HEAD)$/i;
const STALE_DAYS = 90;

/** Branch cleanup: merged, gone (remote deleted) and stale branches, local and remote, deleted in bulk. */
export class CleanupPanel {
  private static current?: CleanupPanel;

  static show(context: vscode.ExtensionContext, repo: Repo): void {
    if (CleanupPanel.current) {
      CleanupPanel.current.panel.reveal();
      CleanupPanel.current.load();
      return;
    }
    const panel = createPanel('gitland.cleanup', 'Branch cleanup', vscode.ViewColumn.Active, webviewOptions(context.extensionUri));
    panel.iconPath = pageIcon(context.extensionUri, 'cleanup');
    CleanupPanel.current = new CleanupPanel(context, panel, repo);
  }

  private constructor(
    context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    private readonly repo: Repo,
  ) {
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      view: 'cleanup',
      title: 'Branch cleanup',
      body: '<main id="page"></main>',
      script: 'cleanup.js',
      styles: ['list.css', 'ticket.css', 'cleanup.css'],
      bodyClass: 'ticket-page',
      restore: { kind: 'cleanup', repoRoot: repo.root },
    });
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m).catch((e) => vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`)));
    panel.onDidDispose(() => (CleanupPanel.current = undefined));
  }

  private post(m: unknown): void {
    capture('cleanup', 'message', m);
    this.panel.webview.postMessage(m);
  }

  async load(): Promise<void> {
    const repo = this.repo;
    const remote = (await repo.defaultRemote()) ?? 'origin';
    const def = (await repo.defaultBranch(remote)) ?? 'main';
    const base = `${remote}/${def}`;
    const FS = '\x1f';
    const [refs, mergedLocal, mergedRemote, current] = await Promise.all([
      repo.exec([
        'for-each-ref',
        `--format=%(refname)${FS}%(refname:short)${FS}%(upstream:short)${FS}%(upstream:track)${FS}%(committerdate:unix)${FS}%(authorname)`,
        'refs/heads',
        `refs/remotes/${remote}`,
      ]),
      repo.exec(['branch', '--merged', base, '--format=%(refname:short)']).catch(() => ''),
      repo.exec(['branch', '-r', '--merged', base, '--format=%(refname:short)']).catch(() => ''),
      repo.currentBranch(),
    ]);
    const merged = new Set([...mergedLocal.split('\n'), ...mergedRemote.split('\n')].map((s) => s.trim()).filter(Boolean));
    const now = Date.now();
    const branches = refs
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [full, name, upstream, track, date, author] = l.split(FS);
        const isRemote = full.startsWith('refs/remotes/');
        const short = isRemote ? name.slice(remote.length + 1) : name;
        const age = (now - Number(date) * 1000) / 86400e3;
        return {
          name,
          short,
          remote: isRemote,
          upstream: upstream || undefined,
          gone: track.includes('gone'),
          merged: merged.has(name),
          stale: age > STALE_DAYS,
          date: Number(date) * 1000,
          author,
          protected: PROTECTED.test(short) || name === current || short === def || full.endsWith('/HEAD'),
        };
      })
      .filter((b) => !b.protected && (b.merged || b.gone || b.stale));
    this.post({ type: 'branches', branches, base, remote, current, staleDays: STALE_DAYS });
  }

  private async onMessage(m: Message): Promise<void> {
    if (m.type === 'ready') {
      return this.load();
    }
    if (m.type === 'prune') {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Fetching and pruning…' }, () =>
        this.repo.exec(['fetch', '--all', '--prune']),
      );
      return this.load();
    }
    if (m.type !== 'delete') {
      return;
    }
    const local = m.branches.filter((b) => !b.remote);
    const remote = m.branches.filter((b) => b.remote);
    const forced = local.filter((b) => b.force).length;
    const summary = [local.length && `${local.length} local`, remote.length && `${remote.length} remote (deleted on the server for everyone)`].filter(Boolean).join(' and ');
    const ok = await vscode.window.showWarningMessage(
      `Delete ${summary} branch${m.branches.length > 1 ? 'es' : ''}?${forced ? ` ${forced} of them are not merged: their commits will only be recoverable from the reflog.` : ''}`,
      { modal: true },
      'Delete',
    );
    if (ok !== 'Delete') {
      return;
    }
    const failed: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Deleting branches…' }, async () => {
      for (const b of local) {
        await this.repo.exec(['branch', b.force ? '-D' : '-d', b.name]).catch((e) => failed.push(`${b.name}: ${errorMessage(e)}`));
      }
      const byRemote = new Map<string, string[]>();
      for (const b of remote) {
        const [r, ...rest] = b.name.split('/');
        byRemote.set(r, [...(byRemote.get(r) ?? []), rest.join('/')]);
      }
      for (const [r, names] of byRemote) {
        await this.repo.exec(['push', r, '--delete', ...names]).catch((e) => failed.push(`${r}: ${errorMessage(e)}`));
      }
    });
    if (failed.length) {
      vscode.window.showWarningMessage(`Gitland: some branches were not deleted — ${failed.join('; ')}`);
    } else {
      vscode.window.setStatusBarMessage(`Gitland: ${m.branches.length} branch${m.branches.length > 1 ? 'es' : ''} deleted`, 4000);
    }
    await this.load();
  }
}
