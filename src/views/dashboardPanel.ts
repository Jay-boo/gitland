import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { AvatarService } from '../avatars';
import { getProvider, signIn } from '../providers';
import { PipelineRun, PullRequest, Ticket } from '../providers/types';
import { log } from '../log';
import { errorMessage } from '../util';
import { createPanel, webviewHtml, webviewOptions, pageIcon } from './webviewHtml';
import { PrPanel } from './prPanel';
import { TicketPanel } from './ticketPanel';
import { capture } from '../devCapture';
import { ticketsSignedIn } from '../providers/ticketOverlay';

type Message =
  | { type: 'ready' | 'refresh' | 'newPr' | 'signIn' }
  | { type: 'ticket'; id: string; org?: string }
  | { type: 'startWork'; id: string }
  | { type: 'pr'; id: string }
  | { type: 'openUrl'; url: string }
  | { type: 'branch'; action: 'checkout' | 'push' | 'pr' | 'delete'; name: string };

/** One page for the day: tickets in progress, my PRs (reviews, CI), PRs to review, my branches. */
export class DashboardPanel {
  private static current?: DashboardPanel;
  private tickets: Ticket[] = [];

  static show(context: vscode.ExtensionContext, repos: RepoManager, avatars: AvatarService): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      DashboardPanel.current.load();
      return;
    }
    const panel = createPanel('gitland.dashboard', 'Gitland Dashboard', vscode.ViewColumn.Active, {
      ...webviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    });
    panel.iconPath = pageIcon(context.extensionUri, 'dashboard');
    DashboardPanel.current = new DashboardPanel(context, repos, avatars, panel);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly avatars: AvatarService,
    private readonly panel: vscode.WebviewPanel,
  ) {
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      view: 'dashboard',
      title: 'Dashboard',
      body: '<main id="page"></main>',
      script: 'dashboard.js',
      styles: ['list.css', 'ticket.css', 'dashboard.css'],
      bodyClass: 'ticket-page',
      restore: { kind: 'dashboard' },
    });
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m).catch((e) => vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`)));
    const sub = repos.onDidChangeRepo(() => panel.visible && this.load());
    panel.onDidDispose(() => {
      sub.dispose();
      DashboardPanel.current = undefined;
    });
  }

  private post(m: unknown): void {
    capture('dashboard', 'message', m);
    this.panel.webview.postMessage(m);
  }

  async load(): Promise<void> {
    const repo = await this.repos.activeRepo(false);
    if (!repo) {
      return this.post({ type: 'error', message: 'No git repository in this workspace.' });
    }
    const provider = await getProvider(repo, this.context.secrets);
    const signedIn = provider ? await provider.isSignedIn().catch(() => false) : false;
    const branchesP = this.branches(repo);
    // Local data first, then the remote parts as they arrive.
    this.post({ type: 'local', repoName: repo.root.split('/').pop(), branches: await branchesP, signedIn, remote: provider?.displayName });
    if (!provider || !signedIn) {
      return;
    }
    const [tickets, prs, runs] = await Promise.all([
      // Tickets may come from Jira: only when signed in there, so the dashboard never prompts.
      (await ticketsSignedIn(provider))
        ? provider.listMyTickets().catch((e) => (log.info(`Dashboard: tickets (${errorMessage(e)})`), [] as Ticket[]))
        : ([] as Ticket[]),
      provider.listPullRequests().catch((e) => (log.info(`Dashboard: PRs (${errorMessage(e)})`), [] as PullRequest[])),
      provider.pipelineRuns ? provider.pipelineRuns({ max: 100 }).catch(() => [] as PipelineRun[]) : Promise.resolve([] as PipelineRun[]),
    ]);
    this.tickets = tickets;
    // CI of a PR: its merge build (Azure DevOps refs/pull/<id>/merge) or the source branch.
    const ciOf = (p: PullRequest) => runs.find((r) => r.branch === `refs/pull/${p.id}/merge`) ?? runs.find((r) => r.branch === p.sourceBranch);
    const avatars: Record<string, string> = {};
    this.post({
      type: 'remote',
      tickets,
      prs: prs.map((p) => ({ ...p, ci: ciOf(p) })),
      branchCi: Object.fromEntries((await branchesP).map((b) => [b.name, runs.find((r) => r.branch === b.name)]).filter(([, r]) => r)),
      avatars,
      noun: provider.ticketNoun,
    });
  }

  /** Local branches with what needs attention: not pushed, ahead / behind, merged, their ticket. */
  private async branches(repo: Repo) {
    const FS = '\x1f';
    const remote = (await repo.defaultRemote()) ?? 'origin';
    const def = (await repo.defaultBranch(remote)) ?? 'main';
    const [out, merged, current] = await Promise.all([
      repo.exec(['for-each-ref', '--sort=-committerdate', `--format=%(refname:short)${FS}%(upstream:short)${FS}%(upstream:track)${FS}%(committerdate:unix)${FS}%(contents:subject)`, 'refs/heads']),
      repo.exec(['branch', '--merged', `${remote}/${def}`, '--format=%(refname:short)']).catch(() => ''),
      repo.currentBranch(),
    ]);
    const mergedSet = new Set(merged.split('\n').map((s) => s.trim()).filter(Boolean));
    const list = out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, upstream, track, date, subject] = l.split(FS);
        const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
        const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
        return { name, upstream: upstream || undefined, gone: track.includes('gone'), ahead, behind, date: Number(date) * 1000, subject, merged: mergedSet.has(name) && name !== def, current: name === current, isDefault: name === def };
      })
      .slice(0, 25);
    await Promise.all(
      list.map(async (b) => {
        const id = await repo.getConfig(`branch.${b.name}.gitlandTicket`);
        Object.assign(b, { ticket: id, ticketTitle: id ? await repo.getConfig(`branch.${b.name}.gitlandTicketTitle`) : undefined });
      }),
    );
    return list as (typeof list[number] & { ticket?: string; ticketTitle?: string })[];
  }

  private async onMessage(m: Message): Promise<void> {
    const repo = await this.repos.activeRepo(false);
    switch (m.type) {
      case 'ready':
      case 'refresh':
        return this.load();
      case 'signIn': {
        const provider = repo && (await getProvider(repo, this.context.secrets));
        await vscode.commands.executeCommand(signIn(provider?.kind ?? 'azure').command);
        return this.load();
      }
      case 'ticket':
        return TicketPanel.show(this.context, this.repos, m.id, m.org);
      case 'startWork': {
        const ticket = this.tickets.find((t) => t.id === m.id);
        if (ticket) {
          await vscode.commands.executeCommand('gitland.tickets.startWork', { ticket });
        }
        return this.load();
      }
      case 'pr':
        PrPanel.show(this.context, this.repos, this.avatars, m.id);
        return;
      case 'newPr':
        await vscode.commands.executeCommand('gitland.prs.create');
        return;
      case 'openUrl':
        await vscode.commands.executeCommand('gitland.openLink', m.url);
        return;
      case 'branch':
        if (!repo) {
          return;
        }
        if (m.action === 'checkout') {
          await repo.checkout(m.name);
        } else if (m.action === 'push') {
          const remote = (await repo.defaultRemote()) ?? 'origin';
          const { upstream } = await repo.aheadBehind(m.name);
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pushing ${m.name}…` }, () => repo.push(remote, m.name, !upstream));
        } else if (m.action === 'pr') {
          if ((await repo.currentBranch()) !== m.name) {
            await repo.checkout(m.name);
          }
          await vscode.commands.executeCommand('gitland.prs.create', repo.root);
          return;
        } else if (m.action === 'delete') {
          if ((await vscode.window.showWarningMessage(`Delete the merged branch ${m.name}?`, { modal: true }, 'Delete')) === 'Delete') {
            await repo.exec(['branch', '-d', m.name]);
          }
        }
        return this.load();
    }
  }
}
