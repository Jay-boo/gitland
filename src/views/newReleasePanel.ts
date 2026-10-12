import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { getProvider } from '../providers';
import { generateReleaseNotes } from '../commitMessage';
import { log } from '../log';
import { errorMessage } from '../util';
import { createPanel, webviewHtml, webviewOptions, pageIcon } from './webviewHtml';
import { suggestVersions } from './releasesView';

type Message =
  | { type: 'ready' | 'stopGenerate' }
  | { type: 'generate'; version: string }
  | { type: 'create'; version: string; notes: string; push: boolean; changelog: boolean };

/**
 * "New release" form: the next version (suggested from the commits: feat → minor, breaking → major),
 * release notes (✨ in the CHANGELOG style), then an annotated tag — optionally the CHANGELOG commit
 * first — and push.
 */
export class NewReleasePanel {
  private static current?: NewReleasePanel;
  private generating?: vscode.CancellationTokenSource;

  static show(context: vscode.ExtensionContext, repos: RepoManager, repo: Repo, target?: string): void {
    NewReleasePanel.current?.panel.dispose();
    const panel = createPanel('gitland.newRelease', 'New release', vscode.ViewColumn.Active, {
      ...webviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    });
    panel.iconPath = pageIcon(context.extensionUri, 'release');
    NewReleasePanel.current = new NewReleasePanel(context, repos, panel, repo, target ?? 'HEAD');
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly panel: vscode.WebviewPanel,
    private readonly repo: Repo,
    private readonly target: string,
  ) {
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      title: 'New release',
      body: '<main id="page"></main>',
      script: ['md.js', 'newrelease.js'],
      styles: ['list.css', 'ticket.css', 'newpr.css'],
      bodyClass: 'ticket-page',
      restore: { kind: 'newRelease', repoRoot: repo.root, target },
    });
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m).catch((e) => vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`)));
    panel.onDidDispose(() => {
      this.generating?.cancel();
      if (NewReleasePanel.current === this) {
        NewReleasePanel.current = undefined;
      }
    });
  }

  private post(m: unknown): void {
    this.panel.webview.postMessage(m);
  }

  private async onMessage(m: Message): Promise<void> {
    switch (m.type) {
      case 'ready': {
        const [s, head, branch] = await Promise.all([
          suggestVersions(this.repo),
          this.repo.exec(['log', '-1', '--format=%H%x1f%s', this.target]),
          this.repo.currentBranch(),
        ]);
        const [sha, subject] = head.trim().split('\x1f');
        this.post({ type: 'init', ...s, target: { ref: this.target === 'HEAD' ? branch ?? 'HEAD' : this.target, sha, subject } });
        return;
      }
      case 'generate':
        return this.generate(m.version);
      case 'stopGenerate':
        this.generating?.cancel();
        return;
      case 'create':
        return this.create(m);
    }
  }

  private async generate(version: string): Promise<void> {
    this.generating?.cancel();
    const cts = (this.generating = new vscode.CancellationTokenSource());
    const provider = await getProvider(this.repo, this.context.secrets);
    const latest = (await suggestVersions(this.repo)).latest;
    this.post({ type: 'genStart' });
    try {
      const text = await generateReleaseNotes(
        this.repo,
        { from: latest ?? (await this.repo.exec(['rev-list', '--max-parents=0', 'HEAD'])).trim().split('\n')[0], to: this.target, version, ticketPrefix: provider?.kind === 'github' ? '#' : 'AB#' },
        (t) => this.post({ type: 'genText', text: t }),
        cts.token,
      );
      this.post({ type: 'genDone', text });
    } catch (e) {
      this.post({ type: 'genDone' });
      if (!cts.token.isCancellationRequested) {
        log.error('Release notes generation failed', e);
        vscode.window.showWarningMessage(`Gitland: ${errorMessage(e)}`);
      }
    } finally {
      cts.dispose();
    }
  }

  private async create(m: Extract<Message, { type: 'create' }>): Promise<void> {
    const version = m.version.trim();
    if (!/^[\w.\-/+]+$/.test(version)) {
      throw new Error(`'${version}' is not a valid tag name.`);
    }
    const exists = await this.repo.exec(['rev-parse', '-q', '--verify', `refs/tags/${version}`]).then(() => true, () => false);
    if (exists) {
      throw new Error(`The tag ${version} already exists.`);
    }
    const remote = (await this.repo.defaultRemote()) ?? 'origin';
    this.post({ type: 'creating', on: true });
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Releasing ${version}…` }, async (progress) => {
        let target = this.target;
        if (m.changelog && m.notes.trim()) {
          progress.report({ message: 'updating CHANGELOG.md…' });
          await this.commitChangelog(version, m.notes);
          target = 'HEAD';
        }
        progress.report({ message: 'tagging…' });
        await this.repo.exec(['tag', '-a', version, '-F', '-', target], (m.notes.trim() || `Release ${version}`) + '\n');
        if (m.push) {
          progress.report({ message: `pushing to ${remote}…` });
          if (m.changelog) {
            await this.repo.exec(['push', remote, 'HEAD']);
          }
          await this.repo.exec(['push', remote, `refs/tags/${version}`]);
        }
      });
      vscode.window.showInformationMessage(`Gitland: released ${version}${m.push ? ` (pushed to ${remote})` : ''}.`);
      this.panel.dispose();
      vscode.commands.executeCommand('gitland.releases.refresh');
    } catch (e) {
      this.post({ type: 'creating', on: false });
      throw e;
    }
  }

  /** Adds the notes to CHANGELOG.md above the latest version and commits it ("chore: release X"). */
  private async commitChangelog(version: string, notes: string): Promise<void> {
    const names = await fs.readdir(this.repo.root);
    const name = names.find((n) => /^changelog(\.md)?$/i.test(n)) ?? 'CHANGELOG.md';
    const file = path.join(this.repo.root, name);
    const text = await fs.readFile(file, 'utf8').catch(() => '# Changelog\n\n');
    const lines = text.split('\n');
    let at = lines.findIndex((l) => /^##\s+\[?v?\d+\.\d+/.test(l));
    if (at < 0) {
      at = lines.length;
    }
    lines.splice(at, 0, notes.trim(), '');
    await fs.writeFile(file, lines.join('\n'));
    await this.repo.exec(['add', '--', name]);
    await this.repo.exec(['commit', '-m', `chore: release ${version}`, '--', name]);
  }
}
