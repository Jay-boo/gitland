import * as vscode from 'vscode';
import { RepoManager } from '../git/repoManager';
import { getProvider, signIn } from '../providers';
import { AuthError, Ticket } from '../providers/types';
import { log } from '../log';
import { errorMessage } from '../util';
import { webviewHtml, webviewOptions } from './webviewHtml';
import { capture } from '../devCapture';

/** What the ticket commands receive (from the webview, or the command palette). */
export interface TicketItem {
  ticket: Ticket;
}

type Message =
  | { type: 'ready' | 'refresh' | 'startById' | 'sources' | 'signIn' }
  | { type: 'start' | 'open' | 'copy' | 'show'; id: string };

/** "My Tickets": your open work items / issues, in the Gitland style. Click one to start working on it. */
export class TicketsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'gitland.tickets';
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private lastBranch?: string;
  private tickets: Ticket[] = [];
  private signInCommand = 'gitland.switchAzureAccount';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(TicketsView.viewId, this),
      repos.onDidChangeRepo(async (r) => {
        const b = await r.currentBranch();
        if (b !== this.lastBranch) {
          this.refresh();
        }
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.context.extensionUri);
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri, {
      view: 'tickets',
      title: 'My Tickets',
      body: LIST_BODY('Filter tickets'),
      script: 'tickets.js',
      styles: ['list.css'],
      bodyClass: 'list',
    });
    view.webview.onDidReceiveMessage((m: Message) => this.onMessage(m), undefined, this.disposables);
    view.onDidChangeVisibility(() => view.visible && this.refresh(), undefined, this.disposables);
  }

  refresh(): void {
    this.load().catch((e) => log.error('Tickets: refresh failed', e));
  }

  private post(m: unknown): void {
    capture('tickets', 'message', m);
    this.view?.webview.postMessage(m);
  }

  private async load(): Promise<void> {
    if (!this.view) {
      return;
    }
    const repo = await this.repos.activeRepo(false);
    if (!repo) {
      return this.post({ type: 'state', state: 'empty', title: 'No git repository', text: 'Open a folder with an Azure DevOps, GitHub or GitLab remote.' });
    }
    const provider = await getProvider(repo, this.secrets);
    if (!provider) {
      return this.post({ type: 'state', state: 'empty', title: 'No Azure DevOps, GitHub or GitLab remote', text: 'Tickets come from the remote of this repository.' });
    }
    this.signInCommand = signIn(provider.kind).command;
    const source = provider.ticketSourceLabel ?? provider.displayName;
    this.view.description = source;
    if (!(await provider.isSignedIn())) {
      return this.post({ type: 'state', state: 'signin', title: `Sign in to ${signIn(provider.kind).host}`, text: `to see your ${provider.ticketNoun}s` });
    }
    this.post({ type: 'loading' });
    try {
      const [tickets, branch] = await Promise.all([provider.listMyTickets(), repo.currentBranch()]);
      this.lastBranch = branch;
      this.tickets = tickets;
      const currentId = branch ? await repo.getConfig(`branch.${branch}.gitlandTicket`) : undefined;
      this.post({ type: 'tickets', tickets, currentId, source, noun: provider.ticketNoun, multiSource: new Set(tickets.map((t) => t.project)).size > 1 });
    } catch (e) {
      log.error(`Loading from ${source} failed`, e);
      this.post(
        e instanceof AuthError
          ? { type: 'state', state: 'signin', title: 'Sign in to load your tickets', text: errorMessage(e) }
          : { type: 'state', state: 'error', title: 'Could not load the tickets', text: errorMessage(e) },
      );
    }
  }

  private async onMessage(m: Message): Promise<void> {
    const ticket = 'id' in m ? this.tickets.find((t) => t.id === m.id) : undefined;
    switch (m.type) {
      case 'ready':
      case 'refresh':
        return this.refresh();
      case 'startById':
        await vscode.commands.executeCommand('gitland.tickets.startWorkById');
        return;
      case 'sources':
        await vscode.commands.executeCommand('gitland.tickets.sources');
        return;
      case 'signIn':
        await vscode.commands.executeCommand(this.signInCommand);
        return this.refresh();
      case 'start':
        if (ticket) {
          await vscode.commands.executeCommand('gitland.tickets.startWork', { ticket } satisfies TicketItem);
        }
        return;
      case 'show':
        if (ticket) {
          await vscode.commands.executeCommand('gitland.tickets.show', { ticket } satisfies TicketItem);
        }
        return;
      case 'open':
        if (ticket) {
          await vscode.env.openExternal(vscode.Uri.parse(ticket.url));
        }
        return;
      case 'copy':
        if (ticket) {
          await vscode.env.clipboard.writeText(ticket.id);
          vscode.window.setStatusBarMessage(`Gitland: #${ticket.id} copied`, 2000);
        }
        return;
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Shared list page: a filter box and the list (tickets and pull requests). */
export const LIST_BODY = (placeholder: string) => `<header class="lv-head">
  <label class="search"><i class="codicon codicon-filter"></i><input id="filter" type="search" placeholder="${placeholder}" spellcheck="false" /></label>
</header>
<main id="list"></main>`;

/** Codicon of a ticket type (quick picks). */
export function ticketIcon(type: string): vscode.ThemeIcon {
  const t = type.toLowerCase();
  return new vscode.ThemeIcon(
    t.includes('bug') ? 'bug' : t.includes('task') ? 'tasklist' : t.includes('story') || t.includes('backlog') ? 'book' : t.includes('feature') ? 'star-full' : t.includes('epic') ? 'rocket' : 'issues',
  );
}
