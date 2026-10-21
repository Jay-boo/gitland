import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { log } from '../log';
import { errorMessage } from '../util';
import { webviewHtml, webviewOptions, pageIcon } from './webviewHtml';
import { capture } from '../devCapture';

type Action = 'pick' | 'reword' | 'squash' | 'fixup' | 'edit' | 'drop';
type Step = { sha: string; action: Action; message?: string };
type Message = { type: 'ready' } | { type: 'start'; steps: Step[] };

/**
 * Interactive rebase in the Gitland style: reorder the commits after `base`, pick / reword / squash /
 * fixup / edit / drop them, then run it. Conflicts and "edit" stops continue from the Changes view.
 */
export class RebasePanel {
  private static current?: RebasePanel;

  static async show(context: vscode.ExtensionContext, repo: Repo, base?: string): Promise<void> {
    base ??= await pickBase(repo);
    if (!base) {
      return;
    }
    if (await repo.operation()) {
      vscode.window.showWarningMessage('Gitland: finish (or abort) the merge / rebase in progress first — see the Changes view.');
      return;
    }
    RebasePanel.current?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('gitland.rebase', 'Interactive rebase', vscode.ViewColumn.Active, {
      ...webviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    });
    panel.iconPath = pageIcon(context.extensionUri, 'rebase');
    RebasePanel.current = new RebasePanel(context, panel, repo, base);
  }

  private constructor(
    context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    private readonly repo: Repo,
    private readonly base: string,
  ) {
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      view: 'rebase',
      title: 'Interactive rebase',
      body: '<main id="page"></main>',
      script: 'rebase.js',
      styles: ['list.css', 'ticket.css', 'rebase.css'],
      bodyClass: 'ticket-page',
    });
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m).catch((e) => vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`)));
    panel.onDidDispose(() => RebasePanel.current === this && (RebasePanel.current = undefined));
  }

  private post(m: unknown): void {
    capture('rebase', 'message', m);
    this.panel.webview.postMessage(m);
  }

  private async onMessage(m: Message): Promise<void> {
    if (m.type === 'ready') {
      const FS = '\x1f';
      const RS = '\x1e';
      const [log, branch, baseInfo, merges, upstream] = await Promise.all([
        this.repo.exec(['log', '--reverse', '--no-merges', `--format=%H${FS}%h${FS}%an${FS}%at${FS}%B${RS}`, `${this.base}..HEAD`]),
        this.repo.currentBranch(),
        this.repo.exec(['log', '-1', `--format=%h${FS}%s`, this.base]),
        this.repo.exec(['rev-list', '--count', '--merges', `${this.base}..HEAD`]),
        this.repo.exec(['rev-parse', '--abbrev-ref', '@{upstream}']).then((s) => s.trim(), () => ''),
      ]);
      // Commits already on the upstream: rewriting them needs a force push.
      const pushed = upstream ? new Set((await this.repo.exec(['rev-list', `${this.base}..${upstream}`]).catch(() => '')).split('\n').filter(Boolean)) : new Set<string>();
      const commits = log
        .split(RS)
        .map((r) => r.replace(/^\n/, ''))
        .filter(Boolean)
        .map((r) => {
          const [sha, short, author, date, message] = r.split(FS);
          return { sha, short, author, date: Number(date) * 1000, message: (message ?? '').trim(), pushed: pushed.has(sha) };
        });
      const [bShort, bSubject] = baseInfo.trim().split(FS);
      this.post({ type: 'init', commits, branch, base: { short: bShort, subject: bSubject }, merges: Number(merges.trim()) || 0, upstream });
      return;
    }
    await this.start(m.steps);
  }

  private async start(steps: Step[]): Promise<void> {
    if (!steps.length || steps.every((s) => s.action === 'drop')) {
      const ok = await vscode.window.showWarningMessage('All the commits are dropped: the branch will be reset to the base. Continue?', { modal: true }, 'Drop All');
      if (ok !== 'Drop All') {
        return;
      }
    }
    if (steps[0] && (steps[0].action === 'squash' || steps[0].action === 'fixup')) {
      throw new Error('The first commit cannot be squashed or fixed up: there is nothing before it to merge into.');
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitland-rebase-'));
    const lines: string[] = [];
    let i = 0;
    for (const s of steps) {
      if (s.action === 'drop') {
        lines.push(`drop ${s.sha}`);
      } else if (s.action === 'reword' && s.message?.trim()) {
        // Reword without an editor: pick, then amend with the new message.
        const file = path.join(dir, `msg-${i++}.txt`);
        await fs.writeFile(file, s.message.trim() + '\n');
        lines.push(`pick ${s.sha}`, `exec git commit --amend --allow-empty --no-verify -F ${JSON.stringify(file)}`);
      } else {
        lines.push(`${s.action === 'reword' ? 'pick' : s.action} ${s.sha}`);
      }
    }
    const todo = path.join(dir, 'todo');
    await fs.writeFile(todo, lines.join('\n') + '\n');
    const env = {
      // git runs "$GIT_SEQUENCE_EDITOR <todo file>": replace its todo list with ours.
      GIT_SEQUENCE_EDITOR: `cp ${JSON.stringify(todo)}`,
      // Squash: keep the combined message instead of opening an editor.
      GIT_EDITOR: 'true',
    };
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Rebasing…' }, () =>
        this.repo.exec(['rebase', '-i', '--autostash', this.base], undefined, env),
      );
      this.panel.dispose();
      vscode.window.showInformationMessage('Gitland: rebase done.');
    } catch (e) {
      const op = await this.repo.operation().catch(() => undefined);
      if (op?.kind === 'rebase') {
        this.panel.dispose();
        log.info(`Rebase stopped: ${errorMessage(e)}`);
        vscode.window.showWarningMessage('Gitland: the rebase stopped (conflict or "edit" step). Continue it from the Changes view.', 'Open Changes').then((c) => {
          if (c) {
            vscode.commands.executeCommand('gitland.changesView.focus');
          }
        });
        return;
      }
      throw e;
    } finally {
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Where to rebase from: the upstream, or where the branch forked off the default branch. */
async function pickBase(repo: Repo): Promise<string | undefined> {
  const remote = (await repo.defaultRemote()) ?? 'origin';
  const [upstream, def] = await Promise.all([
    repo.exec(['rev-parse', '--abbrev-ref', '@{upstream}']).then((s) => s.trim(), () => ''),
    repo.defaultBranch(remote),
  ]);
  const fork = def ? (await repo.exec(['merge-base', 'HEAD', `${remote}/${def}`]).catch(() => '')).trim() : '';
  const items: (vscode.QuickPickItem & { base: string })[] = [];
  if (fork) {
    items.push({ label: `$(git-merge) Since ${def}`, description: `the commits of this branch (fork point ${fork.slice(0, 7)})`, base: fork });
  }
  if (upstream) {
    items.push({ label: `$(cloud) Not pushed yet`, description: `commits after ${upstream}`, base: upstream });
  }
  for (const n of [5, 10, 20]) {
    items.push({ label: `$(history) Last ${n} commits`, base: `HEAD~${n}` });
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Interactive rebase — which commits?' });
  return pick?.base;
}
