import * as path from 'path';
import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { AvatarService } from '../avatars';
import { getProvider } from '../providers';
import { log } from '../log';
import { errorMessage } from '../util';
import { createPanel, webviewHtml, webviewOptions, pageIcon } from './webviewHtml';
import { generateReleaseNotes, insertIntoChangelog } from '../commitMessage';
import { capture } from '../devCapture';

type Message =
  | { type: 'ready' | 'swap' | 'refresh' }
  | { type: 'pick'; side: 'from' | 'to' }
  | { type: 'openDiff'; path: string; oldPath?: string; status: string }
  | { type: 'openAll' }
  | { type: 'preview'; key: string; path: string; oldPath?: string }
  | { type: 'viewed'; paths: string[]; on: boolean }
  | { type: 'showCommit'; sha: string }
  | { type: 'openUrl' | 'openExternal'; url: string }
  | { type: 'copy'; text: string }
  | { type: 'notes' | 'stopNotes' }
  | { type: 'insertChangelog'; text: string };

/** How the page opens: on which tab, and the key under which "viewed" files are remembered (e.g. a PR). */
export interface CompareView {
  tab?: 'commits' | 'files';
  key?: string;
  title?: string;
  /** Shown as the page of this release (tag): "Open on remote" goes to the release on the web. */
  release?: string;
}

const VIEWED = 'gitland.compare.viewed';

/**
 * Compare two refs (tags, branches, commits) in an editor tab: the commits on each side, the files
 * changed with their diffs, and where they diverged — e.g. the release notes between two tags.
 */
export class ComparePanel {
  private static current?: ComparePanel;

  static async show(
    context: vscode.ExtensionContext,
    repos: RepoManager,
    avatars: AvatarService,
    repo: Repo,
    from?: string,
    to?: string,
    notes = false,
    view: CompareView = {},
  ): Promise<void> {
    if (!from || !to) {
      const picked = await pickPair(repo, from, to);
      if (!picked) {
        return;
      }
      [from, to] = picked;
    }
    if (ComparePanel.current) {
      ComparePanel.current.autoNotes = notes;
      ComparePanel.current.view = view;
      ComparePanel.current.set(repo, from, to);
      ComparePanel.current.panel.reveal();
      return;
    }
    const panel = createPanel('gitland.compare', 'Compare', vscode.ViewColumn.Active, {
      ...webviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    });
    panel.iconPath = pageIcon(context.extensionUri, 'compare');
    ComparePanel.current = new ComparePanel(context, repos, avatars, panel, repo, from, to);
    ComparePanel.current.autoNotes = notes;
    ComparePanel.current.view = view;
  }

  private view: CompareView = {};
  private files: { path: string; oldPath?: string; status: string }[] = [];

  private get viewedKey(): string {
    return this.view.key ?? `${this.from}..${this.to}`;
  }

  private viewed(): string[] {
    return this.context.workspaceState.get<Record<string, string[]>>(VIEWED, {})[this.viewedKey] ?? [];
  }

  /** Generate the release notes as soon as the comparison is shown. */
  private autoNotes = false;
  private generating?: vscode.CancellationTokenSource;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly avatars: AvatarService,
    private readonly panel: vscode.WebviewPanel,
    private repo: Repo,
    private from: string,
    private to: string,
  ) {
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      view: 'compare',
      title: 'Compare',
      body: '<main id="page"></main>',
      script: ['diffpreview.js', 'compare.js'],
      styles: ['list.css', 'compare.css'],
      bodyClass: 'compare-page',
      restore: { kind: 'compare', repoRoot: repo.root, from, to },
    });
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m));
    panel.onDidDispose(() => (ComparePanel.current = undefined));
  }

  private set(repo: Repo, from: string, to: string): void {
    this.repo = repo;
    this.from = from;
    this.to = to;
    this.load();
  }

  private post(m: unknown): void {
    capture('compare', 'message', m);
    this.panel.webview.postMessage(m);
  }

  private async load(): Promise<void> {
    this.panel.title = this.view.title ?? `${this.from} ↔ ${this.to}`;
    this.post({ type: '__restore', restore: { kind: 'compare', repoRoot: this.repo.root, from: this.from, to: this.to, view: this.view } });
    this.post({ type: 'loading', from: this.from, to: this.to });
    try {
      const [c, provider] = await Promise.all([this.repo.compare(this.from, this.to), getProvider(this.repo, this.context.secrets)]);
      this.files = c.files;
      const avatars: Record<string, string> = {};
      for (const x of [...c.ahead, ...c.behind]) {
        const e = x.email.toLowerCase();
        if (e && !avatars[e]) {
          avatars[e] = this.avatars.urlFor(e);
        }
      }
      this.post({
        type: 'compare',
        autoNotes: this.autoNotes,
        tab: this.view.tab,
        viewed: this.viewed(),
        ...c,
        avatars,
        links: provider && { kind: provider.kind, pr: provider.pullRequestUrl('{id}'), ticket: provider.ticketUrl('{id}'), ticketKeys: provider.ticketKeys },
        release: this.view.release && this.view.release === this.to ? { tag: this.to, url: provider?.releaseUrl(this.to) } : undefined,
      });
    } catch (e) {
      log.error(`Compare ${this.from}..${this.to} failed`, e);
      this.post({ type: 'error', message: errorMessage(e) });
    }
  }

  private async onMessage(m: Message): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
        case 'refresh':
          return this.load();
        case 'swap':
          [this.from, this.to] = [this.to, this.from];
          return this.load();
        case 'pick': {
          const ref = await pickRef(this.repo, m.side === 'from' ? `Compare from… (now ${this.from})` : `Compare to… (now ${this.to})`);
          if (ref) {
            this[m.side] = ref;
            await this.load();
          }
          return;
        }
        case 'openDiff': {
          // Beside the list, which stays in view: next file is one click (or ↓) away.
          const uri = vscode.Uri.file(path.join(this.repo.root, m.path));
          const oldUri = vscode.Uri.file(path.join(this.repo.root, m.oldPath ?? m.path));
          const title = `${path.basename(m.path)} (${this.from} ↔ ${this.to})`;
          const options: vscode.TextDocumentShowOptions = { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true };
          if (m.status === 'A') {
            await vscode.commands.executeCommand('vscode.open', this.repos.toGitUri(uri, this.to), options);
          } else if (m.status === 'D') {
            await vscode.commands.executeCommand('vscode.open', this.repos.toGitUri(oldUri, this.from), options);
          } else {
            await vscode.commands.executeCommand('vscode.diff', this.repos.toGitUri(oldUri, this.from), this.repos.toGitUri(uri, this.to), title, options);
          }
          return;
        }
        case 'preview':
          this.post({ type: 'preview', key: m.key, ...(await this.repo.diffPreview(['diff', this.from, this.to, '--', ...(m.oldPath ? [m.oldPath] : []), m.path], undefined, {
              path: m.path,
              before: { rev: this.from, path: m.oldPath ?? m.path },
              after: { rev: this.to, path: m.path },
            })) });
          return;
        case 'openAll': {
          // VS Code's multi-file diff editor: every change in one scrollable tab (GitLens "Open All Changes").
          const resources = this.files.map((f) => {
            const uri = vscode.Uri.file(path.join(this.repo.root, f.path));
            const oldUri = vscode.Uri.file(path.join(this.repo.root, f.oldPath ?? f.path));
            return [uri, f.status === 'A' ? undefined : this.repos.toGitUri(oldUri, this.from), f.status === 'D' ? undefined : this.repos.toGitUri(uri, this.to)];
          });
          await vscode.commands.executeCommand('vscode.changes', this.view.title ?? `${this.from} ↔ ${this.to}`, resources);
          return;
        }
        case 'viewed': {
          const all = this.context.workspaceState.get<Record<string, string[]>>(VIEWED, {});
          const set = new Set(all[this.viewedKey] ?? []);
          m.paths.forEach((p) => (m.on ? set.add(p) : set.delete(p)));
          await this.context.workspaceState.update(VIEWED, { ...all, [this.viewedKey]: [...set] });
          return;
        }
        case 'showCommit':
          await vscode.commands.executeCommand('gitland.showGraph', { repoRoot: this.repo.root, sha: m.sha });
          return;
        case 'openUrl':
          await vscode.commands.executeCommand('gitland.openLink', m.url, this.repo.root);
          return;
        case 'openExternal':
          if (/^https:\/\//.test(m.url)) {
            await vscode.env.openExternal(vscode.Uri.parse(m.url));
          }
          return;
        case 'notes':
          return this.notes();
        case 'stopNotes':
          this.generating?.cancel();
          return;
        case 'insertChangelog':
          await insertIntoChangelog(this.repo, m.text);
          return;
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          vscode.window.setStatusBarMessage('Gitland: release notes copied', 3000);
          return;
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`);
    }
  }

  /** ✨ Release notes of `to` since `from`, streamed into the page. */
  private async notes(): Promise<void> {
    this.autoNotes = false;
    this.generating?.cancel();
    const cts = (this.generating = new vscode.CancellationTokenSource());
    const provider = await getProvider(this.repo, this.context.secrets);
    this.post({ type: 'notesStart' });
    try {
      const text = await generateReleaseNotes(
        this.repo,
        { from: this.from, to: this.to, version: /^v?\d/.test(this.to) ? this.to : 'Unreleased', ticketPrefix: provider?.kind === 'github' || provider?.kind === 'gitlab' ? '#' : 'AB#' },
        (t) => this.post({ type: 'notesText', text: t }),
        cts.token,
      );
      this.post({ type: 'notesDone', text });
    } catch (e) {
      this.post({ type: 'notesDone' });
      if (!cts.token.isCancellationRequested) {
        vscode.window.showWarningMessage(`Gitland: ${errorMessage(e)}`);
      }
    } finally {
      cts.dispose();
    }
  }
}

type RefItem = vscode.QuickPickItem & { ref?: string };

/** Quick pick of tags (newest first), branches and remote branches. */
export async function pickRef(repo: Repo, placeHolder: string): Promise<string | undefined> {
  const refs = await repo.allRefs();
  const group = (type: string, label: string, icon: string): RefItem[] => {
    const list = refs.filter((r) => r.type === type);
    return list.length
      ? [
          { label, kind: vscode.QuickPickItemKind.Separator },
          ...list.map((r) => ({ label: `$(${icon}) ${r.name}`, description: `${r.current ? '● current · ' : ''}${new Date(r.date).toLocaleDateString()}`, ref: r.name })),
        ]
      : [];
  };
  const items: RefItem[] = [...group('tag', 'Tags', 'tag'), ...group('branch', 'Branches', 'git-branch'), ...group('remote', 'Remote branches', 'cloud')];
  const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
  return pick?.ref;
}

/** Two refs to compare: a tag and the tag before it by default. */
async function pickPair(repo: Repo, from?: string, to?: string): Promise<[string, string] | undefined> {
  to ??= await pickRef(repo, 'Compare… pick the newer ref (tag, branch)');
  if (!to) {
    return undefined;
  }
  if (!from) {
    const previous = await repo.previousTag(to).catch(() => undefined);
    const branch = await repo.currentBranch();
    const quick: RefItem[] = [
      ...(previous ? [{ label: `$(tag) ${previous}`, description: 'the previous tag', ref: previous }] : []),
      ...(branch && branch !== to ? [{ label: `$(git-branch) ${branch}`, description: 'your current branch', ref: branch }] : []),
      { label: '$(list-selection) Pick another ref…', ref: '' },
    ];
    const choice = await vscode.window.showQuickPick(quick, { placeHolder: `Compare ${to} with…` });
    if (!choice) {
      return undefined;
    }
    from = choice.ref || (await pickRef(repo, `Compare ${to} with…`));
  }
  return from ? [from, to] : undefined;
}
