import * as vscode from 'vscode';
import { compareVersions, Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { AvatarService } from '../avatars';
import { log } from '../log';
import { errorMessage } from '../util';
import { webviewHtml, webviewOptions } from './webviewHtml';
import { ComparePanel } from './comparePanel';
import { LIST_BODY } from './ticketsView';
import { capture } from '../devCapture';

type Message =
  | { type: 'ready' | 'refresh' | 'newRelease' | 'compareUnreleased' }
  | { type: 'compare' | 'notes' | 'checkout' | 'copy' | 'delete'; tag: string };

/** "Releases": the tags, newest version first, with what each one added. Click one to open its release page. */
export class ReleasesView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'gitland.releases';
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly avatars: AvatarService,
  ) {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(ReleasesView.viewId, this),
      repos.onDidChangeRepo(() => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.view?.visible && this.refresh(), 800);
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.context.extensionUri);
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri, {
      view: 'releases',
      title: 'Releases',
      body: LIST_BODY('Filter releases'),
      script: 'releases.js',
      styles: ['list.css'],
      bodyClass: 'list',
    });
    view.webview.onDidReceiveMessage((m: Message) => this.onMessage(m), undefined, this.disposables);
    view.onDidChangeVisibility(() => view.visible && this.refresh(), undefined, this.disposables);
  }

  refresh(): void {
    this.load().catch((e) => log.error('Releases: refresh failed', e));
  }

  private post(m: unknown): void {
    capture('releases', 'message', m);
    this.view?.webview.postMessage(m);
  }

  private async repo(): Promise<Repo | undefined> {
    return this.repos.activeRepo(false);
  }

  private async load(): Promise<void> {
    const repo = await this.repo();
    if (!repo) {
      return this.post({ type: 'state', state: 'empty', title: 'No git repository', text: '' });
    }
    this.post({ type: 'loading' });
    try {
      const [releases, branch] = await Promise.all([repo.releases(), repo.currentBranch()]);
      // Not released yet: commits of the current branch since the latest tag it contains.
      const latest = await repo.exec(['describe', '--tags', '--abbrev=0', 'HEAD']).then((s) => s.trim(), () => undefined);
      const unreleased = latest ? Number((await repo.exec(['rev-list', '--count', '--no-merges', `${latest}..HEAD`]).catch(() => '0')).trim()) : undefined;
      if (this.view) {
        this.view.description = releases.length ? releases[0].name : undefined;
      }
      this.post({ type: 'releases', releases, branch, latest, unreleased });
    } catch (e) {
      log.error('Releases failed to load', e);
      this.post({ type: 'state', state: 'error', title: 'Could not list the releases', text: errorMessage(e) });
    }
  }

  private async onMessage(m: Message): Promise<void> {
    const repo = await this.repo();
    if (!repo) {
      return;
    }
    try {
      switch (m.type) {
        case 'ready':
        case 'refresh':
          return this.refresh();
        case 'newRelease':
          await vscode.commands.executeCommand('gitland.releases.create');
          return;
        case 'compareUnreleased': {
          const latest = (await repo.exec(['describe', '--tags', '--abbrev=0', 'HEAD'])).trim();
          await ComparePanel.show(this.context, this.repos, this.avatars, repo, latest, (await repo.currentBranch()) ?? 'HEAD');
          return;
        }
        case 'compare':
          await vscode.commands.executeCommand('gitland.releases.show', m.tag, repo.root);
          return;
        case 'notes': {
          const previous = await repo.previousTag(m.tag);
          if (!previous) {
            vscode.window.showInformationMessage(`Gitland: ${m.tag} is the first release.`);
            return;
          }
          await ComparePanel.show(this.context, this.repos, this.avatars, repo, previous, m.tag, true, { title: `Release ${m.tag}`, release: m.tag });
          return;
        }
        case 'checkout':
          if ((await vscode.window.showWarningMessage(`Checkout ${m.tag}? You will be in 'detached HEAD' state.`, { modal: true }, 'Checkout')) === 'Checkout') {
            await repo.checkout(m.tag);
          }
          return;
        case 'copy':
          await vscode.env.clipboard.writeText(m.tag);
          vscode.window.setStatusBarMessage(`Gitland: ${m.tag} copied`, 2000);
          return;
        case 'delete': {
          const local = 'Delete Locally';
          const both = 'Delete Locally and on the Remote';
          const choice = await vscode.window.showWarningMessage(`Delete the tag ${m.tag}?`, { modal: true }, local, both);
          if (!choice) {
            return;
          }
          await repo.exec(['tag', '-d', m.tag]);
          if (choice === both) {
            await repo.exec(['push', (await repo.defaultRemote()) ?? 'origin', '--delete', `refs/tags/${m.tag}`]);
          }
          return this.refresh();
        }
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Next versions after the latest tag, from the commits since it (feat → minor, breaking → major). */
export async function suggestVersions(repo: Repo): Promise<{
  latest?: string;
  bump: 'major' | 'minor' | 'patch';
  options: { version: string; kind: string }[];
  commits: string[];
  /** The same commits with their sha and author date (ms), for the list in the New release form. */
  log: { sha: string; date: number; subject: string }[];
}> {
  const latest = (await repo.releases(200).catch(() => [])).map((r) => r.name).filter((n) => /^v?\d+\.\d+/.test(n)).sort((a, b) => compareVersions(b, a))[0];
  const entries = (await repo.exec(['log', '--no-merges', '--format=%H%x1f%at%x1f%s%n%b%x00', latest ? `${latest}..HEAD` : 'HEAD']).catch(() => ''))
    .split('\0')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha, at, message] = c.split('\x1f');
      return { sha, date: Number(at) * 1000, message: message ?? '' };
    });
  const commits = entries.map((e) => e.message);
  const breaking = commits.some((c) => /^\w+(\([^)]*\))?!:|BREAKING[ -]CHANGE/m.test(c));
  const feat = commits.some((c) => /^feat(\([^)]*\))?:/i.test(c));
  const bump = breaking ? 'major' : feat ? 'minor' : 'patch';
  const m = latest ? /^(v?)(\d+)\.(\d+)(?:\.(\d+))?/.exec(latest) : undefined;
  const [prefix, major, minor, patch] = m ? [m[1], Number(m[2]), Number(m[3]), Number(m[4] ?? 0)] : ['', 0, 0, 0];
  const isPre = !!latest && /-/.test(latest);
  const options = [
    // After "3.5.1-rc1", the release itself is "3.5.1".
    ...(isPre ? [{ version: `${prefix}${major}.${minor}.${patch}`, kind: 'release' }] : []),
    { version: `${prefix}${major}.${minor}.${patch + (isPre ? 0 : 1)}`, kind: 'patch' },
    { version: `${prefix}${major}.${minor + 1}.0`, kind: 'minor' },
    { version: `${prefix}${major + 1}.0.0`, kind: 'major' },
  ].filter((o, i, all) => all.findIndex((x) => x.version === o.version) === i);
  return { latest, bump, options, commits: commits.map((c) => c.split('\n')[0]), log: entries.map((e) => ({ sha: e.sha, date: e.date, subject: e.message.split('\n')[0] })) };
}
