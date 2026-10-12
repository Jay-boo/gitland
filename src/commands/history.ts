import * as vscode from 'vscode';
import { RepoManager } from '../git/repoManager';
import { AvatarService } from '../avatars';
import { HistoryPanel } from '../views/historyPanel';

function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  if (typeof arg === 'string') {
    return vscode.Uri.parse(arg);
  }
  return vscode.window.activeTextEditor?.document.uri;
}

export async function fileHistory(context: vscode.ExtensionContext, repos: RepoManager, avatars: AvatarService, arg?: unknown): Promise<void> {
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
  await HistoryPanel.show(context, repos, avatars, repo, repo.relativePath(uri.fsPath));
}

/** History of the selected lines (or `arg` = { uri, line } from a blame hover); `explain` starts ✨ right away. */
export async function lineHistory(context: vscode.ExtensionContext, repos: RepoManager, avatars: AvatarService, arg?: { uri?: string; line?: number; end?: number }, explain = false): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const uri = arg?.uri ? vscode.Uri.parse(arg.uri) : editor?.document.uri;
  if (!uri || uri.scheme !== 'file') {
    vscode.window.showWarningMessage('Gitland: open a file first.');
    return;
  }
  const repo = await repos.getRepo(uri);
  if (!repo) {
    return;
  }
  const start = arg?.line !== undefined ? arg.line + 1 : (editor?.selection.start.line ?? 0) + 1;
  let end = arg?.line !== undefined ? (arg.end ?? arg.line) + 1 : (editor?.selection.end.line ?? 0) + 1;
  // A selection ending at column 0 of the next line does not include it.
  if (arg?.line === undefined && editor && editor.selection.end.character === 0 && end > start) {
    end--;
  }
  await HistoryPanel.show(context, repos, avatars, repo, repo.relativePath(uri.fsPath), { start, end }, explain);
}
