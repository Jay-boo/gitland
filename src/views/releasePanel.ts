import * as vscode from 'vscode';
import { compareVersions, Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { AvatarService } from '../avatars';
import { getProvider } from '../providers';
import { findLinks } from '../links';
import { log } from '../log';
import { errorMessage } from '../util';
import { createPanel, webviewHtml, webviewOptions, pageIcon } from './webviewHtml';
import { ComparePanel } from './comparePanel';
import { readChangelog } from '../commitMessage';
import { changelogSection } from '../changelogSection.pure';
import { capture } from '../devCapture';

type Message =
  | { type: 'ready' | 'refresh' | 'compare' | 'notes' | 'openRemote' | 'copy' | 'checkout' }
  | { type: 'showCommit'; sha: string }
  | { type: 'showRelease'; tag: string }
  | { type: 'openUrl'; url: string };

const FS = '\x1f';

/**
 * A release (tag) in an editor tab, like a release page on the web: its notes (the CHANGELOG
 * section, else the tag message), the pull requests and commits it added since the previous
 * release, who contributed, and the neighbouring releases.
 */
export class ReleasePanel {
  private static readonly panels = new Map<string, ReleasePanel>();

  static show(context: vscode.ExtensionContext, repos: RepoManager, avatars: AvatarService, repo: Repo, tag: string): void {
    const key = `${repo.root}\n${tag}`;
    const open = ReleasePanel.panels.get(key);
    if (open) {
      open.panel.reveal();
      open.load();
      return;
    }
    const panel = createPanel('gitland.release', `Release ${tag}`, vscode.ViewColumn.Active, {
      ...webviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    });
    panel.iconPath = pageIcon(context.extensionUri, 'release');
    ReleasePanel.panels.set(key, new ReleasePanel(context, repos, avatars, panel, repo, tag, key));
  }

  private previous?: string;
  private remoteUrl?: string;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly avatars: AvatarService,
    private readonly panel: vscode.WebviewPanel,
    private readonly repo: Repo,
    private readonly tag: string,
    key: string,
  ) {
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      view: 'release',
      title: `Release ${tag}`,
      body: '<main id="page"></main>',
      script: ['md.js', 'release.js'],
      styles: ['list.css', 'ticket.css', 'release.css'],
      bodyClass: 'ticket-page',
      restore: { kind: 'release', repoRoot: repo.root, tag },
    });
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m));
    panel.onDidDispose(() => ReleasePanel.panels.delete(key));
  }

  private post(m: unknown): void {
    capture('release', 'message', m);
    this.panel.webview.postMessage(m);
  }

  private async load(): Promise<void> {
    const repo = this.repo;
    const tag = this.tag;
    this.post({ type: 'loading' });
    try {
      const [info, names, previous, provider] = await Promise.all([
        repo.exec([
          'for-each-ref',
          `--format=%(objecttype)${FS}%(objectname)${FS}%(*objectname)${FS}%(creatordate:unix)${FS}%(taggername)%(if)%(taggername)%(then)%(else)%(authorname)%(end)${FS}%(contents)`,
          `refs/tags/${tag}`,
        ]),
        repo.exec(['tag', '--list']).then((s) => s.split('\n').filter(Boolean)),
        repo.previousTag(tag),
        getProvider(repo, this.context.secrets).catch(() => undefined),
      ]);
      if (!info.trim()) {
        return this.post({ type: 'error', message: `${tag} is not a tag of this repository.` });
      }
      const [type, obj, peeled, date, tagger, ...rest] = info.replace(/\n$/, '').split(FS);
      const annotated = type === 'tag';
      const sha = peeled || obj;
      const message = annotated ? rest.join(FS).replace(/-----BEGIN PGP SIGNATURE-----[\s\S]*$/, '').trim() : '';
      // The release after this one: the next version up among the tags.
      const sorted = names.sort((a, b) => compareVersions(a, b));
      const next = sorted[sorted.indexOf(tag) + 1];
      // Without a previous release, everything up to the tag.
      const base = previous ?? (await repo.exec(['rev-list', '--max-parents=0', tag]).then((s) => s.trim().split('\n').pop(), () => undefined));
      const cmp = base ? await repo.compare(base, tag) : undefined;
      const all = cmp ? cmp.ahead : [];
      if (!previous && base) {
        // compare(root, tag) leaves the root commit itself out.
        const root = await repo.exec(['log', '-1', `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%s`, base]).catch(() => '');
        const [rsha, , author, email, at, subject] = root.trim().split(FS);
        if (rsha) {
          all.push({ sha: rsha, parents: [], author, email, date: Number(at) * 1000, subject: subject ?? '' } as (typeof all)[number]);
        }
      }
      const commits = all.filter((c) => c.parents.length < 2);
      const prs: { id: string; title: string; url: string; sha: string }[] = [];
      for (const c of all) {
        const link = findLinks(c.subject, provider).find((l) => l.kind === 'pr');
        if (link && !prs.some((p) => p.id === link.id)) {
          const title = c.subject.replace(/^Merged PR \d+:\s*/i, '').replace(/^Merge pull request #?\d+ from \S+\s*/i, '').replace(/\s*\(#\d+\)$/, '');
          prs.push({ id: link.id, title, url: link.url, sha: c.sha });
        }
      }
      const people = new Map<string, { name: string; email: string; count: number }>();
      for (const c of commits) {
        const k = c.email.toLowerCase();
        const p = people.get(k) ?? { name: c.author, email: c.email, count: 0 };
        p.count++;
        people.set(k, p);
      }
      const contributors = [...people.values()].sort((a, b) => b.count - a.count).map((p) => ({ ...p, avatar: this.avatars.urlFor(p.email.toLowerCase()) }));
      const changelog = await readChangelog(repo, tag).catch(() => undefined);
      const section = changelog && changelogSection(changelog.text, tag);
      const files = cmp?.files ?? [];
      this.previous = previous;
      this.remoteUrl = provider?.releaseUrl(tag);
      this.panel.title = `Release ${tag}`;
      this.post({
        type: 'release',
        tag,
        sha,
        short: sha.slice(0, 7),
        date: Number(date) * 1000,
        tagger,
        annotated,
        message,
        notes: section ? { source: changelog!.path, text: section } : undefined,
        previous,
        next,
        commits: commits.map((c) => ({ sha: c.sha, short: c.sha.slice(0, 7), author: c.author, email: c.email, date: c.date, subject: c.subject })),
        prs,
        contributors,
        files: { count: files.length, added: files.reduce((n, f) => n + (f.added ?? 0), 0), deleted: files.reduce((n, f) => n + (f.deleted ?? 0), 0) },
        remote: !!this.remoteUrl,
        remoteName: provider?.kind === 'github' ? 'GitHub' : provider ? 'Azure DevOps' : undefined,
        links: provider && { kind: provider.kind, pr: provider.pullRequestUrl('{id}'), ticket: provider.ticketUrl('{id}') },
      });
    } catch (e) {
      log.error(`Release ${tag} failed to load`, e);
      this.post({ type: 'error', message: errorMessage(e) });
    }
  }

  private async onMessage(m: Message): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
        case 'refresh':
          return this.load();
        case 'compare':
        case 'notes': {
          const from = this.previous ?? (await this.repo.exec(['rev-list', '--max-parents=0', this.tag])).trim().split('\n').pop();
          await ComparePanel.show(this.context, this.repos, this.avatars, this.repo, from, this.tag, m.type === 'notes', { title: `${from} ↔ ${this.tag}`, release: this.tag });
          return;
        }
        case 'openRemote':
          if (this.remoteUrl) {
            await vscode.env.openExternal(vscode.Uri.parse(this.remoteUrl));
          }
          return;
        case 'copy':
          await vscode.env.clipboard.writeText(this.tag);
          vscode.window.setStatusBarMessage(`Gitland: ${this.tag} copied`, 2000);
          return;
        case 'checkout':
          if ((await vscode.window.showWarningMessage(`Checkout ${this.tag}? You will be in 'detached HEAD' state.`, { modal: true }, 'Checkout')) === 'Checkout') {
            await this.repo.checkout(this.tag);
          }
          return;
        case 'showCommit':
          await vscode.commands.executeCommand('gitland.showGraph', { repoRoot: this.repo.root, sha: m.sha });
          return;
        case 'showRelease':
          ReleasePanel.show(this.context, this.repos, this.avatars, this.repo, m.tag);
          return;
        case 'openUrl':
          await vscode.commands.executeCommand('gitland.openLink', m.url, this.repo.root);
          return;
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`);
    }
  }
}
