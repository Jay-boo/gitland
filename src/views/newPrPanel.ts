import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { RepoManager } from '../git/repoManager';
import { AvatarService } from '../avatars';
import { getProvider } from '../providers';
import { Provider } from '../providers/types';
import { generatePullRequestText } from '../commitMessage';
import { findPullRequestTemplate } from '../prTemplate';
import { humanize, ticketIdFromBranch, ticketIdsFromMessages } from '../commands/pullRequests';
import { log } from '../log';
import { config, errorMessage } from '../util';
import { createPanel, webviewHtml, webviewOptions, pageIcon } from './webviewHtml';
import { PrPanel } from './prPanel';
import { capture } from '../devCapture';

type Message =
  | { type: 'ready' | 'stopGenerate' }
  | { type: 'target'; target: string }
  | { type: 'generate'; target: string }
  | { type: 'create'; target: string; title: string; description: string; draft: boolean; ticketIds: string[] };

interface LinkedTicket {
  id: string;
  title?: string;
  prefix: string;
  /** 'branch': the ticket the branch was started from; 'commits': mentioned in the commits to merge. */
  from: 'branch' | 'commits';
}

/**
 * "New Pull Request" form in an editor tab: target, title, description from the repository's PR
 * template, ✨ generated from the commits and diff, linked tickets (the branch's, plus every ticket
 * mentioned in the commits to merge, e.g. all the feature PRs in a dev → main release), draft — then
 * push and create.
 */
export class NewPrPanel {
  private static current?: NewPrPanel;
  private generating?: vscode.CancellationTokenSource;

  static async show(context: vscode.ExtensionContext, repos: RepoManager, avatars: AvatarService, repo: Repo): Promise<void> {
    const provider = await getProvider(repo, context.secrets);
    if (!provider) {
      vscode.window.showWarningMessage('Gitland: no Azure DevOps or GitHub remote found for this repository.');
      return;
    }
    const branch = await repo.currentBranch();
    if (!branch) {
      vscode.window.showWarningMessage('Gitland: checkout a branch before creating a pull request.');
      return;
    }
    // Already one: show it instead.
    const existing = await provider
      .listPullRequests()
      .then((prs) => prs.find((p) => p.sourceBranch === branch))
      .catch(() => undefined);
    if (existing) {
      vscode.window.setStatusBarMessage(`Gitland: ${existing.label} already exists for ${branch}`, 4000);
      PrPanel.show(context, repos, avatars, existing.id);
      return;
    }
    NewPrPanel.current?.panel.dispose();
    const panel = createPanel('gitland.newPullRequest', `New pull request · ${branch}`, vscode.ViewColumn.Active, {
      ...webviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    });
    panel.iconPath = pageIcon(context.extensionUri, 'newpr');
    NewPrPanel.current = new NewPrPanel(context, repos, avatars, panel, repo, provider, branch);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly avatars: AvatarService,
    private readonly panel: vscode.WebviewPanel,
    private readonly repo: Repo,
    private readonly provider: Provider,
    private readonly branch: string,
  ) {
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      view: 'newpr',
      title: 'New pull request',
      body: '<main id="page"></main>',
      script: ['md.js', 'newpr.js'],
      styles: ['list.css', 'ticket.css', 'newpr.css'],
      bodyClass: 'ticket-page',
      restore: { kind: 'newPr', repoRoot: repo.root },
    });
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m));
    panel.onDidDispose(() => {
      this.generating?.cancel();
      if (NewPrPanel.current === this) {
        NewPrPanel.current = undefined;
      }
    });
  }

  private post(m: unknown): void {
    capture('newpr', 'message', m);
    this.panel.webview.postMessage(m);
  }

  private get remote(): Promise<string> {
    return this.repo.defaultRemote().then((r) => r ?? 'origin');
  }

  private async ticket(): Promise<{ id: string; title?: string; prefix: string } | undefined> {
    const id = (await this.repo.getConfig(`branch.${this.branch}.gitlandTicket`)) ?? ticketIdFromBranch(this.branch);
    if (!id) {
      return undefined;
    }
    let title = await this.repo.getConfig(`branch.${this.branch}.gitlandTicketTitle`);
    title ??= (await this.provider.getTicket(id).catch(() => undefined))?.title;
    return { id, title, prefix: this.provider.kind === 'github' ? '#' : 'AB#' };
  }

  /**
   * The branch's ticket, then the tickets mentioned in the commits to merge (merge commits included:
   * that is where Azure DevOps writes "Related work items: #12").
   */
  private async linkedTickets(base: string, branchTicket: Awaited<ReturnType<NewPrPanel['ticket']>>): Promise<LinkedTicket[]> {
    const prefix = this.provider.kind === 'github' ? '#' : 'AB#';
    const bodies = await this.repo.exec(['log', '--format=%B%x1e', `${base}..HEAD`]).catch(() => '');
    const ids = ticketIdsFromMessages(bodies.split('\x1e').map((m) => m.trim()).filter(Boolean), this.provider.kind)
      .filter((id) => id !== branchTicket?.id)
      .slice(0, 50);
    const found = await Promise.all(
      ids.map(async (id) => ({ id, ticket: await this.provider.getTicket(id).catch(() => undefined) })),
    );
    return [
      ...(branchTicket ? [{ ...branchTicket, from: 'branch' as const }] : []),
      // An id nobody can resolve is most likely not a ticket ("#1" in a list): leave it out.
      ...found.filter((f) => f.ticket).map((f) => ({ id: f.id, title: f.ticket!.title, prefix, from: 'commits' as const })),
    ];
  }

  /** Everything the form shows for a target branch. */
  private async info(target: string): Promise<unknown> {
    const remote = await this.remote;
    const base = `${remote}/${target}`;
    const [commits, stat, template, ticket, ab] = await Promise.all([
      this.repo.exec(['log', '--no-merges', '--format=%H%x1f%s%x1f%an%x1f%at', `${base}..HEAD`]).catch(() => ''),
      this.repo.exec(['diff', '--numstat', `${base}...HEAD`]).catch(() => ''),
      findPullRequestTemplate(this.repo, remote, target),
      this.ticket(),
      this.repo.aheadBehind(this.branch).catch(() => ({ upstream: undefined, ahead: 0 })),
    ]);
    const list = commits
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, subject, author, date] = l.split('\x1f');
        return { sha, subject, author, date: Number(date) * 1000 };
      });
    let added = 0;
    let deleted = 0;
    const files = stat.split('\n').filter(Boolean);
    for (const f of files) {
      const [a, d] = f.split('\t');
      added += Number(a) || 0;
      deleted += Number(d) || 0;
    }
    return {
      target,
      commits: list,
      files: files.length,
      added,
      deleted,
      template,
      ticket,
      tickets: await this.linkedTickets(base, ticket),
      defaultTitle: ticket?.title ?? (list.length === 1 ? list[0].subject : humanize(this.branch)),
      needsPush: !ab.upstream || ab.ahead > 0,
    };
  }

  private async onMessage(m: Message): Promise<void> {
    try {
      switch (m.type) {
        case 'ready': {
          const remote = await this.remote;
          const [branches, def] = await Promise.all([this.repo.branches(), this.repo.defaultBranch(remote)]);
          const targets = branches
            .filter((b) => b.remote && b.shortName.startsWith(remote + '/'))
            .map((b) => b.shortName.slice(remote.length + 1))
            .filter((b) => b !== this.branch && b !== 'HEAD');
          targets.sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));
          const target = def && targets.includes(def) ? def : targets[0];
          this.post({
            type: 'init',
            source: this.branch,
            targets,
            draft: config('pr.draftByDefault', false),
            noun: this.provider.ticketNoun,
            info: target ? await this.info(target) : undefined,
          });
          return;
        }
        case 'target':
          this.post({ type: 'info', info: await this.info(m.target) });
          return;
        case 'generate':
          return this.generate(m.target);
        case 'stopGenerate':
          this.generating?.cancel();
          return;
        case 'create':
          return this.create(m);
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`);
    }
  }

  private async generate(target: string): Promise<void> {
    this.generating?.cancel();
    const cts = (this.generating = new vscode.CancellationTokenSource());
    const remote = await this.remote;
    const base = `${remote}/${target}`;
    this.post({ type: 'genStart' });
    try {
      const [template, ticket] = await Promise.all([findPullRequestTemplate(this.repo, remote, target), this.ticket()]);
      const out = await generatePullRequestText(
        this.repo,
        { base, head: 'HEAD', source: this.branch, target, template: template?.text, ticket },
        (parts) => this.post({ type: 'genText', ...parts }),
        cts.token,
      );
      this.post({ type: 'genDone', ...out });
    } catch (e) {
      this.post({ type: 'genDone' });
      if (!cts.token.isCancellationRequested) {
        log.error('Pull request generation failed', e);
        vscode.window.showWarningMessage(`Gitland: ${errorMessage(e)}`);
      }
    } finally {
      if (this.generating === cts) {
        this.generating = undefined;
      }
      cts.dispose();
    }
  }

  private async create(m: Extract<Message, { type: 'create' }>): Promise<void> {
    const remote = await this.remote;
    this.post({ type: 'creating', on: true });
    try {
      const pr = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Creating pull request…' },
        async (progress) => {
          const { upstream, ahead } = await this.repo.aheadBehind(this.branch);
          if (!upstream || ahead > 0) {
            progress.report({ message: `pushing ${this.branch}…` });
            await this.repo.push(remote, this.branch, !upstream);
          }
          progress.report({ message: 'creating…' });
          return this.provider.createPullRequest({
            source: this.branch,
            target: m.target,
            title: m.title.trim(),
            description: m.description,
            draft: m.draft,
            ticketIds: m.ticketIds,
            addMeAsReviewer: vscode.workspace.getConfiguration('gitland').get<boolean>('pr.addMeAsReviewer', true),
          });
        },
      );
      vscode.window.setStatusBarMessage(`Gitland: ${pr.label} created`, 4000);
      this.panel.dispose();
      PrPanel.show(this.context, this.repos, this.avatars, pr.id);
      vscode.commands.executeCommand('gitland.prs.refresh');
    } catch (e) {
      this.post({ type: 'creating', on: false });
      throw e;
    }
  }
}
