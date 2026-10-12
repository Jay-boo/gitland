import * as vscode from 'vscode';
import { RepoManager } from '../git/repoManager';
import { AvatarService } from '../avatars';
import { getProvider } from '../providers';
import { Provider, PullRequestDetails, ReviewVote } from '../providers/types';
import { checkoutPullRequest } from '../commands/pullRequests';
import { log } from '../log';
import { errorMessage } from '../util';
import { createPanel, webviewHtml, webviewOptions, pageIcon } from './webviewHtml';
import { ComparePanel } from './comparePanel';
import { TicketPanel } from './ticketPanel';

type Message =
  | { type: 'ready' | 'refresh' | 'checkout' | 'open' | 'copy' | 'files' }
  | { type: 'openUrl'; url: string }
  | { type: 'showCommit'; sha: string }
  | { type: 'showTicket'; id: string }
  | { type: 'vote'; vote: ReviewVote }
  | { type: 'requestReview' }
  | { type: 'comment'; text: string; threadId?: string }
  | { type: 'resolve'; threadId: string; resolved: boolean }
  | { type: 'publish' | 'abandon' | 'complete' };

/** A pull request in an editor tab: description, reviewers and votes, work items, commits, discussion. */
export class PrPanel {
  private static readonly panels = new Map<string, PrPanel>();
  private details?: PullRequestDetails;

  static show(context: vscode.ExtensionContext, repos: RepoManager, avatars: AvatarService, id: string): void {
    const open = PrPanel.panels.get(id);
    if (open) {
      open.panel.reveal();
      open.load();
      return;
    }
    const panel = createPanel('gitland.pullRequest', `PR ${id}`, vscode.ViewColumn.Active, {
      ...webviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    });
    panel.iconPath = pageIcon(context.extensionUri, 'pr');
    PrPanel.panels.set(id, new PrPanel(context, repos, avatars, panel, id));
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly avatars: AvatarService,
    private readonly panel: vscode.WebviewPanel,
    private readonly id: string,
  ) {
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      title: `PR ${id}`,
      body: '<main id="page"></main>',
      script: ['md.js', 'pr.js'],
      styles: ['list.css', 'ticket.css', 'pr.css'],
      bodyClass: 'ticket-page',
      restore: { kind: 'pr', id },
    });
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m));
    panel.onDidDispose(() => PrPanel.panels.delete(id));
  }

  private post(m: unknown): void {
    this.panel.webview.postMessage(m);
  }

  private async load(): Promise<void> {
    const repo = await this.repos.activeRepo(false);
    const provider = repo && (await getProvider(repo, this.context.secrets));
    if (!repo || !provider?.getPullRequestDetails) {
      return this.post({ type: 'error', message: 'Open a repository with an Azure DevOps or GitHub remote.' });
    }
    this.post({ type: 'loading' });
    try {
      const [d, current] = await Promise.all([provider.getPullRequestDetails(this.id), repo.currentBranch()]);
      this.details = d;
      this.panel.title = `${d.pr.label} ${d.pr.title}`;
      this.post({
        type: 'details',
        details: d,
        current,
        prefix: provider.kind === 'github' ? '#' : 'AB#',
        can: { vote: !!provider.votePullRequest, requestReview: !!provider.requestMyReview, comment: !!provider.commentPullRequest, resolve: !!provider.resolveThread, update: !!provider.updatePullRequest, kind: provider.kind },
      });
      provider
        .pipelineRuns?.({ prId: this.id, max: 20 })
        .then((runs) => this.post({ type: 'checks', runs }))
        .catch((e) => log.info(`PR ${this.id}: checks unavailable (${errorMessage(e)})`));
    } catch (e) {
      log.error(`Pull request ${this.id} failed to load`, e);
      this.post({ type: 'error', message: errorMessage(e) });
    }
  }

  /** Votes, comments and status changes, straight from the page. */
  private async review(provider: Provider, d: PullRequestDetails, m: Message): Promise<void> {
    switch (m.type) {
      case 'vote':
        await provider.votePullRequest!(this.id, m.vote);
        vscode.window.setStatusBarMessage(`Gitland: vote sent on ${d.pr.label}`, 3000);
        return;
      case 'requestReview':
        await provider.requestMyReview!(this.id);
        vscode.window.setStatusBarMessage(`Gitland: you are now a reviewer of ${d.pr.label}`, 3000);
        vscode.commands.executeCommand('gitland.prs.refresh');
        return;
      case 'comment':
        if (m.text.trim()) {
          await provider.commentPullRequest!(this.id, m.text.trim(), m.threadId);
        }
        return;
      case 'resolve':
        await provider.resolveThread!(this.id, m.threadId, m.resolved);
        return;
      case 'publish':
        await provider.updatePullRequest!(this.id, { publish: true });
        return;
      case 'abandon':
        if ((await vscode.window.showWarningMessage(`Abandon ${d.pr.label} "${d.pr.title}"?`, { modal: true }, 'Abandon')) === 'Abandon') {
          await provider.updatePullRequest!(this.id, { abandon: true });
        }
        return;
      case 'complete': {
        if (!d.lastSourceCommit) {
          throw new Error('The last commit of the source branch is unknown: refresh and retry.');
        }
        const strategy = await vscode.window.showQuickPick(
          [
            { label: '$(git-merge) Squash commit', description: 'one commit on the target', value: 'squash' as const },
            { label: '$(git-merge) Merge (no fast-forward)', description: 'keep the commits and a merge commit', value: 'noFastForward' as const },
            { label: '$(git-compare) Rebase and fast-forward', description: 'replay the commits, no merge commit', value: 'rebase' as const },
            ...(provider.kind === 'azure' ? [{ label: '$(git-compare) Semi-linear merge', description: 'rebase, then a merge commit', value: 'rebaseMerge' as const }] : []),
          ],
          { title: `Complete ${d.pr.label} into ${d.pr.targetBranch}`, placeHolder: 'Merge strategy' },
        );
        if (!strategy) {
          return;
        }
        const del = await vscode.window.showQuickPick(
          [
            { label: `$(trash) Delete ${d.pr.sourceBranch} after merging`, value: true },
            { label: `$(git-branch) Keep ${d.pr.sourceBranch}`, value: false },
          ],
          { title: `Complete ${d.pr.label}`, placeHolder: 'Source branch' },
        );
        if (!del) {
          return;
        }
        // Azure DevOps: close the work items or leave them open (e.g. merged into dev, closed on the
        // release to main). The merge commit lists them like the web UI does, so the next PR (dev → main)
        // finds them in its commits.
        const ids = d.workItems.map((w) => w.id);
        let transition = false;
        if (provider.kind === 'azure' && ids.length) {
          const list = ids.map((id) => `#${id}`).join(', ');
          const close = { label: `$(pass) Complete the linked work items`, description: list, value: true };
          const keep = { label: `$(circle-large-outline) Leave them open`, description: 'close them later, e.g. on the release PR', value: false };
          const release = /^(main|master|prod|production|release(\/.*)?)$/i.test(d.pr.targetBranch);
          const pick = await vscode.window.showQuickPick(release ? [close, keep] : [keep, close], {
            title: `Complete ${d.pr.label}`,
            placeHolder: `Work items: ${list}`,
          });
          if (!pick) {
            return;
          }
          transition = pick.value;
        }
        const related = provider.kind === 'azure' && ids.length ? `\n\nRelated work items: ${ids.map((id) => `#${id}`).join(', ')}` : '';
        await provider.updatePullRequest!(this.id, {
          complete: {
            strategy: strategy.value,
            deleteSourceBranch: del.value,
            lastSourceCommit: d.lastSourceCommit,
            message: `Merged PR ${this.id}: ${d.pr.title}${related}`,
            transitionWorkItems: transition,
          },
        });
        vscode.window.showInformationMessage(`Gitland: ${d.pr.label} completed.`);
        vscode.commands.executeCommand('gitland.prs.refresh');
        return;
      }
    }
  }

  private async onMessage(m: Message): Promise<void> {
    const d = this.details;
    const repo = await this.repos.activeRepo(false);
    try {
      switch (m.type) {
        case 'ready':
        case 'refresh':
          return this.load();
        case 'checkout':
          if (d && repo) {
            await checkoutPullRequest(repo, d.pr);
            await this.load();
          }
          return;
        case 'open':
          if (d) {
            await vscode.env.openExternal(vscode.Uri.parse(d.pr.url));
          }
          return;
        case 'copy':
          if (d) {
            await vscode.env.clipboard.writeText(d.pr.url);
            vscode.window.setStatusBarMessage('Gitland: link copied', 2000);
          }
          return;
        case 'files':
          if (d && repo) {
            // What the PR brings: from where it forked off the target, to the source branch.
            const remote = (await repo.defaultRemote()) ?? 'origin';
            await repo.exec(['fetch', remote, d.pr.sourceBranch, d.pr.targetBranch]).catch(() => undefined);
            const source = `${remote}/${d.pr.sourceBranch}`;
            const base = (await repo.exec(['merge-base', `${remote}/${d.pr.targetBranch}`, source]).catch(() => '')).trim();
            await ComparePanel.show(this.context, this.repos, this.avatars, repo, base || `${remote}/${d.pr.targetBranch}`, source, false, {
              tab: 'files',
              key: `pr:${d.pr.url}`,
              title: `${d.pr.label} · files changed`,
            });
          }
          return;
        case 'openUrl':
          if (/^https:\/\//.test(m.url)) {
            await vscode.env.openExternal(vscode.Uri.parse(m.url));
          }
          return;
        case 'showCommit':
          await vscode.commands.executeCommand('gitland.showGraph', { repoRoot: repo?.root, sha: m.sha });
          return;
        case 'showTicket':
          await TicketPanel.show(this.context, this.repos, m.id);
          return;
        case 'vote':
        case 'requestReview':
        case 'comment':
        case 'resolve':
        case 'publish':
        case 'abandon':
        case 'complete': {
          const provider = repo && (await getProvider(repo, this.context.secrets));
          if (provider && d) {
            await this.review(provider, d, m);
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
