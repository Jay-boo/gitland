import * as vscode from 'vscode';
import { AuthError, CreatePullRequestOptions, Provider, PullRequest, Ticket } from './types';

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
    };
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
