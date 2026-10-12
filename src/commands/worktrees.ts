import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { errorMessage } from '../util';

interface Worktree {
  path: string;
  branch?: string;
  sha: string;
  main: boolean;
  locked: boolean;
  prunable: boolean;
}

export async function listWorktrees(repo: Repo): Promise<Worktree[]> {
  const out = await repo.exec(['worktree', 'list', '--porcelain']);
  return out
    .split('\n\n')
    .map((block, i) => {
      const lines = block.split('\n');
      const get = (k: string) => lines.find((l) => l.startsWith(k + ' '))?.slice(k.length + 1);
      return {
        path: get('worktree') ?? '',
        branch: get('branch')?.replace(/^refs\/heads\//, ''),
        sha: get('HEAD') ?? '',
        main: i === 0,
        locked: lines.some((l) => l.startsWith('locked')),
        prunable: lines.some((l) => l.startsWith('prunable')),
      };
    })
    .filter((w) => w.path);
}

/** Suggested folder for a branch's worktree: next to the repository, in `<repo>.worktrees/`. */
function worktreeFolderFor(repo: Repo, branch: string): string {
  return path.join(path.dirname(repo.root), `${path.basename(repo.root)}.worktrees`, branch.replace(/[\\/:*?"<>|]+/g, '-'));
}

/**
 * Asks for a folder and creates a worktree there for `branch`. With `startPoint`, the branch is created
 * from it (without upstream); otherwise an existing local branch is checked out, or `remoteRef` tracked.
 * Returns the folder, or undefined when cancelled.
 */
export async function createWorktree(repo: Repo, branch: string, opts: { startPoint?: string; remoteRef?: string } = {}): Promise<string | undefined> {
  const suggested = worktreeFolderFor(repo, branch);
  const target = await vscode.window.showInputBox({
    title: `Open ${branch} in a new worktree`,
    prompt: 'Folder of the new worktree (a separate checkout of the branch, sharing this repository)',
    value: suggested,
    valueSelection: [suggested.length - path.basename(suggested).length, suggested.length],
  });
  if (!target) {
    return undefined;
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    throw new Error(`${target} already exists and is not empty.`);
  }
  const args = opts.startPoint
    ? ['worktree', 'add', '--no-track', '-b', branch, target, opts.startPoint]
    : (await repo.localBranchExists(branch))
      ? ['worktree', 'add', target, branch]
      : ['worktree', 'add', '--track', '-b', branch, target, opts.remoteRef ?? branch];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating the worktree for ${branch}…` }, () => repo.exec(args));
  return target;
}

export async function openFolderInNewWindow(folder: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
}

/**
 * A branch in its own folder (git worktree) opened in a new window: work on two branches at once
 * without stashing. `ref` may be a local or a remote branch (a local one tracking it is created).
 */
export async function openInWorktree(repo: Repo, ref: string, isRemote: boolean): Promise<void> {
  const remotes = await repo.remoteNames();
  const remote = isRemote ? remotes.find((r) => ref.startsWith(r + '/')) : undefined;
  const local = remote ? ref.slice(remote.length + 1) : ref;
  const existing = (await listWorktrees(repo)).find((w) => w.branch === local);
  if (existing) {
    await openFolderInNewWindow(existing.path);
    return;
  }
  const target = await createWorktree(repo, local, { remoteRef: ref });
  if (target) {
    await openFolderInNewWindow(target);
  }
}

/** "Gitland: Worktrees…": open or remove the worktrees of the repository, or create one. */
export async function manageWorktrees(repo: Repo): Promise<void> {
  const list = await listWorktrees(repo);
  type Item = vscode.QuickPickItem & { wt?: Worktree; create?: boolean };
  const REMOVE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove this worktree' };
  const items: Item[] = [
    ...list.map((w) => ({
      label: `${w.main ? '$(repo)' : '$(folder)'} ${w.branch ?? `(detached ${w.sha.slice(0, 7)})`}`,
      description: `${w.path}${w.main ? ' · main worktree' : ''}${w.path === repo.root ? ' · this window' : ''}${w.locked ? ' · locked' : ''}${w.prunable ? ' · missing' : ''}`,
      buttons: w.main ? [] : [REMOVE],
      wt: w,
    })),
    { label: '$(add) Open a branch in a new worktree…', create: true, alwaysShow: true },
  ];
  const picked = await new Promise<Item | { remove: Worktree } | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'Gitland: Worktrees';
    qp.placeholder = 'Open a worktree in a new window';
    qp.items = items;
    qp.onDidTriggerItemButton((e) => {
      resolve({ remove: e.item.wt! });
      qp.hide();
    });
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]);
      qp.hide();
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  if (!picked) {
    return;
  }
  try {
    if ('remove' in picked) {
      const ok = await vscode.window.showWarningMessage(`Remove the worktree ${picked.remove.path}? The branch is kept; uncommitted changes in that folder are lost.`, { modal: true }, 'Remove');
      if (ok === 'Remove') {
        await repo.exec(['worktree', 'remove', '--force', picked.remove.path]);
        vscode.window.setStatusBarMessage('Gitland: worktree removed', 3000);
      }
      return;
    }
    if (picked.create) {
      const branches = await repo.branches();
      const pick = await vscode.window.showQuickPick(
        branches.filter((b) => !b.current).map((b) => ({ label: `$(${b.remote ? 'cloud' : 'git-branch'}) ${b.shortName}`, b })),
        { placeHolder: 'Branch to open in a new worktree' },
      );
      if (pick) {
        await openInWorktree(repo, pick.b.shortName, pick.b.remote);
      }
      return;
    }
    if (picked.wt) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(picked.wt.path), { forceNewWindow: picked.wt.path !== repo.root });
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`);
  }
}
