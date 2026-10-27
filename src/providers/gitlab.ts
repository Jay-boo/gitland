import * as vscode from 'vscode';
import { GlJob, groupJobsByStage, once, pipelineState, stripDraft } from './gitlabMap.pure';
import { AuthError, CreatePullRequestOptions, PipelineJob, PipelineRun, Provider, PullRequest, PullRequestDetails, ReviewVote, Ticket, TicketDetails } from './types';

/** Personal access tokens are stored per host (gitlab.com, self-hosted instances). */
export const gitlabTokenKey = (host: string) => `gitland.gitlab.token:${host.toLowerCase()}`;

/** Asks for a token (scope "api") for the host, stores it (empty removes it) and returns it. */
export async function promptGitLabToken(host: string, secrets: vscode.SecretStorage): Promise<string | undefined> {
  const input = vscode.window.createInputBox();
  input.title = `GitLab token for ${host}`;
  input.prompt = 'Scope needed: api. Leave empty to remove it.';
  input.password = true;
  input.ignoreFocusOut = true;
  const create = { iconPath: new vscode.ThemeIcon('link-external'), tooltip: 'Create token' };
  input.buttons = [create];
  const value = await new Promise<string | undefined>((resolve) => {
    input.onDidTriggerButton(() =>
      vscode.env.openExternal(vscode.Uri.parse(`https://${host}/-/user_settings/personal_access_tokens?name=Gitland&scopes=api`)),
    );
    input.onDidAccept(() => {
      resolve(input.value);
      input.hide();
    });
    input.onDidHide(() => resolve(undefined));
    input.show();
  });
  input.dispose();
  if (value === undefined) {
    return undefined;
  }
  if (!value.trim()) {
    await secrets.delete(gitlabTokenKey(host));
    return undefined;
  }
  await secrets.store(gitlabTokenKey(host), value.trim());
  return value.trim();
}

interface GlUser {
  id: number;
  username: string;
  name?: string;
}

interface GlIssue {
  iid: number;
  title: string;
  state: string;
  web_url: string;
  labels: string[];
  assignees?: GlUser[];
  author?: GlUser;
  description?: string | null;
  milestone?: { title: string } | null;
  due_date?: string | null;
  updated_at?: string;
}

interface GlMergeRequest {
  iid: number;
  title: string;
  web_url: string;
  draft?: boolean;
  created_at?: string;
  author: GlUser;
  source_branch: string;
  target_branch: string;
  reviewers?: GlUser[];
  description?: string | null;
  state: string;
  detailed_merge_status?: string;
  sha?: string;
}

interface GlNote {
  id: number;
  body: string;
  author: GlUser;
  created_at: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: { new_path?: string; new_line?: number | null; old_path?: string } | null;
}

interface GlPipeline {
  id: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  source?: string;
  name?: string | null;
  created_at?: string;
  updated_at?: string;
}

const DONE = new Set(['succeeded', 'failed', 'canceled']);

export class GitLabProvider implements Provider {
  readonly kind = 'gitlab' as const;
  readonly ticketNoun = 'issue';
  /** Signed-in user, with the token it was read with (a new token is a new user). */
  private user?: { token: string; user: Promise<GlUser> };

  constructor(readonly host: string, private readonly path: string, private readonly secrets: vscode.SecretStorage) {}

  get displayName(): string {
    return `GitLab · ${this.path}${this.host === 'gitlab.com' ? '' : ` (${this.host})`}`;
  }

  private get webUrl(): string {
    return `https://${this.host}/${this.path}`;
  }

  /** API path of the project ("group/sub/repo" is one encoded segment). */
  private get project(): string {
    return `/projects/${encodeURIComponent(this.path)}`;
  }

  commitUrl(sha: string): string {
    return `${this.webUrl}/-/commit/${sha}`;
  }

  branchUrl(branch: string): string {
    return `${this.webUrl}/-/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
  }

  ticketUrl(id: number | string): string {
    return `${this.webUrl}/-/issues/${id}`;
  }

  pullRequestUrl(id: number | string): string {
    return `${this.webUrl}/-/merge_requests/${id}`;
  }

  releaseUrl(tag: string): string {
    return `${this.webUrl}/-/releases/${encodeURIComponent(tag)}`;
  }

  async isSignedIn(): Promise<boolean> {
    return !!(await this.secrets.get(gitlabTokenKey(this.host)));
  }

  private async token(): Promise<string> {
    // Parallel requests share one prompt.
    const token = (await this.secrets.get(gitlabTokenKey(this.host))) ?? (await once(this.host, () => promptGitLabToken(this.host, this.secrets)));
    if (!token) {
      throw new AuthError('Set a GitLab token to continue.', true);
    }
    return token;
  }

  private async fetch(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`https://${this.host}/api/v4${path}`, {
      method,
      headers: { 'PRIVATE-TOKEN': await this.token(), 'Content-Type': 'application/json', 'User-Agent': 'gitland-vscode' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      throw new AuthError(`GitLab rejected the token for ${this.host}. Run "Gitland: Set GitLab Token".`);
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const data = (await res.json()) as { message?: unknown; error?: string };
        const m = data.message ?? data.error;
        // Validation errors come as { field: ["message", …] }.
        msg = (typeof m === 'string' ? m : m && typeof m === 'object' ? Object.values(m).flat().join(' – ') : '') || msg;
      } catch {
        /* ignore */
      }
      throw new Error(`GitLab: ${msg}`);
    }
    return res;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(method, path, body);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** Requests whose answer is plain text (job logs). */
  private async requestText(method: string, path: string): Promise<string> {
    return (await this.fetch(method, path)).text();
  }

  private async me(): Promise<GlUser> {
    const token = await this.token();
    if (this.user?.token !== token) {
      const user = this.request<GlUser>('GET', '/user');
      user.catch(() => this.user?.user === user && (this.user = undefined));
      this.user = { token, user };
    }
    return this.user.user;
  }

  async avatarFor(email: string): Promise<string | undefined> {
    const a = await this.request<{ avatar_url?: string | null }>('GET', `/avatar?email=${encodeURIComponent(email)}&size=64`);
    return a.avatar_url ?? undefined;
  }

  // ── Issues ──────────────────────────────────────────────────────────────

  private toTicket(i: GlIssue): Ticket {
    return {
      id: String(i.iid),
      title: i.title,
      type: i.labels.some((l) => /bug/i.test(l)) ? 'Bug' : 'Issue',
      state: i.state,
      url: i.web_url,
      assignee: i.assignees?.[0]?.username,
    };
  }

  async listMyTickets(): Promise<Ticket[]> {
    const me = await this.me();
    const issues = await this.request<GlIssue[]>('GET', `${this.project}/issues?state=opened&assignee_id=${me.id}&per_page=50`);
    return issues.map((i) => this.toTicket(i));
  }

  async searchTickets(text: string): Promise<Ticket[]> {
    const trimmed = text.trim().replace(/^#/, '');
    if (/^\d+$/.test(trimmed)) {
      const t = await this.getTicket(trimmed);
      return t ? [t] : [];
    }
    const issues = await this.request<GlIssue[]>('GET', `${this.project}/issues?state=opened&per_page=50&search=${encodeURIComponent(trimmed)}`);
    return issues.map((i) => this.toTicket(i));
  }

  async getTicket(id: string): Promise<Ticket | undefined> {
    try {
      return this.toTicket(await this.request<GlIssue>('GET', `${this.project}/issues/${encodeURIComponent(id)}`));
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      return undefined;
    }
  }

  async getTicketDetails(id: string): Promise<TicketDetails | undefined> {
    const base = `${this.project}/issues/${encodeURIComponent(id)}`;
    const [i, notes, closedBy] = await Promise.all([
      this.request<GlIssue>('GET', base),
      this.request<GlNote[]>('GET', `${base}/notes?sort=asc&per_page=100`).catch(() => []),
      this.request<{ iid: number; web_url: string }[]>('GET', `${base}/closed_by`).catch(() => []),
    ]);
    return {
      ticket: this.toTicket(i),
      format: 'markdown',
      description: i.description || undefined,
      sections: [],
      fields: [
        ['Opened by', i.author?.name ?? i.author?.username],
        ['Milestone', i.milestone?.title],
        ['Due date', i.due_date ?? undefined],
      ]
        .filter(([, v]) => v)
        .map(([label, value]) => ({ label: label!, value: value! })),
      tags: i.labels,
      comments: notes.filter((n) => !n.system).map((n) => ({ author: n.author.name ?? n.author.username, date: Date.parse(n.created_at), body: n.body })),
      pullRequests: closedBy.map((mr) => ({ id: String(mr.iid), url: mr.web_url })),
      related: [],
      changed: i.updated_at ? Date.parse(i.updated_at) : undefined,
    };
  }

  async ticketStates(): Promise<{ name: string }[]> {
    return [{ name: 'opened' }, { name: 'closed' }];
  }

  async setTicketState(id: string, state: string): Promise<void> {
    await this.request('PUT', `${this.project}/issues/${encodeURIComponent(id)}`, { state_event: state === 'closed' ? 'close' : 'reopen' });
  }

  async assignTicketToMe(id: string): Promise<void> {
    const base = `${this.project}/issues/${encodeURIComponent(id)}`;
    const [i, me] = await Promise.all([this.request<GlIssue>('GET', base), this.me()]);
    const ids = new Set([...(i.assignees ?? []).map((a) => a.id), me.id]);
    await this.request('PUT', base, { assignee_ids: [...ids] });
  }

  async commentTicket(id: string, text: string): Promise<void> {
    await this.request('POST', `${this.project}/issues/${encodeURIComponent(id)}/notes`, { body: text });
  }

  // ── Merge requests ──────────────────────────────────────────────────────

  private toPullRequest(mr: GlMergeRequest, me: GlUser | undefined): PullRequest {
    const reviewer = !!me && !!mr.reviewers?.some((r) => r.id === me.id);
    return {
      id: String(mr.iid),
      label: `!${mr.iid}`,
      title: mr.title,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      author: mr.author.name ?? mr.author.username,
      url: mr.web_url,
      isDraft: !!mr.draft,
      group: me && mr.author.id === me.id ? 'mine' : reviewer ? 'review' : 'other',
      created: mr.created_at ? Date.parse(mr.created_at) : undefined,
      needsMyReview: reviewer,
    };
  }

  private mr(id: string): string {
    return `${this.project}/merge_requests/${encodeURIComponent(id)}`;
  }

  async listPullRequests(): Promise<PullRequest[]> {
    const [mrs, me] = await Promise.all([
      this.request<GlMergeRequest[]>('GET', `${this.project}/merge_requests?state=opened&per_page=100`),
      this.me().catch(() => undefined),
    ]);
    return mrs.map((mr) => this.toPullRequest(mr, me));
  }

  async getPullRequestDetails(id: string): Promise<PullRequestDetails> {
    const base = this.mr(id);
    const [mr, me, approvals, commits, discussions] = await Promise.all([
      this.request<GlMergeRequest>('GET', base),
      this.me().catch(() => undefined),
      this.request<{ approved?: boolean; approved_by?: { user: GlUser }[] }>('GET', `${base}/approvals`).catch(() => ({ approved: false, approved_by: [] })),
      this.request<{ id: string; title: string; author_name: string; authored_date?: string; created_at: string }[]>('GET', `${base}/commits?per_page=100`).catch(() => []),
      this.request<{ id: string; individual_note: boolean; notes: GlNote[] }[]>('GET', `${base}/discussions?per_page=100`).catch(() => []),
    ]);
    const approvedBy = (approvals.approved_by ?? []).map((a) => a.user);
    const people = new Map<number, GlUser>();
    for (const u of [...(mr.reviewers ?? []), ...approvedBy]) {
      people.set(u.id, u);
    }
    const reviewers: PullRequestDetails['reviewers'] = [...people.values()].map((u) => ({
      name: u.name ?? u.username,
      vote: approvedBy.some((a) => a.id === u.id) ? 'approved' : 'waiting',
    }));
    const pr = this.toPullRequest(mr, me);
    const iApproved = !!me && approvedBy.some((a) => a.id === me.id);
    pr.review = approvals.approved ? 'approved' : 'waiting';
    pr.needsMyReview = pr.needsMyReview && !iApproved;
    const threads: NonNullable<PullRequestDetails['threads']> = [];
    const comments: PullRequestDetails['comments'] = [];
    for (const d of discussions) {
      const notes = d.notes.filter((n) => !n.system);
      if (!notes.length) {
        continue;
      }
      const first = notes[0];
      const asComment = (n: GlNote) => ({ author: n.author.name ?? n.author.username, date: Date.parse(n.created_at), body: n.body });
      if (d.individual_note && !first.resolvable) {
        comments.push(asComment(first));
        continue;
      }
      threads.push({
        id: d.id,
        status: first.resolvable ? (notes.every((n) => !n.resolvable || n.resolved) ? 'resolved' : 'active') : undefined,
        file: first.position?.new_path ?? first.position?.old_path,
        line: first.position?.new_line ?? undefined,
        comments: notes.map(asComment),
      });
    }
    return {
      pr,
      status: mr.state === 'opened' ? 'active' : mr.state,
      description: mr.description || undefined,
      mergeStatus: mr.detailed_merge_status,
      reviewers,
      workItems: [...(mr.description ?? '').matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map((m) => ({ id: m[1], url: this.ticketUrl(m[1]) })),
      commits: commits.map((c) => ({ sha: c.id, subject: c.title, author: c.author_name, date: Date.parse(c.authored_date ?? c.created_at) })),
      comments,
      threads,
      amReviewer: !!me && people.has(me.id),
      myVote: me && people.has(me.id) ? (iApproved ? 'approved' : 'waiting') : undefined,
      lastSourceCommit: mr.sha,
    };
  }

  async votePullRequest(id: string, vote: ReviewVote, comment?: string): Promise<void> {
    if (vote === 'reject' || vote === 'wait') {
      throw new Error('GitLab has no such review state: approve or revoke approval.');
    }
    await this.request('POST', `${this.mr(id)}/${vote === 'reset' ? 'unapprove' : 'approve'}`);
    if (comment) {
      await this.commentPullRequest(id, comment);
    }
  }

  async requestMyReview(id: string): Promise<void> {
    const [mr, me] = await Promise.all([this.request<GlMergeRequest>('GET', this.mr(id)), this.me()]);
    const ids = new Set([...(mr.reviewers ?? []).map((r) => r.id), me.id]);
    await this.request('PUT', this.mr(id), { reviewer_ids: [...ids] });
  }

  async commentPullRequest(id: string, text: string, threadId?: string): Promise<void> {
    const path = threadId ? `${this.mr(id)}/discussions/${encodeURIComponent(threadId)}/notes` : `${this.mr(id)}/notes`;
    await this.request('POST', path, { body: text });
  }

  async resolveThread(id: string, threadId: string, resolved: boolean): Promise<void> {
    await this.request('PUT', `${this.mr(id)}/discussions/${encodeURIComponent(threadId)}?resolved=${resolved}`);
  }

  async updatePullRequest(
    id: string,
    change: { publish?: boolean; abandon?: boolean; complete?: { strategy: 'squash' | 'noFastForward' | 'rebase' | 'rebaseMerge'; deleteSourceBranch: boolean; lastSourceCommit: string; message?: string; transitionWorkItems?: boolean } },
  ): Promise<void> {
    if (change.publish) {
      const mr = await this.request<GlMergeRequest>('GET', this.mr(id));
      await this.request('PUT', this.mr(id), { title: stripDraft(mr.title) });
      return;
    }
    if (change.abandon) {
      await this.request('PUT', this.mr(id), { state_event: 'close' });
      return;
    }
    // GitLab merges with the project's method; rebase strategies become a normal merge.
    const c = change.complete!;
    const squash = c.strategy === 'squash';
    await this.request('PUT', `${this.mr(id)}/merge`, {
      sha: c.lastSourceCommit,
      squash,
      should_remove_source_branch: c.deleteSourceBranch,
      ...(c.message ? { [squash ? 'squash_commit_message' : 'merge_commit_message']: c.message } : {}),
    });
  }

  async createPullRequest(o: CreatePullRequestOptions): Promise<PullRequest> {
    const closes = o.ticketIds.map((id) => `Closes #${id}`).join('\n');
    const mr = await this.request<GlMergeRequest>('POST', `${this.project}/merge_requests`, {
      source_branch: o.source,
      target_branch: o.target,
      title: o.draft ? `Draft: ${stripDraft(o.title)}` : o.title,
      description: [o.description, closes].filter(Boolean).join('\n\n'),
      remove_source_branch: false,
    });
    return this.toPullRequest(mr, mr.author);
  }

  // ── Pipelines ───────────────────────────────────────────────────────────

  async pipelineRuns(o: { prId?: string; max?: number; branch?: string }): Promise<PipelineRun[]> {
    const pipelines = o.prId
      ? await this.request<GlPipeline[]>('GET', `${this.mr(o.prId)}/pipelines?per_page=${o.max ?? 60}`)
      : await this.request<GlPipeline[]>('GET', `${this.project}/pipelines?per_page=${o.max ?? 60}${o.branch ? `&ref=${encodeURIComponent(o.branch)}` : ''}`);
    return pipelines.map((p) => {
      const state = pipelineState(p.status);
      return {
        id: String(p.id),
        definitionId: p.source,
        name: p.name || `Pipeline #${p.id}`,
        state,
        url: p.web_url,
        sha: p.sha,
        branch: p.ref,
        started: p.created_at ? Date.parse(p.created_at) : undefined,
        finished: DONE.has(state) && p.updated_at ? Date.parse(p.updated_at) : undefined,
      };
    });
  }

  async rerunPipeline(run: PipelineRun): Promise<void> {
    await this.request('POST', `${this.project}/pipelines/${encodeURIComponent(run.id)}/retry`);
  }

  async cancelPipeline(run: PipelineRun): Promise<void> {
    await this.request('POST', `${this.project}/pipelines/${encodeURIComponent(run.id)}/cancel`);
  }

  /** Stages, each with its jobs as steps (retried jobs are fetched so a retry keeps its stage in place). */
  async pipelineJobs(run: PipelineRun): Promise<PipelineJob[]> {
    const jobs = await this.request<GlJob[]>('GET', `${this.project}/pipelines/${encodeURIComponent(run.id)}/jobs?per_page=100&include_retried=true`);
    return groupJobsByStage(jobs);
  }

  /** A job's log; for a stage, the logs of its failed jobs (or of its first job). */
  async pipelineLog(_run: PipelineRun, job: PipelineJob): Promise<string> {
    if (job.logId) {
      return this.requestText('GET', `${this.project}/jobs/${encodeURIComponent(job.logId)}/trace`);
    }
    const steps = job.steps ?? [];
    const failed = steps.filter((s) => s.state === 'failed');
    const pick = failed.length ? failed : steps.slice(0, 1);
    const logs = await Promise.all(pick.map(async (s) => `\n── ${s.name} ──\n${await this.requestText('GET', `${this.project}/jobs/${encodeURIComponent(s.logId!)}/trace`)}`));
    return logs.join('\n').trimStart();
  }
}
