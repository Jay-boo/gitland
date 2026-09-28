import * as vscode from 'vscode';
import { BlameCommit, Repo, UNCOMMITTED_SHA } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { commandUri, config, formatDate, timeAgo, truncate } from '../util';

interface BlameEntry {
  version: number;
  promise: Promise<{ repo: Repo; lines: BlameCommit[]; me?: string } | undefined>;
}

const MAX_LINES = 30000;

export class BlameController implements vscode.Disposable {
  private readonly cache = new Map<string, BlameEntry>();
  private readonly fileBlameOn = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBar: vscode.StatusBarItem;
  private timer?: NodeJS.Timeout;
  private inlineEnabled: boolean;

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
      width: '32ch',
    },
  });

  constructor(private readonly repos: RepoManager) {
    this.inlineEnabled = config('blame.inline.enabled', true);
    this.statusBar = vscode.window.createStatusBarItem('gitland.blame', vscode.StatusBarAlignment.Left, 50);
    this.statusBar.name = 'Gitland Blame';

    this.disposables.push(
      this.statusBar,
      this.inlineDecoration,
      this.gutterDecoration,
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

  toggleFileBlame(editor = vscode.window.activeTextEditor): void {
    if (!editor) {
      return;
    }
    const key = editor.document.uri.toString();
    if (this.fileBlameOn.has(key)) {
      this.fileBlameOn.delete(key);
      editor.setDecorations(this.gutterDecoration, []);
    } else {
      this.fileBlameOn.add(key);
      this.refreshGutter(editor);
    }
  }

  private getBlame(doc: vscode.TextDocument): BlameEntry['promise'] {
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

  private authorName(c: BlameCommit, me?: string): string {
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
    if (!this.inlineEnabled && !showStatus) {
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
    const hover = this.hover(blame.repo, commit, author, doc.uri);

    if (this.inlineEnabled && editor.selections.length === 1) {
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

  private hover(repo: Repo, c: BlameCommit, author: string, uri: vscode.Uri): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportHtml = true;
    if (c.sha === UNCOMMITTED_SHA) {
      md.appendMarkdown('$(circle-large-outline) **Uncommitted changes**');
      return md;
    }
    md.appendMarkdown(`$(account) **${escapeMd(author)}** ${c.email ? `<${escapeMd(c.email)}>` : ''}, `);
    md.appendMarkdown(`${timeAgo(c.date)} _(${formatDate(c.date)})_\n\n`);
    md.appendMarkdown(`${escapeMd(c.summary)}\n\n---\n\n`);
    const args = { repoRoot: repo.root, sha: c.sha, path: c.filename, previousPath: c.previous?.path, uri: uri.toString() };
    md.appendMarkdown(`[$(git-commit) \`${c.sha.slice(0, 8)}\`](${commandUri('gitland.showGraph', { repoRoot: repo.root, sha: c.sha })} "Show in graph")`);
    md.appendMarkdown(` &nbsp;|&nbsp; [$(diff) Changes](${commandUri('gitland.openCommitFileDiff', args)} "Open changes of this commit")`);
    md.appendMarkdown(` &nbsp;|&nbsp; [$(history) File history](${commandUri('gitland.fileHistory', uri.toString())} "File history")`);
    md.appendMarkdown(` &nbsp;|&nbsp; [$(globe) Remote](${commandUri('gitland.openCommitOnRemote', { repoRoot: repo.root, sha: c.sha })} "Open on remote")`);
    md.appendMarkdown(` &nbsp;|&nbsp; [$(copy) SHA](${commandUri('gitland.copyText', c.sha)} "Copy SHA")`);
    return md;
  }

  private async refreshGutter(editor: vscode.TextEditor): Promise<void> {
    if (!this.fileBlameOn.has(editor.document.uri.toString())) {
      return;
    }
    const blame = await this.getBlame(editor.document);
    if (!blame) {
      editor.setDecorations(this.gutterDecoration, []);
      vscode.window.setStatusBarMessage('Gitland: no blame information for this file', 3000);
      return;
    }
    const dates = blame.lines.filter((c) => c.sha !== UNCOMMITTED_SHA).map((c) => c.date);
    const min = Math.min(...dates);
    const max = Math.max(...dates);
    const decorations: vscode.DecorationOptions[] = [];
    const lineCount = editor.document.lineCount;
    let prev: string | undefined;
    for (let i = 0; i < blame.lines.length && i < lineCount; i++) {
      const c = blame.lines[i];
      const first = c.sha !== prev;
      prev = c.sha;
      const author = this.authorName(c, blame.me);
      const text =
        c.sha === UNCOMMITTED_SHA
          ? 'Uncommitted'
          : `${formatDate(c.date).slice(0, 10)}  ${truncate(author, 18)}`;
      const heat = c.sha === UNCOMMITTED_SHA ? 1 : max === min ? 1 : (c.date - min) / (max - min);
      const color = heatColor(heat);
      decorations.push({
        range: new vscode.Range(i, 0, i, 0),
        hoverMessage: first ? this.hover(blame.repo, c, author, editor.document.uri) : undefined,
        renderOptions: {
          before: {
            contentText: first ? ' ' + text : ' ',
            textDecoration: `none; border-left: 3px solid ${color}; padding-left: 6px; white-space: pre; box-sizing: border-box;${first ? ' border-top: 1px solid rgba(128,128,128,0.15);' : ''}`,
          },
        },
      });
    }
    editor.setDecorations(this.gutterDecoration, decorations);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}

function heatColor(t: number): string {
  // old = cool blue, recent = warm orange
  const cold = [70, 130, 200];
  const hot = [255, 140, 40];
  const c = cold.map((v, i) => Math.round(v + (hot[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (m) => '\\' + m);
}
