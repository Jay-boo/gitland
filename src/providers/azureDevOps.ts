import * as vscode from 'vscode';
import { config } from '../util';
import { AuthError, CreatePullRequestOptions, Provider, PullRequest, Ticket } from './types';

const AZURE_DEVOPS_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';
export const PAT_SECRET_KEY = 'gitland.azureDevOps.pat';
const API = 'api-version=7.1';
const FIELDS = ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo'];

interface AzWorkItem {
  id: number;
  fields: Record<string, unknown>;
}

interface AzPullRequest {
  pullRequestId: number;
  title: string;
  sourceRefName: string;
  targetRefName: string;
  isDraft?: boolean;
  creationDate?: string;
  createdBy: { id: string; displayName: string };
  reviewers?: { id: string; vote: number }[];
}

const e = encodeURIComponent;
const stripHeads = (ref: string) => ref.replace(/^refs\/heads\//, '');

export class AzureDevOpsProvider implements Provider {
  readonly kind = 'azure' as const;
  readonly ticketNoun = 'work item';
  private userId?: Promise<string>;

  constructor(
    private readonly org: string,
    private readonly project: string,
    private readonly repo: string,
    private readonly secrets: vscode.SecretStorage,
  ) {}

  get displayName(): string {
    return `Azure DevOps · ${this.project}/${this.repo}`;
  }

  private get orgUrl(): string {
    return `https://dev.azure.com/${e(this.org)}`;
  }

  private get projectUrl(): string {
    return `${this.orgUrl}/${e(this.project)}`;
  }

  private get repoApi(): string {
    return `${this.projectUrl}/_apis/git/repositories/${e(this.repo)}`;
  }

  get webUrl(): string {
    return `${this.projectUrl}/_git/${e(this.repo)}`;
  }

  commitUrl(sha: string): string {
    return `${this.webUrl}/commit/${sha}`;
  }

  branchUrl(branch: string): string {
    return `${this.webUrl}?version=GB${e(branch)}`;
  }

  private workItemUrl(id: number | string): string {
    return `${this.projectUrl}/_workitems/edit/${id}`;
  }

  private prUrl(id: number): string {
    return `${this.webUrl}/pullrequest/${id}`;
  }

  private async authHeader(): Promise<string> {
    const pat = await this.secrets.get(PAT_SECRET_KEY);
    if (pat) {
      return 'Basic ' + Buffer.from(':' + pat).toString('base64');
    }
    const session = await vscode.authentication.getSession('microsoft', [AZURE_DEVOPS_SCOPE], { createIfNone: true });
    return 'Bearer ' + session.accessToken;
  }

  private async request<T>(method: string, url: string, body?: unknown, contentType = 'application/json'): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: await this.authHeader(),
        'Content-Type': contentType,
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    // Azure DevOps answers 203 + HTML sign-in page when the credentials are not accepted.
    if (res.status === 401 || res.status === 203 || (res.ok && !isJson)) {
      throw new AuthError(
        'Azure DevOps rejected the credentials. Sign in with your Microsoft work account or set a PAT (Gitland: Set Azure DevOps Personal Access Token).',
      );
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const data = (await res.json()) as { message?: string };
        if (data.message) {
          msg = data.message;
        }
      } catch {
        /* ignore */
      }
      throw new Error(`Azure DevOps: ${msg}`);
    }
    return (await res.json()) as T;
  }

  private currentUserId(): Promise<string> {
    this.userId ??= this.request<{ authenticatedUser: { id: string } }>(
      'GET',
      `${this.orgUrl}/_apis/connectionData`,
    ).then((d) => d.authenticatedUser.id);
    this.userId.catch(() => (this.userId = undefined));
    return this.userId;
  }

  private toTicket(w: AzWorkItem): Ticket {
    const f = w.fields;
    const assigned = f['System.AssignedTo'] as { displayName?: string } | undefined;
    return {
      id: String(w.id),
      title: String(f['System.Title'] ?? ''),
      type: String(f['System.WorkItemType'] ?? ''),
      state: String(f['System.State'] ?? ''),
      assignee: assigned?.displayName,
      url: this.workItemUrl(w.id),
    };
  }

  private async queryTickets(wiql: string, top = 100): Promise<Ticket[]> {
    const result = await this.request<{ workItems: { id: number }[] }>(
      'POST',
      `${this.projectUrl}/_apis/wit/wiql?$top=${top}&${API}`,
      { query: wiql },
    );
    const ids = result.workItems.map((w) => w.id).slice(0, 200);
    if (ids.length === 0) {
      return [];
    }
    const items = await this.request<{ value: AzWorkItem[] }>(
      'GET',
      `${this.projectUrl}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${FIELDS.join(',')}&${API}`,
    );
    const byId = new Map(items.value.map((w) => [w.id, w]));
    return ids.map((id) => byId.get(id)).filter((w): w is AzWorkItem => !!w).map((w) => this.toTicket(w));
  }

  listMyTickets(): Promise<Ticket[]> {
    return this.queryTickets(config('azureDevOps.wiql', ''));
  }

  async searchTickets(text: string): Promise<Ticket[]> {
    const trimmed = text.trim().replace(/^#/, '');
    if (/^\d+$/.test(trimmed)) {
      const t = await this.getTicket(trimmed);
      return t ? [t] : [];
    }
    const escaped = trimmed.replace(/'/g, "''");
    return this.queryTickets(
      `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Title] CONTAINS '${escaped}' ORDER BY [System.ChangedDate] DESC`,
      30,
    );
  }

  async getTicket(id: string): Promise<Ticket | undefined> {
    try {
      const w = await this.request<AzWorkItem>(
        'GET',
        `${this.orgUrl}/_apis/wit/workitems/${e(id)}?fields=${FIELDS.join(',')}&${API}`,
      );
      return this.toTicket(w);
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      return undefined;
    }
  }

  async activateTicket(id: string): Promise<void> {
    await this.request(
      'PATCH',
      `${this.orgUrl}/_apis/wit/workitems/${e(id)}?${API}`,
      [{ op: 'add', path: '/fields/System.State', value: 'Active' }],
      'application/json-patch+json',
    );
  }

  async listPullRequests(): Promise<PullRequest[]> {
    const [data, me] = await Promise.all([
      this.request<{ value: AzPullRequest[] }>('GET', `${this.repoApi}/pullrequests?searchCriteria.status=active&$top=100&${API}`),
      this.currentUserId().catch(() => ''),
    ]);
    return data.value.map((pr) => this.toPullRequest(pr, me));
  }

  private toPullRequest(pr: AzPullRequest, me: string): PullRequest {
    let group: PullRequest['group'] = 'other';
    if (pr.createdBy.id === me) {
      group = 'mine';
    } else if (pr.reviewers?.some((r) => r.id === me)) {
      group = 'review';
    }
    return {
      id: String(pr.pullRequestId),
      label: `!${pr.pullRequestId}`,
      title: pr.title,
      sourceBranch: stripHeads(pr.sourceRefName),
      targetBranch: stripHeads(pr.targetRefName),
      author: pr.createdBy.displayName,
      url: this.prUrl(pr.pullRequestId),
      isDraft: !!pr.isDraft,
      group,
      created: pr.creationDate ? Date.parse(pr.creationDate) : undefined,
    };
  }

  async createPullRequest(o: CreatePullRequestOptions): Promise<PullRequest> {
    const pr = await this.request<AzPullRequest>('POST', `${this.repoApi}/pullrequests?${API}`, {
      sourceRefName: `refs/heads/${o.source}`,
      targetRefName: `refs/heads/${o.target}`,
      title: o.title,
      description: o.description,
      isDraft: o.draft,
      workItemRefs: o.ticketIds.map((id) => ({ id })),
    });
    return this.toPullRequest(pr, pr.createdBy.id);
  }
}
