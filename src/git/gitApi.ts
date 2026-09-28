// Minimal typings for the built-in vscode.git extension API (v1).
import * as vscode from 'vscode';

export interface GitApiRepositoryState {
  readonly HEAD: { name?: string; commit?: string } | undefined;
  readonly onDidChange: vscode.Event<void>;
}

export interface GitApiRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitApiRepositoryState;
  checkout(treeish: string): Promise<void>;
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
  fetch(remote?: string, ref?: string, depth?: number): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
}

export interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly repositories: GitApiRepository[];
  readonly onDidOpenRepository: vscode.Event<GitApiRepository>;
  readonly onDidCloseRepository: vscode.Event<GitApiRepository>;
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  getRepository(uri: vscode.Uri): GitApiRepository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

export async function getGitApi(): Promise<GitApi | undefined> {
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
  if (!ext) {
    return undefined;
  }
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.getAPI(1);
}
