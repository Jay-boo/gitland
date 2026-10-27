import * as path from 'path';
import * as vscode from 'vscode';
import { Repo, TimelineEntry } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { AvatarService } from '../avatars';
import { getProvider } from '../providers';
import { Provider } from '../providers/types';
import { explainHistory, ExplainInput } from '../commitMessage';
import { findLinks } from '../links';
import { log } from '../log';
import { errorMessage } from '../util';
import { createPanel, webviewHtml, webviewOptions, pageIcon } from './webviewHtml';
import { capture } from '../devCapture';
import { ticketPrefix } from '../providers/ticketPrefix.pure';

type Message =
  | { type: 'ready' | 'explain' | 'stopExplain' }
  | { type: 'patch'; sha: string; path: string }
  | { type: 'diffPrevious' | 'diffWorking' | 'openAt' | 'showCommit'; sha: string; path: string }
  | { type: 'compare'; a: { sha: string; path: string }; b: { sha: string; path: string } }
  | { type: 'openUrl'; url: string };

/**
 * History of a file or of a few lines, in an editor tab: every commit that touched it with its diff,
 * compare any two versions, and ✨ explain why the code is the way it is.
 */
export class HistoryPanel {
  private generating?: vscode.CancellationTokenSource;
  private entries: TimelineEntry[] = [];

  static async show(
    context: vscode.ExtensionContext,
    repos: RepoManager,
    avatars: AvatarService,
    repo: Repo,
    rel: string,
    range?: { start: number; end: number },
    autoExplain = false,
  ): Promise<void> {
    const title = `${path.basename(rel)}${range ? `:${range.start}${range.end !== range.start ? `-${range.end}` : ''}` : ''}`;
    const panel = createPanel('gitland.history', `History · ${title}`, vscode.ViewColumn.Active, {
      ...webviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    });
    panel.iconPath = pageIcon(context.extensionUri, 'history');
    new HistoryPanel(context, repos, avatars, panel, repo, rel, range, autoExplain);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly avatars: AvatarService,
    private readonly panel: vscode.WebviewPanel,
    private readonly repo: Repo,
    private readonly rel: string,
    private readonly range: { start: number; end: number } | undefined,
    private autoExplain: boolean,
  ) {
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      view: 'history',
      title: 'History',
      body: '<main id="page"></main>',
      script: ['md.js', 'history.js'],
      styles: ['list.css', 'ticket.css', 'history.css'],
      bodyClass: 'ticket-page',
      restore: { kind: 'history', repoRoot: repo.root, rel, range },
    });
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m).catch((e) => vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`)));
    panel.onDidDispose(() => this.generating?.cancel());
  }

  private post(m: unknown): void {
    capture('history', 'message', m);
    this.panel.webview.postMessage(m);
  }

  private uri(sha: string, rel: string): vscode.Uri {
    return this.repos.toGitUri(vscode.Uri.file(path.join(this.repo.root, rel)), sha);
  }

  private async onMessage(m: Message): Promise<void> {
    switch (m.type) {
      case 'ready': {
        this.entries = await this.repo.timeline(this.rel, this.range);
        const avatars: Record<string, string> = {};
        for (const e of this.entries) {
          avatars[e.email.toLowerCase()] ??= this.avatars.urlFor(e.email);
        }
        const provider = await getProvider(this.repo, this.context.secrets);
        this.post({
          type: 'init',
          rel: this.rel,
          range: this.range,
          entries: this.entries,
          avatars,
          links: provider && { kind: provider.kind, pr: provider.pullRequestUrl('{id}'), ticket: provider.ticketUrl('{id}'), ticketKeys: provider.ticketKeys },
          autoExplain: this.autoExplain,
        });
        this.autoExplain = false;
        return;
      }
      case 'patch':
        this.post({ type: 'patch', sha: m.sha, patch: await this.repo.filePatch(m.sha, m.path) });
        return;
      case 'diffPrevious': {
        const i = this.entries.findIndex((e) => e.sha === m.sha);
        const older = this.entries[i + 1];
        const left = older ? this.uri(older.sha, older.path) : this.uri(`${m.sha}^`, m.path);
        await vscode.commands.executeCommand('vscode.diff', left, this.uri(m.sha, m.path), `${path.basename(m.path)} (${m.sha.slice(0, 7)}^ ↔ ${m.sha.slice(0, 7)})`);
        return;
      }
      case 'diffWorking':
        await vscode.commands.executeCommand(
          'vscode.diff',
          this.uri(m.sha, m.path),
          vscode.Uri.file(path.join(this.repo.root, this.rel)),
          `${path.basename(this.rel)} (${m.sha.slice(0, 7)} ↔ working tree)`,
        );
        return;
      case 'openAt':
        await vscode.commands.executeCommand('vscode.open', this.uri(m.sha, m.path));
        return;
      case 'showCommit':
        await vscode.commands.executeCommand('gitland.showGraph', { repoRoot: this.repo.root, sha: m.sha });
        return;
      case 'compare': {
        // Older on the left.
        const [a, b] = this.entries.findIndex((e) => e.sha === m.a.sha) > this.entries.findIndex((e) => e.sha === m.b.sha) ? [m.a, m.b] : [m.b, m.a];
        await vscode.commands.executeCommand('vscode.diff', this.uri(a.sha, a.path), this.uri(b.sha, b.path), `${path.basename(this.rel)} (${a.sha.slice(0, 7)} ↔ ${b.sha.slice(0, 7)})`);
        return;
      }
      case 'openUrl':
        await vscode.commands.executeCommand('gitland.openLink', m.url);
        return;
      case 'explain':
        return this.explain();
      case 'stopExplain':
        this.generating?.cancel();
        return;
    }
  }

  private async explain(): Promise<void> {
    this.generating?.cancel();
    const cts = (this.generating = new vscode.CancellationTokenSource());
    this.post({ type: 'explainStart' });
    try {
      const provider = await getProvider(this.repo, this.context.secrets);
      let code: string | undefined;
      if (this.range) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(this.repo.root, this.rel)));
        code = doc.getText(new vscode.Range(this.range.start - 1, 0, this.range.end, 0));
      }
      const patches = this.range
        ? this.entries.map((e) => `### ${e.sha.slice(0, 7)} ${e.subject}\n${e.patch ?? ''}`).join('\n\n')
        : undefined;
      const input: ExplainInput = {
        kind: this.range ? 'lines' : 'file',
        subject: this.range ? `${this.rel}:${this.range.start}-${this.range.end}` : this.rel,
        commits: this.entries,
        patches,
        code,
        context: await mentionedContext(provider, this.entries.map((e) => `${e.subject}\n${e.body}`)),
      };
      const text = await explainHistory(input, (t) => this.post({ type: 'explainText', text: t }), cts.token);
      this.post({ type: 'explainDone', text });
    } catch (e) {
      this.post({ type: 'explainDone' });
      if (!cts.token.isCancellationRequested) {
        log.error('Explain failed', e);
        vscode.window.showWarningMessage(`Gitland: ${errorMessage(e)}`);
      }
    } finally {
      cts.dispose();
    }
  }
}

/** "AB#1234 — title" for the tickets mentioned (a few, looked up in parallel). */
export async function mentionedContext(provider: Provider | undefined, texts: string[]): Promise<string[]> {
  // Never prompt to sign in just for context.
  if (!provider || !(await provider.isSignedIn().catch(() => false))) {
    return [];
  }
  const links = findLinks(texts.join('\n'), provider);
  const prs = links.filter((l) => l.kind === 'pr').slice(0, 20).map((l) => `PR ${l.id}`);
  const ids = [...new Set(links.filter((l) => l.kind === 'ticket').map((l) => l.id))].slice(0, 8);
  const tickets = await Promise.all(ids.map((id) => provider.getTicket(id).catch(() => undefined)));
  return [
    ...tickets.filter((t): t is NonNullable<typeof t> => !!t).map((t) => `${ticketPrefix(provider)}${t.id} (${t.type}, ${t.state}): ${t.title}`),
    ...prs,
  ];
}
