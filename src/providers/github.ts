import * as vscode from 'vscode';
import { AuthError, CreatePullRequestOptions, Provider, PullRequest, Ticket, TicketDetails, PullRequestDetails, PipelineRun, ReviewVote } from './types';

export const GITHUB_SCOPES = ['repo'];

interface GhIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  labels: ({ name?: string } | string)[];
  assignee?: { login: string } | null;
  pull_request?: unknown;
}

interface GhPull {
  number: number;
  title: string;
  html_url: string;
  draft?: boolean;
  created_at?: string;
  user: { login: string };
  head: { ref: string };
  base: { ref: string };
  requested_reviewers?: { login: string }[];
}

export class GitHubProvider implements Provider {
  readonly kind = 'github' as const;
  readonly ticketNoun = 'issue';
  private login?: Promise<string>;

  constructor(private readonly owner: string, private readonly repo: string) {}

  get displayName(): string {
    return `GitHub · ${this.owner}/${this.repo}`;
  }

  private get webUrl(): string {
    return `https://github.com/${this.owner}/${this.repo}`;
  }

  commitUrl(sha: string): string {
    return `${this.webUrl}/commit/${sha}`;
  }

  branchUrl(branch: string): string {
    return `${this.webUrl}/tree/${encodeURIComponent(branch)}`;
  }

  ticketUrl(id: number | string): string {
    return `${this.webUrl}/issues/${id}`;
  }

  pullRequestUrl(id: number | string): string {
    return `${this.webUrl}/pull/${id}`;
  }

  async isSignedIn(): Promise<boolean> {
    return !!(await vscode.authentication.getSession('github', GITHUB_SCOPES, { silent: true }));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const session = await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true });
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gitland-vscode',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      throw new AuthError('GitHub rejected the credentials. Run "Gitland: Switch GitHub Account".');
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const data = (await res.json()) as { message?: string; errors?: { message?: string }[] };
        msg = [data.message, ...(data.errors ?? []).map((x) => x.message)].filter(Boolean).join(' – ') || msg;
      } catch {
        /* ignore */
      }
      throw new Error(`GitHub: ${msg}`);
    }
    return (await res.json()) as T;
  }

  async avatarFor(_email: string, sha?: string): Promise<string | undefined> {
    if (!sha) {
      return undefined;
    }
    const c = await this.request<{ author?: { avatar_url?: string } | null }>('GET', `/repos/${this.owner}/${this.repo}/commits/${sha}`);
    return c.author?.avatar_url ? `${c.author.avatar_url}${c.author.avatar_url.includes('?') ? '&' : '?'}s=64` : undefined;
  }

  private me(): Promise<string> {
    this.login ??= this.request<{ login: string }>('GET', '/user').then((u) => u.login);
    this.login.catch(() => (this.login = undefined));
    return this.login;
  }

  private toTicket(i: GhIssue): Ticket {
    const labels = i.labels.map((l) => (typeof l === 'string' ? l : l.name ?? ''));
    const type = labels.some((l) => /bug/i.test(l)) ? 'Bug' : 'Issue';
    return {
      id: String(i.number),
      title: i.title,
      type,
      state: i.state,
      url: i.html_url,
      assignee: i.assignee?.login,
    };
  }

  private async search(q: string): Promise<Ticket[]> {
    const data = await this.request<{ items: GhIssue[] }>(
      'GET',
      `/search/issues?per_page=50&q=${encodeURIComponent(`repo:${this.owner}/${this.repo} is:issue ${q}`)}`,
    );
    return data.items.map((i) => this.toTicket(i));
  }

  listMyTickets(): Promise<Ticket[]> {
    return this.search('is:open assignee:@me');
  }

  async searchTickets(text: string): Promise<Ticket[]> {
    const trimmed = text.trim().replace(/^#/, '');
    if (/^\d+$/.test(trimmed)) {
      const t = await this.getTicket(trimmed);
      return t ? [t] : [];
    }
    return this.search(`is:open ${trimmed}`);
  }

  async getTicketDetails(id: string): Promise<TicketDetails | undefined> {
    const base = `/repos/${this.owner}/${this.repo}/issues/${encodeURIComponent(id)}`;
    const i = await this.request<GhIssue & { body?: string; user?: { login: string }; created_at?: string; updated_at?: string; milestone?: { title: string } | null }>('GET', base);
    if (i.pull_request) {
      return undefined;
    }
    const comments = await this.request<{ body: string; user: { login: string }; created_at: string }[]>('GET', `${base}/comments?per_page=50`).catch(() => []);
    const labels = i.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean);
    return {
      ticket: this.toTicket(i),
      format: 'markdown',
      description: i.body || undefined,
      sections: [],
      fields: [
        ['Opened by', i.user?.login],
        ['Milestone', i.milestone?.title],
      ]
        .filter(([, v]) => v)
        .map(([label, value]) => ({ label: label!, value: value! })),
      tags: labels,
      comments: comments.reverse().map((c) => ({ author: c.user.login, date: Date.parse(c.created_at), body: c.body })),
      pullRequests: [],
      related: [],
      changed: i.updated_at ? Date.parse(i.updated_at) : undefined,
    };
  }

  async getTicket(id: string): Promise<Ticket | undefined> {
    try {
      const i = await this.request<GhIssue>('GET', `/repos/${this.owner}/${this.repo}/issues/${encodeURIComponent(id)}`);
      return i.pull_request ? undefined : this.toTicket(i);
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      return undefined;
    }
  }

  async listPullRequests(): Promise<PullRequest[]> {
    const [pulls, me] = await Promise.all([
      this.request<GhPull[]>('GET', `/repos/${this.owner}/${this.repo}/pulls?state=open&per_page=100`),
      this.me().catch(() => ''),
    ]);
    return pulls.map((p) => this.toPullRequest(p, me));
  }

  private toPullRequest(p: GhPull, me: string): PullRequest {
    let group: PullRequest['group'] = 'other';
    if (p.user.login === me) {
      group = 'mine';
    } else if (p.requested_reviewers?.some((r) => r.login === me)) {
      group = 'review';
    }
    return {
      id: String(p.number),
      label: `#${p.number}`,
      title: p.title,
      sourceBranch: p.head.ref,
      targetBranch: p.base.ref,
      author: p.user.login,
      url: p.html_url,
      isDraft: !!p.draft,
      group,
      created: p.created_at ? Date.parse(p.created_at) : undefined,
      // GitHub drops you from requested_reviewers once you have reviewed.
      needsMyReview: !!p.requested_reviewers?.some((r) => r.login === me),
    };
  }

  async getPullRequestDetails(id: string): Promise<PullRequestDetails> {
    const base = `/repos/${this.owner}/${this.repo}`;
    const [p, me, reviews, comments, commits] = await Promise.all([
      this.request<GhPull & { body?: string; state: string; merged?: boolean; mergeable_state?: string }>('GET', `${base}/pulls/${encodeURIComponent(id)}`),
      this.me().catch(() => ''),
      this.request<{ user: { login: string }; state: string }[]>('GET', `${base}/pulls/${encodeURIComponent(id)}/reviews?per_page=100`).catch(() => []),
      this.request<{ user: { login: string }; created_at: string; body: string }[]>('GET', `${base}/issues/${encodeURIComponent(id)}/comments?per_page=100`).catch(() => []),
      this.request<{ sha: string; commit: { message: string; author: { name: string; date: string } } }[]>('GET', `${base}/pulls/${encodeURIComponent(id)}/commits?per_page=100`).catch(() => []),
    ]);
    const latest = new Map<string, string>();
    for (const r of reviews) {
      if (r.state !== 'COMMENTED') {
        latest.set(r.user.login, r.state);
      }
    }
    const reviewers: PullRequestDetails['reviewers'] = [
      ...[...latest].map(([name, state]) => ({ name, vote: state === 'APPROVED' ? ('approved' as const) : state === 'CHANGES_REQUESTED' ? ('rejected' as const) : ('none' as const) })),
      ...(p.requested_reviewers ?? []).filter((r) => !latest.has(r.login)).map((r) => ({ name: r.login, vote: 'none' as const })),
    ];
    const pr = this.toPullRequest(p, me);
    pr.review = reviewers.some((r) => r.vote === 'rejected') ? 'changes' : reviewers.some((r) => r.vote === 'approved') ? 'approved' : 'waiting';
    return {
      pr,
      status: p.merged ? 'merged' : p.state,
      description: p.body || undefined,
      mergeStatus: p.mergeable_state,
      reviewers,
      workItems: [...(p.body ?? '').matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map((m) => ({ id: m[1], url: this.ticketUrl(m[1]) })),
      commits: commits.map((c) => ({ sha: c.sha, subject: c.commit.message.split('\n')[0], author: c.commit.author.name, date: Date.parse(c.commit.author.date) })),
      comments: comments.map((c) => ({ author: c.user.login, date: Date.parse(c.created_at), body: c.body })),
      amReviewer: latest.has(me) || !!p.requested_reviewers?.some((r) => r.login === me),
      myVote: latest.has(me) ? (latest.get(me) === 'APPROVED' ? 'approved' : latest.get(me) === 'CHANGES_REQUESTED' ? 'rejected' : 'none') : undefined,
      lastSourceCommit: (p as unknown as { head: { sha?: string } }).head.sha,
    };
  }

  async pipelineRuns(o: { prId?: string; max?: number }): Promise<PipelineRun[]> {
    const base = `/repos/${this.owner}/${this.repo}`;
    let branch: string | undefined;
    if (o.prId) {
      branch = (await this.request<GhPull>('GET', `${base}/pulls/${encodeURIComponent(o.prId)}`)).head.ref;
    }
    const data = await this.request<{
      workflow_runs: { name: string; status: string; conclusion: string | null; html_url: string; head_sha: string; head_branch: string; updated_at: string }[];
    }>('GET', `${base}/actions/runs?per_page=${o.max ?? 60}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`);
    return data.workflow_runs.map((r) => ({
      name: r.name,
      state:
        r.status === 'in_progress' ? 'running'
        : r.status !== 'completed' ? 'queued'
        : r.conclusion === 'success' ? 'succeeded'
        : r.conclusion === 'cancelled' || r.conclusion === 'skipped' ? 'canceled'
        : 'failed',
      url: r.html_url,
      sha: r.head_sha,
      branch: r.head_branch,
      finished: r.status === 'completed' ? Date.parse(r.updated_at) : undefined,
    }));
  }

  async votePullRequest(id: string, vote: ReviewVote, comment?: string): Promise<void> {
    if (vote === 'reset' || vote === 'wait') {
      throw new Error('GitHub has no such review state: approve, request changes or comment.');
    }
    const event = vote === 'reject' ? 'REQUEST_CHANGES' : 'APPROVE';
    await this.request('POST', `/repos/${this.owner}/${this.repo}/pulls/${encodeURIComponent(id)}/reviews`, { event, body: comment ?? (vote === 'suggestions' ? 'Approved with suggestions' : '') });
  }

  async requestMyReview(id: string): Promise<void> {
    await this.request('POST', `/repos/${this.owner}/${this.repo}/pulls/${encodeURIComponent(id)}/requested_reviewers`, { reviewers: [await this.me()] });
  }

  async commentPullRequest(id: string, text: string): Promise<void> {
    await this.request('POST', `/repos/${this.owner}/${this.repo}/issues/${encodeURIComponent(id)}/comments`, { body: text });
  }

  async updatePullRequest(
    id: string,
    change: { publish?: boolean; abandon?: boolean; complete?: { strategy: 'squash' | 'noFastForward' | 'rebase' | 'rebaseMerge'; deleteSourceBranch: boolean; lastSourceCommit: string; message?: string; transitionWorkItems?: boolean } },
  ): Promise<void> {
    const base = `/repos/${this.owner}/${this.repo}`;
    if (change.publish) {
      throw new Error('Marking a GitHub draft ready for review is done on github.com.');
    }
    if (change.abandon) {
      await this.request('PATCH', `${base}/pulls/${encodeURIComponent(id)}`, { state: 'closed' });
      return;
    }
    const c = change.complete!;
    const p = await this.request<GhPull>('GET', `${base}/pulls/${encodeURIComponent(id)}`);
    await this.request('PUT', `${base}/pulls/${encodeURIComponent(id)}/merge`, {
      merge_method: c.strategy === 'squash' ? 'squash' : c.strategy === 'rebase' ? 'rebase' : 'merge',
      sha: c.lastSourceCommit,
      commit_title: c.message,
    });
    if (c.deleteSourceBranch) {
      await this.request('DELETE', `${base}/git/refs/heads/${p.head.ref}`).catch(() => undefined);
    }
  }

  async createPullRequest(o: CreatePullRequestOptions): Promise<PullRequest> {
    const closes = o.ticketIds.map((id) => `Closes #${id}`).join('\n');
    const p = await this.request<GhPull>('POST', `/repos/${this.owner}/${this.repo}/pulls`, {
      title: o.title,
      head: o.source,
      base: o.target,
      body: [o.description, closes].filter(Boolean).join('\n\n'),
      draft: o.draft,
    });
    return this.toPullRequest(p, p.user.login);
  }
}
