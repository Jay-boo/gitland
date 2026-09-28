import * as vscode from 'vscode';
import { RepoManager } from '../git/repoManager';
import { getProvider } from '../providers';
import { AuthError, PullRequest, PullRequestGroup } from '../providers/types';
import { errorMessage, timeAgo } from '../util';

const GROUPS: { key: PullRequestGroup; label: string; icon: string }[] = [
  { key: 'mine', label: 'Created by me', icon: 'account' },
  { key: 'review', label: 'Waiting for my review', icon: 'eye' },
  { key: 'other', label: 'All other active', icon: 'organization' },
];

export class PullRequestItem extends vscode.TreeItem {
  constructor(public readonly pr: PullRequest, isCurrent: boolean) {
    super(pr.title, vscode.TreeItemCollapsibleState.None);
    this.id = `pr:${pr.id}`;
    this.description = `${pr.label} · ${pr.sourceBranch} → ${pr.targetBranch}${pr.isDraft ? ' · draft' : ''}`;
    this.contextValue = 'pr';
    this.iconPath = new vscode.ThemeIcon(
      isCurrent ? 'arrow-circle-right' : pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request',
      new vscode.ThemeColor(pr.isDraft ? 'descriptionForeground' : 'charts.green'),
    );
    this.tooltip = new vscode.MarkdownString(
      `**${pr.label}** ${pr.title}\n\n\`${pr.sourceBranch}\` → \`${pr.targetBranch}\`\n\nby ${pr.author}${pr.created ? `, ${timeAgo(pr.created)}` : ''}`,
    );
    this.command = { title: 'Open', command: 'gitland.prs.open', arguments: [this] };
  }
}

class GroupItem extends vscode.TreeItem {
  constructor(public readonly prs: PullRequest[], label: string, icon: string, public readonly current?: string) {
    super(`${label} (${prs.length})`, prs.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

export class PullRequestsView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<vscode.TreeItem>;

  constructor(private readonly repos: RepoManager, private readonly secrets: vscode.SecretStorage) {
    this.view = vscode.window.createTreeView('gitland.prs', { treeDataProvider: this });
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
    return e;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element instanceof GroupItem) {
      return element.prs.map((pr) => new PullRequestItem(pr, pr.sourceBranch === element.current));
    }
    const repo = await this.repos.activeRepo(false);
    if (!repo) {
      this.view.message = 'No git repository in this workspace.';
      return [];
    }
    const provider = await getProvider(repo, this.secrets);
    if (!provider) {
      this.view.message = 'No Azure DevOps or GitHub remote found for this repository.';
      return [];
    }
    this.view.message = undefined;
    try {
      const [prs, current] = await Promise.all([provider.listPullRequests(), repo.currentBranch()]);
      return GROUPS.map((g) => new GroupItem(prs.filter((p) => p.group === g.key), g.label, g.icon, current));
    } catch (e) {
      const item = new vscode.TreeItem(e instanceof AuthError ? 'Sign in to load pull requests' : `Failed to load: ${errorMessage(e)}`);
      item.iconPath = new vscode.ThemeIcon(e instanceof AuthError ? 'account' : 'warning');
      item.tooltip = errorMessage(e);
      item.command =
        e instanceof AuthError ? { title: 'Set PAT', command: 'gitland.setAzurePat' } : { title: 'Retry', command: 'gitland.prs.refresh' };
      return [item];
    }
  }

  dispose(): void {
    this.view.dispose();
    this.emitter.dispose();
  }
}
