import * as vscode from 'vscode';
import { RepoManager } from '../git/repoManager';
import { getProvider } from '../providers';
import { AuthError, Ticket } from '../providers/types';
import { log } from '../log';
import { errorMessage } from '../util';

export class TicketItem extends vscode.TreeItem {
  constructor(public readonly ticket: Ticket, isCurrent: boolean) {
    super(ticket.title, vscode.TreeItemCollapsibleState.None);
    this.id = `ticket:${ticket.id}`;
    this.description = `#${ticket.id} · ${ticket.state}${isCurrent ? ' · ● current branch' : ''}`;
    this.contextValue = 'ticket';
    this.iconPath = ticketIcon(ticket.type, isCurrent);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${ticket.type} #${ticket.id}** — ${ticket.state}\n\n${ticket.title}`);
    if (ticket.assignee) {
      md.appendMarkdown(`\n\n$(account) ${ticket.assignee}`);
    }
    md.supportThemeIcons = true;
    this.tooltip = md;
    this.command = { title: 'Start work', command: 'gitland.tickets.startWork', arguments: [this] };
  }
}

export function ticketIcon(type: string, highlight = false): vscode.ThemeIcon {
  const t = type.toLowerCase();
  const [icon, color] = t.includes('bug')
    ? ['bug', 'charts.red']
    : t.includes('task')
      ? ['tasklist', 'charts.yellow']
      : t.includes('story') || t.includes('backlog')
        ? ['book', 'charts.blue']
        : t.includes('feature')
          ? ['star-full', 'charts.purple']
          : t.includes('epic')
            ? ['rocket', 'charts.orange']
            : ['issues', 'charts.green'];
  return new vscode.ThemeIcon(highlight ? 'arrow-circle-right' : icon, new vscode.ThemeColor(color));
}

export class TicketsView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<vscode.TreeItem>;
  private readonly disposables: vscode.Disposable[] = [];
  private lastBranch?: string;

  constructor(private readonly repos: RepoManager, private readonly secrets: vscode.SecretStorage) {
    this.view = vscode.window.createTreeView('gitland.tickets', { treeDataProvider: this, showCollapseAll: false });
    this.disposables.push(
      this.view,
      repos.onDidChangeRepo(async (r) => {
        const b = await r.currentBranch();
        if (b !== this.lastBranch) {
          this.refresh();
        }
      }),
    );
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
    return e;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
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
    this.view.description = provider.displayName;
    if (!(await provider.isSignedIn())) {
      const item = new vscode.TreeItem(`Sign in to ${provider.kind === 'azure' ? 'Azure DevOps' : 'GitHub'} to see tickets`);
      item.iconPath = new vscode.ThemeIcon('account');
      item.description = provider.displayName;
      item.command = {
        title: 'Sign in',
        command: provider.kind === 'azure' ? 'gitland.switchAzureAccount' : 'gitland.switchGitHubAccount',
      };
      return [item];
    }
    try {
      const [tickets, branch] = await Promise.all([provider.listMyTickets(), repo.currentBranch()]);
      this.lastBranch = branch;
      const currentId = branch ? await repo.getConfig(`branch.${branch}.gitlandTicket`) : undefined;
      this.view.message = tickets.length ? undefined : `No open ${provider.ticketNoun}s assigned to you.`;
      return tickets.map((t) => new TicketItem(t, t.id === currentId));
    } catch (e) {
      log.error(`Loading from ${provider.displayName} failed`, e);
      this.view.message = undefined;
      const item = new vscode.TreeItem(
        e instanceof AuthError ? 'Sign in to load your tickets' : `Failed to load: ${errorMessage(e)}`,
      );
      item.iconPath = new vscode.ThemeIcon(e instanceof AuthError ? 'account' : 'warning');
      item.tooltip = errorMessage(e);
      item.command =
        e instanceof AuthError
          ? { title: 'Sign in', command: provider.kind === 'azure' ? 'gitland.switchAzureAccount' : 'gitland.switchGitHubAccount' }
          : { title: 'Retry', command: 'gitland.tickets.refresh' };
      return [item];
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
