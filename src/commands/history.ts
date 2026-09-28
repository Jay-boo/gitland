import * as vscode from 'vscode';
import { HistoryEntry, Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { openCommitFileDiff } from '../graph/graphPanel';
import { formatDate, timeAgo } from '../util';

const HISTORY_MAX = 200;

async function pickAndDiff(repos: RepoManager, repo: Repo, entries: HistoryEntry[], title: string): Promise<void> {
  if (!entries.length) {
    vscode.window.showInformationMessage('Gitland: no history found (is the file committed?).');
    return;
  }
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { entry: HistoryEntry; index: number }>();
  qp.title = title;
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.placeholder = 'Pick a commit to see how it changed the file';
  qp.items = entries.map((e, index) => ({
    label: `$(git-commit) ${e.subject}`,
    description: `${e.author} · ${timeAgo(e.date)}`,
    detail: `${e.sha.slice(0, 8)} · ${formatDate(e.date)}${e.path ? ` · ${e.path}` : ''}`,
    entry: e,
    index,
  }));
  qp.onDidAccept(() => {
    const item = qp.selectedItems[0];
    qp.hide();
    if (!item) {
      return;
    }
    const older = entries[item.index + 1];
    const oldPath = older && older.path !== item.entry.path ? older.path : undefined;
    // The oldest entry of a complete history is the commit that added the file.
    const status = item.index === entries.length - 1 && entries.length < HISTORY_MAX ? 'A' : 'M';
    openCommitFileDiff(repos, repo, item.entry.sha, item.entry.path, oldPath, status);
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  if (typeof arg === 'string') {
    return vscode.Uri.parse(arg);
  }
  return vscode.window.activeTextEditor?.document.uri;
}

export async function fileHistory(repos: RepoManager, arg?: unknown): Promise<void> {
  const uri = targetUri(arg);
  if (!uri || uri.scheme !== 'file') {
    vscode.window.showWarningMessage('Gitland: open a file first.');
    return;
  }
  const repo = await repos.getRepo(uri);
  if (!repo) {
    vscode.window.showWarningMessage('Gitland: file is not in a git repository.');
    return;
  }
  const rel = repo.relativePath(uri.fsPath);
  const entries = await repo.fileHistory(rel, HISTORY_MAX);
  await pickAndDiff(repos, repo, entries, `History of ${rel}`);
}

export async function lineHistory(repos: RepoManager): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    vscode.window.showWarningMessage('Gitland: open a file first.');
    return;
  }
  const repo = await repos.getRepo(editor.document.uri);
  if (!repo) {
    return;
  }
  const rel = repo.relativePath(editor.document.uri.fsPath);
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  const entries = await repo.lineHistory(rel, start, end, HISTORY_MAX);
  await pickAndDiff(repos, repo, entries, `History of ${rel}:${start}${end !== start ? `-${end}` : ''}`);
}
