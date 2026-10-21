import * as vscode from 'vscode';
import { BlameCommit, Repo, UNCOMMITTED_SHA } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { AvatarService } from '../avatars';
import { getProvider } from '../providers';
import { findLinks, MessageLink } from '../links';
import { authorColor } from '../avatarArt';
import { commandUri, config, formatDate, timeAgo, truncate } from '../util';

export interface BlameResult {
  repo: Repo;
  lines: BlameCommit[];
  me?: string;
}

interface BlameEntry {
  version: number;
  promise: Promise<BlameResult | undefined>;
}

const MAX_LINES = 30000;
/** Commits whose full message / stats are fetched for the file blame hovers. */
const MAX_ENRICHED = 150;

/** What the hover shows beyond the blame line: full message, stats, PR / work item links. */
interface CommitExtra {
  message: string;
  files: number;
  added: number;
  deleted: number;
  links: MessageLink[];
  /** Nearest branch, e.g. "dev~3" (git name-rev). */
  branch?: string;
  /** Pull request that brought the commit into the current branch. */
  pr?: MessageLink;
  /** First release (tag) that contains the commit. */
  release?: string;
}

const HOVER_COMMANDS = ['gitland.showGraph', 'gitland.openCommitFileDiff', 'gitland.fileHistory', 'gitland.lineHistory', 'gitland.explainLines', 'gitland.openCommitOnRemote', 'gitland.copyText'];

// Theme colours (VS Code allows var(--vscode-*) in hover spans), same meaning as the webviews' --gl-* tokens.
const MUTED = 'var(--vscode-descriptionForeground)';
const BRANCH = 'var(--vscode-charts-blue)';
const PR = 'var(--vscode-charts-purple)';
const TICKET = 'var(--vscode-charts-green)';
const RELEASE = 'var(--vscode-charts-yellow)';
const ADDED = 'var(--vscode-gitDecoration-addedResourceForeground)';
const DELETED = 'var(--vscode-gitDecoration-deletedResourceForeground)';

/**
 * GitLens-like blame: current-line annotation + status bar by default,
 * full-file blame annotations on demand (per file or for the whole window).
 */
export class BlameController implements vscode.Disposable {
  private readonly cache = new Map<string, BlameEntry>();
  private readonly extras = new Map<string, Promise<CommitExtra | undefined>>();
  private readonly fileBlameOn = new Set<string>();
  private fileBlameWindow = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBar: vscode.StatusBarItem;
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  private timer?: NodeJS.Timeout;
  private inlineEnabled: boolean;

  /** Fires when blame information may have changed (save, commit, checkout…). */
  readonly onDidChangeBlame = this.changeEmitter.event;

  private readonly inlineDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 3em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });

  private readonly gutterDecoration = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      margin: '0 1.5em 0 0',
      width: '48ch',
    },
  });

  /** Highlights the lines introduced by the commit of the current line (while file blame is on). */
  private readonly sameCommitDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(255, 140, 40, 0.06)',
    overviewRulerColor: 'rgba(255, 140, 40, 0.6)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  constructor(
    private readonly repos: RepoManager,
    private readonly avatars: AvatarService,
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.inlineEnabled = config('blame.inline.enabled', true);
    this.statusBar = vscode.window.createStatusBarItem('gitland.blame', vscode.StatusBarAlignment.Left, 50);
    this.statusBar.name = 'Gitland Blame';

    this.disposables.push(
      this.statusBar,
      this.inlineDecoration,
      this.gutterDecoration,
      this.sameCommitDecoration,
      this.changeEmitter,
      vscode.window.onDidChangeTextEditorSelection((e) => this.schedule(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e) {
          this.schedule(e);
          this.refreshGutter(e);
        } else {
          this.statusBar.hide();
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => this.refreshGutter(e))),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document === e.document) {
          editor.setDecorations(this.inlineDecoration, []);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.cache.delete(doc.uri.toString());
        this.changeEmitter.fire(doc.uri);
        vscode.window.visibleTextEditors.filter((e) => e.document === doc).forEach((e) => this.refreshGutter(e));
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.cache.delete(doc.uri.toString())),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitland.blame')) {
          this.inlineEnabled = config('blame.inline.enabled', true);
          this.schedule(vscode.window.activeTextEditor);
        }
      }),
      repos.onDidChangeRepo(() => {
        this.cache.clear();
        this.changeEmitter.fire(undefined);
        this.schedule(vscode.window.activeTextEditor);
        vscode.window.visibleTextEditors.forEach((e) => this.refreshGutter(e));
      }),
    );
    this.schedule(vscode.window.activeTextEditor);
  }

  toggleInline(): void {
    this.inlineEnabled = !this.inlineEnabled;
    vscode.workspace
      .getConfiguration('gitland')
      .update('blame.inline.enabled', this.inlineEnabled, vscode.ConfigurationTarget.Global);
    if (!this.inlineEnabled) {
      vscode.window.visibleTextEditors.forEach((e) => e.setDecorations(this.inlineDecoration, []));
    }
    this.schedule(vscode.window.activeTextEditor);
  }

  private isFileBlameOn(editor: vscode.TextEditor): boolean {
    return this.fileBlameWindow || this.fileBlameOn.has(editor.document.uri.toString());
  }

  toggleFileBlame(editor = vscode.window.activeTextEditor): void {
    if (!editor) {
      return;
    }
    const windowMode = config<'file' | 'window'>('blame.toggleMode', 'file') === 'window';
    const turnOn = !this.isFileBlameOn(editor);
    if (windowMode) {
      this.fileBlameWindow = turnOn;
      this.fileBlameOn.clear();
    } else {
      this.fileBlameWindow = false;
      const key = editor.document.uri.toString();
      turnOn ? this.fileBlameOn.add(key) : this.fileBlameOn.delete(key);
    }
    vscode.commands.executeCommand('setContext', 'gitland.fileBlameOn', turnOn);
    for (const e of windowMode ? vscode.window.visibleTextEditors : [editor]) {
      if (turnOn) {
        this.refreshGutter(e);
      } else {
        e.setDecorations(this.gutterDecoration, []);
        e.setDecorations(this.sameCommitDecoration, []);
      }
    }
    this.schedule(editor);
  }

  getBlame(doc: vscode.TextDocument): Promise<BlameResult | undefined> {
    const key = doc.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.version === doc.version) {
      return cached.promise;
    }
    const promise = (async () => {
      if (doc.uri.scheme !== 'file' || doc.lineCount > MAX_LINES) {
        return undefined;
      }
      const repo = await this.repos.getRepo(doc.uri);
      if (!repo) {
        return undefined;
      }
      const rel = repo.relativePath(doc.uri.fsPath);
      if (rel.startsWith('..') || rel.startsWith('.git/')) {
        return undefined;
      }
      try {
        const [{ lines }, me] = await Promise.all([
          repo.blame(rel, doc.isDirty ? doc.getText() : undefined),
          repo.userEmail(),
        ]);
        return { repo, lines, me };
      } catch {
        return undefined; // untracked / ignored / binary
      }
    })();
    this.cache.set(key, { version: doc.version, promise });
    return promise;
  }

  private schedule(editor: vscode.TextEditor | undefined): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.updateCurrentLine(editor), 120);
  }

  authorName(c: BlameCommit, me?: string): string {
    if (c.sha === UNCOMMITTED_SHA) {
      return 'You';
    }
    return me && c.email.toLowerCase() === me.toLowerCase() ? 'You' : c.author;
  }

  private async updateCurrentLine(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || editor !== vscode.window.activeTextEditor) {
      return;
    }
    const showStatus = config('blame.statusBar.enabled', true);
    const fileBlame = this.isFileBlameOn(editor);
    if (!this.inlineEnabled && !showStatus && !fileBlame) {
      this.statusBar.hide();
      return;
    }
    const doc = editor.document;
    const blame = await this.getBlame(doc);
    if (editor !== vscode.window.activeTextEditor || !blame) {
      editor.setDecorations(this.inlineDecoration, []);
      if (!blame) {
        this.statusBar.hide();
      }
      return;
    }
    const line = editor.selection.active.line;
    const commit = blame.lines[line];
    if (!commit || doc.version !== this.cache.get(doc.uri.toString())?.version) {
      editor.setDecorations(this.inlineDecoration, []);
      return;
    }
    const author = this.authorName(commit, blame.me);
    const uncommitted = commit.sha === UNCOMMITTED_SHA;
    // Wait briefly for the full message; the plain hover is still fine if git is slow.
    const pending = this.extra(blame.repo, commit.sha);
    const extra = await Promise.race([pending, sleep(400).then(() => undefined)]);
    if (editor !== vscode.window.activeTextEditor || editor.selection.active.line !== line) {
      return;
    }
    if (!extra) {
      // Slow git: show the plain hover now, the full one as soon as it is ready.
      pending.then((x) => x && editor.selection.active.line === line && this.schedule(editor));
    }
    const hover = this.hover(blame.repo, commit, author, doc.uri, extra, line);

    // GitLens hides the current-line annotation while the file blame is shown.
    if (this.inlineEnabled && !fileBlame && editor.selections.length === 1) {
      const text = uncommitted
        ? 'You • Uncommitted changes'
        : config('blame.inline.format', '${author}, ${ago} • ${message}')
            .replace(/\$\{author\}/g, author)
            .replace(/\$\{ago\}/g, timeAgo(commit.date))
            .replace(/\$\{date\}/g, formatDate(commit.date))
            .replace(/\$\{sha\}/g, commit.sha.slice(0, 8))
            .replace(/\$\{message\}/g, truncate(commit.summary, 60));
      const end = doc.lineAt(line).range.end;
      editor.setDecorations(this.inlineDecoration, [
        { range: new vscode.Range(end, end), hoverMessage: hover, renderOptions: { after: { contentText: text } } },
      ]);
    } else {
      editor.setDecorations(this.inlineDecoration, []);
    }

    if (fileBlame) {
      const same: vscode.Range[] = [];
      if (!uncommitted) {
        blame.lines.forEach((c, i) => {
          if (c.sha === commit.sha && i < doc.lineCount) {
            same.push(new vscode.Range(i, 0, i, 0));
          }
        });
      }
      editor.setDecorations(this.sameCommitDecoration, same);
    }

    if (showStatus) {
      this.statusBar.text = uncommitted ? '$(git-commit) You, uncommitted' : `$(git-commit) ${author}, ${timeAgo(commit.date)}`;
      this.statusBar.tooltip = hover;
      this.statusBar.command = uncommitted
        ? undefined
        : { title: 'Show in graph', command: 'gitland.showGraph', arguments: [{ repoRoot: blame.repo.root, sha: commit.sha }] };
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }
  }

  /** Full message, stats and links of a commit (cached; commits never change). */
  private extra(repo: Repo, sha: string): Promise<CommitExtra | undefined> {
    if (sha === UNCOMMITTED_SHA) {
      return Promise.resolve(undefined);
    }
    const key = `${repo.root}\0${sha}`;
    let p = this.extras.get(key);
    if (!p) {
      if (this.extras.size > 1000) {
        this.extras.clear();
      }
      p = (async () => {
        try {
          const [d, provider, branch, merges, release] = await Promise.all([
            repo.commitDetails(sha),
            getProvider(repo, this.secrets),
            repo.exec(['name-rev', '--name-only', '--no-undefined', '--refs=refs/heads/*', sha]).catch(() => ''),
            // Merges between the commit and HEAD, oldest first: the first PR merge brought it in.
            repo.exec(['log', '--merges', '--ancestry-path', '--reverse', '--format=%s', `${sha}..HEAD`]).catch(() => ''),
            repo.releaseOf(sha),
          ]);
          const links = findLinks(d.message, provider);
          let pr = links.find((l) => l.kind === 'pr');
          if (!pr) {
            for (const subject of merges.split('\n')) {
              pr = findLinks(subject, provider).find((l) => l.kind === 'pr');
              if (pr) {
                break;
              }
            }
          }
          return {
            message: d.message,
            files: d.files.length,
            added: d.files.reduce((n, f) => n + (f.added ?? 0), 0),
            deleted: d.files.reduce((n, f) => n + (f.deleted ?? 0), 0),
            links: links.filter((l) => l !== pr),
            // Only a readable answer ("dev", "dev~3"); "x~4^2" (reached through a merge) is noise.
            release,
            branch: /^[^~^\s]+(~\d+)?$/.test(branch.trim()) ? branch.trim().replace(/^remotes\//, '') : undefined,
            pr,
          };
        } catch {
          return undefined;
        }
      })();
      this.extras.set(key, p);
    }
    return p;
  }

  hover(repo: Repo, c: BlameCommit, author: string, uri: vscode.Uri, extra?: CommitExtra, line?: number): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    // Only our own commands may run from the hover: commit messages are rendered as markdown.
    md.isTrusted = { enabledCommands: HOVER_COMMANDS };
    md.supportHtml = true;
    if (c.sha === UNCOMMITTED_SHA) {
      md.appendMarkdown('$(edit) **You** &nbsp;·&nbsp; Uncommitted changes\n\n');
      md.appendMarkdown(muted('This line was changed but not committed yet.'));
      return md;
    }

    // Author and date
    const avatar = c.email && config('blame.avatars', true) ? this.avatars.hoverUrlFor(c.email) : undefined;
    if (avatar) {
      this.avatars.resolve(repo, c.email, c.sha);
      md.appendMarkdown(`<img src="${avatar}" width="20" height="20"/>&nbsp;&nbsp;`);
    } else {
      md.appendMarkdown('$(account)&nbsp;');
    }
    const tone = authorColor(c.email || author);
    md.appendMarkdown(color(`**${escapeMd(author)}**`, tone));
    if (c.email) {
      md.appendMarkdown(`&nbsp;&nbsp;${muted(escapeMd(c.email))}`);
    }
    md.appendMarkdown(`\n\n${color('●', ageColor(c.date))}&nbsp;${timeAgo(c.date)}&nbsp;&nbsp;${muted(formatDate(c.date))}\n\n`);

    // Message
    const message = extra?.message || c.summary;
    const nl = message.indexOf('\n');
    const subject = nl < 0 ? message : message.slice(0, nl);
    // Trailers (Co-Authored-By, Signed-off-by…) and Azure's "Related work items" line are noise here.
    const body = message.slice(nl < 0 ? message.length : nl + 1).replace(/^(?:[\w-]+-by|Related work items): .*$/gim, '').trim();
    md.appendMarkdown(`---\n\n**${escapeMd(subject)}**\n\n`);
    if (body) {
      md.appendMarkdown(safeMarkdown(truncate(body, 1500)) + '\n\n');
    }

    // One line of refs, like the graph hover card: branch, pull request, mentioned PRs / work items, release.
    const refs: string[] = [];
    if (extra?.branch) {
      refs.push(pill(`$(git-branch) ${escapeMd(truncate(extra.branch, 36))}`, BRANCH));
    }
    if (extra?.pr) {
      refs.push(`[${pill(`$(git-pull-request) PR ${extra.pr.id}`, PR)}](${extra.pr.url} "Pull request that brought this change")`);
    }
    for (const l of extra?.links ?? []) {
      if (l.kind === 'pr' && l.id === extra?.pr?.id) {
        continue;
      }
      refs.push(l.kind === 'pr' ? `[${pill(`$(git-pull-request) PR ${l.id}`, PR)}](${l.url})` : `[${pill(`$(issues) #${l.id}`, TICKET)}](${l.url})`);
    }
    if (extra) {
      refs.push(extra.release ? pill(`$(tag) ${escapeMd(extra.release)}`, RELEASE) : muted('not released yet'));
    }
    if (refs.length) {
      md.appendMarkdown(refs.join('&nbsp;&nbsp;') + '\n\n');
    }

    // SHA and stats
    md.appendMarkdown('---\n\n');
    let meta = pill(`$(git-commit) ${c.sha.slice(0, 8)}`, tone);
    if (extra) {
      meta += `&nbsp;&nbsp;&nbsp;$(file) ${extra.files} file${extra.files === 1 ? '' : 's'}`;
      if (extra.added || extra.deleted) {
        meta += `&nbsp;&nbsp;${color(`+${extra.added}`, ADDED)} ${color(`−${extra.deleted}`, DELETED)}&nbsp;&nbsp;${diffBar(extra.added, extra.deleted)}`;
      }
    }
    md.appendMarkdown(meta + '\n\n');

    // Actions
    const args = { repoRoot: repo.root, sha: c.sha, path: c.filename, previousPath: c.previous?.path, uri: uri.toString() };
    const actions = [
      `[$(git-merge) Graph](${commandUri('gitland.showGraph', { repoRoot: repo.root, sha: c.sha })} "Show this commit in the Commit Graph")`,
      `[$(diff) Changes](${commandUri('gitland.openCommitFileDiff', args)} "Open the changes this commit made to the file")`,
      `[$(history) History](${commandUri('gitland.fileHistory', uri.toString())} "File history")`,
      ...(line !== undefined
        ? [
            `[$(list-selection) Lines](${commandUri('gitland.lineHistory', { uri: uri.toString(), line })} "Every commit that changed this line")`,
            `[$(sparkle) Why?](${commandUri('gitland.explainLines', { uri: uri.toString(), line })} "Explain why this line is like this (AI)")`,
          ]
        : []),
      `[$(link-external) Remote](${commandUri('gitland.openCommitOnRemote', { repoRoot: repo.root, sha: c.sha })} "Open the commit on the remote")`,
      `[$(copy) SHA](${commandUri('gitland.copyText', c.sha)} "Copy the full SHA")`,
    ];
    md.appendMarkdown(actions.join('&nbsp;&nbsp;&nbsp;'));
    return md;
  }

  private async refreshGutter(editor: vscode.TextEditor): Promise<void> {
    if (!this.isFileBlameOn(editor)) {
      return;
    }
    const blame = await this.getBlame(editor.document);
    if (!blame) {
      editor.setDecorations(this.gutterDecoration, []);
      vscode.window.setStatusBarMessage('Gitland: no blame information for this file', 3000);
      return;
    }
    const doc = editor.document;
    editor.setDecorations(this.gutterDecoration, this.gutterDecorations(blame, doc));
    if (editor === vscode.window.activeTextEditor) {
      this.schedule(editor);
    }
    // Then give each block's hover its full message, stats and links.
    const shas = [...new Set(blame.lines.map((c) => c.sha))].filter((s) => s !== UNCOMMITTED_SHA).slice(0, MAX_ENRICHED);
    const extras = new Map<string, CommitExtra>();
    for (let i = 0; i < shas.length; i += 6) {
      const batch = shas.slice(i, i + 6);
      (await Promise.all(batch.map((sha) => this.extra(blame.repo, sha)))).forEach((x, k) => x && extras.set(batch[k], x));
    }
    const version = this.cache.get(doc.uri.toString())?.version;
    if (extras.size && this.isFileBlameOn(editor) && version === doc.version && vscode.window.visibleTextEditors.includes(editor)) {
      editor.setDecorations(this.gutterDecoration, this.gutterDecorations(blame, doc, extras));
    }
  }

  private gutterDecorations(blame: BlameResult, doc: vscode.TextDocument, extras?: Map<string, CommitExtra>): vscode.DecorationOptions[] {
    const dates = blame.lines.filter((c) => c.sha !== UNCOMMITTED_SHA).map((c) => c.date);
    const min = Math.min(...dates);
    const max = Math.max(...dates);
    const decorations: vscode.DecorationOptions[] = [];
    const lineCount = doc.lineCount;
    let prev: string | undefined;
    for (let i = 0; i < blame.lines.length && i < lineCount; i++) {
      const c = blame.lines[i];
      const first = c.sha !== prev;
      prev = c.sha;
      const author = this.authorName(c, blame.me);
      // Like GitLens: "message   ago" on the first line of each block, author in the hover.
      const text =
        c.sha === UNCOMMITTED_SHA
          ? pad('Uncommitted changes', 32) + ' ' + pad('now', 13)
          : pad(truncate(c.summary, 32), 32) + ' ' + pad(truncate(shortAgo(c.date), 13), 13);
      const heat = c.sha === UNCOMMITTED_SHA ? 1 : max === min ? 1 : (c.date - min) / (max - min);
      decorations.push({
        range: new vscode.Range(i, 0, i, 0),
        hoverMessage: first ? this.hover(blame.repo, c, author, doc.uri, extras?.get(c.sha), i) : undefined,
        renderOptions: {
          before: {
            contentText: first ? ' ' + text : ' ',
            textDecoration: `none; border-left: 2px solid ${heatColor(heat)}; padding-left: 6px; white-space: pre; box-sizing: border-box;${
              first && i > 0 ? ' border-top: 1px solid rgba(128,128,128,0.18);' : ''
            }`,
          },
        },
      });
    }
    return decorations;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function color(text: string, c: string): string {
  return `<span style="color:${c};">${text}</span>`;
}

/** Tinted badge: colored text on the same color at low opacity (#RRGGBBAA is allowed in hovers). */
function pill(text: string, c: string): string {
  return `<span style="color:${c};background-color:var(--vscode-textCodeBlock-background);border-radius:9px;">&nbsp;${text}&nbsp;</span>`;
}

/** Recent = warm, old = cool (log scale over a year), in the graph's muted palette. */
function ageColor(ms: number): string {
  const days = Math.max(0, (Date.now() - ms) / 86400000);
  const t = 1 - Math.min(1, Math.log(days + 1) / Math.log(366));
  const cold = [0x6f, 0x9f, 0xd0];
  const hot = [0xd9, 0x8f, 0x5f];
  return '#' + cold.map((v, i) => Math.round(v + (hot[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

function muted(text: string): string {
  return color(text, MUTED);
}

/** Five-block +/- bar, like GitHub. */
function diffBar(added: number, deleted: number): string {
  const total = added + deleted;
  const a = total ? Math.round((added / total) * 5) : 0;
  const d = total ? Math.min(5 - a, Math.round((deleted / total) * 5)) : 0;
  return color('■'.repeat(a), ADDED) + color('■'.repeat(d), DELETED) + color('■'.repeat(5 - a - d), 'var(--vscode-disabledForeground)');
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function shortAgo(ms: number): string {
  if (Date.now() - ms < 30000) {
    return 'just now';
  }
  return timeAgo(ms).replace(' ago', '').replace(/ (second|minute|hour|day|week|month|year)s?/, (_, u: string) => {
    const unit: Record<string, string> = { second: 's', minute: 'min', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' };
    return unit[u];
  }) + ' ago';
}

function heatColor(t: number): string {
  // old = cool blue, recent = warm orange (same idea as the GitLens heatmap)
  const cold = [0x6f, 0x9f, 0xd0];
  const hot = [0xd9, 0x8f, 0x5f];
  const c = cold.map((v, i) => Math.round(v + (hot[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * Commit message markdown for a hover: no raw HTML, no command / file links, no images;
 * fenced code and lists are kept.
 */
function safeMarkdown(text: string): string {
  // Code (fenced or `inline`) is shown literally by the renderer, so only the prose is escaped.
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/^&gt;/gm, '>')
            .replace(/!\[/g, '\\![')
            .replace(/\]\((?!https:\/\/)[^)]*\)/g, ']'),
    )
    .join('');
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (m) => '\\' + m);
}
