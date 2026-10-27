import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { getProvider } from '../providers';
import { Ticket, TicketDetails } from '../providers/types';
import { log } from '../log';
import { errorMessage } from '../util';
import { createPanel, webviewHtml, webviewOptions, pageIcon } from './webviewHtml';
import { capture } from '../devCapture';

type Message =
  | { type: 'ready' | 'refresh' | 'start' | 'open' | 'copy' }
  | { type: 'openUrl'; url: string }
  | { type: 'showCommit'; sha: string }
  | { type: 'checkout'; branch: string }
  | { type: 'showTicket'; id: string }
  | { type: 'setState'; state: string }
  | { type: 'assign' }
  | { type: 'comment'; text: string };

/**
 * A ticket in an editor tab, in the Gitland style: description, acceptance criteria, comments,
 * linked pull requests, the branches and commits of this repository that reference it.
 */
export class TicketPanel {
  private static readonly panels = new Map<string, TicketPanel>();
  private details?: TicketDetails;

  static async show(context: vscode.ExtensionContext, repos: RepoManager, id: string, org?: string): Promise<void> {
    const open = TicketPanel.panels.get(id);
    if (open) {
      open.panel.reveal();
      return;
    }
    const panel = createPanel('gitland.ticket', `#${id}`, vscode.ViewColumn.Active, {
      ...webviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    });
    panel.iconPath = pageIcon(context.extensionUri, 'ticket');
    TicketPanel.panels.set(id, new TicketPanel(context, repos, panel, id, org));
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly panel: vscode.WebviewPanel,
    private readonly id: string,
    private readonly org?: string,
  ) {
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      view: 'ticket',
      title: `#${id}`,
      body: '<main id="page"></main>',
      script: ['md.js', 'ticket.js'],
      styles: ['list.css', 'ticket.css'],
      bodyClass: 'ticket-page',
      restore: { kind: 'ticket', id, org },
    });
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m));
    panel.onDidDispose(() => TicketPanel.panels.delete(id));
  }

  private post(m: unknown): void {
    capture('ticket', 'message', m);
    this.panel.webview.postMessage(m);
  }

  private async load(): Promise<void> {
    const repo = await this.repos.activeRepo(false);
    const provider = repo && (await getProvider(repo, this.context.secrets));
    if (!repo || !provider?.getTicketDetails) {
      return this.post({ type: 'error', message: 'Open a repository with an Azure DevOps, GitHub or GitLab remote to see its tickets.' });
    }
    this.post({ type: 'loading' });
    try {
      const [details, local, current, me] = await Promise.all([
        provider.getTicketDetails(this.id, this.org),
        this.localWork(repo, this.id),
        repo.currentBranch(),
        repo.getConfig('user.name').catch(() => undefined),
      ]);
      if (!details) {
        return this.post({ type: 'error', message: `${provider.ticketNoun} #${this.id} was not found.` });
      }
      this.details = details;
      this.panel.title = `#${this.id} ${details.ticket.title}`;
      const org = this.org ?? details.ticket.org;
      const states = provider.ticketStates
        ? await provider.ticketStates(this.id, org).catch((e) => {
            log.error(`Ticket #${this.id}: could not list its states`, e);
            return undefined;
          })
        : undefined;
      const assignee = details.ticket.assignee?.toLowerCase();
      this.post({
        type: 'details',
        details,
        ...local,
        current,
        prefix: provider.kind === 'github' || provider.kind === 'gitlab' ? '#' : 'AB#',
        noun: provider.ticketNoun,
        states: provider.setTicketState ? states?.map((x) => x.name) : undefined,
        canAssign: !!provider.assignTicketToMe && !(assignee && me && assignee.includes(me.toLowerCase())),
        canComment: !!provider.commentTicket,
      });
    } catch (e) {
      log.error(`Ticket #${this.id} failed to load`, e);
      this.post({ type: 'error', message: errorMessage(e) });
    }
  }

  /** Branches started for the ticket and commits that mention it, in this repository. */
  private async localWork(repo: Repo, id: string): Promise<{ branches: string[]; commits: { sha: string; short: string; author: string; date: number; subject: string }[] }> {
    const [cfg, log] = await Promise.all([
      repo.exec(['config', '--get-regexp', '^branch\\..*\\.gitlandticket$']).catch(() => ''),
      repo
        .exec(['log', '--all', '-n', '30', '-E', `--grep=(AB)?#${id}([^0-9]|$)`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s'])
        .catch(() => ''),
    ]);
    const branches = cfg
      .split('\n')
      .map((l) => /^branch\.(.+)\.gitlandticket (\S+)$/i.exec(l.trim()))
      .filter((m): m is RegExpExecArray => !!m && m[2] === id)
      .map((m) => m[1]);
    const commits = log
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, short, author, date, subject] = l.split('\x1f');
        return { sha, short, author, date: Number(date) * 1000, subject };
      });
    return { branches, commits };
  }

  private async onMessage(m: Message): Promise<void> {
    const ticket: Ticket | undefined = this.details?.ticket;
    try {
      switch (m.type) {
        case 'ready':
        case 'refresh':
          return this.load();
        case 'start':
          if (ticket) {
            await vscode.commands.executeCommand('gitland.tickets.startWork', { ticket });
            await this.load();
          }
          return;
        case 'open':
          if (ticket) {
            await vscode.env.openExternal(vscode.Uri.parse(ticket.url));
          }
          return;
        case 'copy':
          await vscode.env.clipboard.writeText(this.id);
          vscode.window.setStatusBarMessage(`Gitland: #${this.id} copied`, 2000);
          return;
        case 'openUrl':
          await vscode.commands.executeCommand('gitland.openLink', m.url);
          return;
        case 'showCommit': {
          const repo = await this.repos.activeRepo(false);
          await vscode.commands.executeCommand('gitland.showGraph', { repoRoot: repo?.root, sha: m.sha });
          return;
        }
        case 'checkout': {
          const repo = await this.repos.activeRepo(false);
          if (repo) {
            await repo.checkout(m.branch);
            await this.load();
          }
          return;
        }
        case 'showTicket':
          await TicketPanel.show(this.context, this.repos, m.id, this.org);
          return;
        case 'setState':
        case 'assign':
        case 'comment': {
          const repo = await this.repos.activeRepo(false);
          const provider = repo && (await getProvider(repo, this.context.secrets));
          const org = this.org ?? ticket?.org;
          if (!provider) {
            return;
          }
          try {
            if (m.type === 'setState') {
              await provider.setTicketState?.(this.id, m.state, org);
            } else if (m.type === 'assign') {
              await provider.assignTicketToMe?.(this.id, org);
            } else if (m.text.trim()) {
              await provider.commentTicket?.(this.id, m.text, org);
            }
          } finally {
            // Also after a failure: the page shows the ticket as it really is (state, comment box enabled again).
            await this.load();
          }
          return;
        }
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`);
    }
  }
}
