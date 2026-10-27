import * as vscode from 'vscode';
import { log } from '../log';
import { config, errorMessage } from '../util';
import { AuthError, CreatePullRequestOptions, PipelineJob, PipelineRun, Provider, PullRequest, PullRequestDetails, ReviewVote, Ticket, TicketDetails, TicketSource } from './types';

export const AZURE_DEVOPS_SCOPES = ['499b84ac-1321-427f-aa17-267ca6975798/.default'];
/** Legacy key: one token for every organization. */
export const PAT_SECRET_KEY = 'gitland.azureDevOps.pat';
/** Tokens are stored per organization so work and personal orgs can use different ones. */
export const patSecretKey = (org: string) => `${PAT_SECRET_KEY}:${org.toLowerCase()}`;

const tenants = new Map<string, Promise<string | undefined>>();

/**
 * Entra ID tenant that owns an Azure DevOps organization. Azure DevOps reports it in the
 * `x-vss-resourcetenant` header of any anonymous request, so no sign-in is needed to find it.
 */
export function organizationTenant(org: string): Promise<string | undefined> {
  const key = org.toLowerCase();
  let tenant = tenants.get(key);
  if (!tenant) {
    tenant = fetch(`https://dev.azure.com/${encodeURIComponent(org)}/_apis/connectionData`, { redirect: 'manual' })
      .then((res) => {
        const id = res.headers.get('x-vss-resourcetenant') ?? undefined;
        // All zeros = organization backed by personal Microsoft accounts (no tenant).
        return id && !/^[0-]+$/.test(id) ? id : undefined;
      })
      .catch((e) => {
        log.warn(`Could not discover the tenant of Azure DevOps organization '${org}': ${e}`);
        tenants.delete(key);
        return undefined;
      });
    tenants.set(key, tenant);
  }
  return tenant;
}

/**
 * Scopes for a token valid in the organization's tenant. Pinning the tenant makes VS Code pick
 * the account that belongs to it (e.g. the work account) instead of any other signed-in account.
 */
export async function azureDevOpsScopes(org: string): Promise<string[]> {
  const tenant = await organizationTenant(org);
  return tenant ? [...AZURE_DEVOPS_SCOPES, `VSCODE_TENANT:${tenant}`] : AZURE_DEVOPS_SCOPES;
}

/** Interactive Microsoft sign-in, with a notification because the Windows account dialog often opens behind VS Code. */
export async function signInToAzureDevOps(org: string, chooseAccount: boolean): Promise<vscode.AuthenticationSession> {
  const scopes = await azureDevOpsScopes(org);
  const tenant = scopes.find((s) => s.startsWith('VSCODE_TENANT:'))?.slice('VSCODE_TENANT:'.length);
  log.info(`Azure DevOps (${org}): signing in${tenant ? ` for tenant ${tenant}` : ''}…`);
  await ensureBrowserSignIn();
  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Signing in to Azure DevOps (${org})… If nothing shows up, look for a Microsoft sign-in window behind VS Code (Alt+Tab).`,
      },
      () =>
        vscode.authentication.getSession(
          'microsoft',
          scopes,
          chooseAccount ? { clearSessionPreference: true, createIfNone: true } : { createIfNone: true },
        ),
    );
  } catch (e) {
    log.error(`Azure DevOps (${org}): Microsoft sign-in failed`, e);
    offerSignInAlternatives(org);
    throw new AuthError(`Microsoft sign-in to Azure DevOps (${org}) did not complete.`, true);
  }
}

/**
 * Uses the browser flow for Microsoft sign-in (unless disabled with gitland.azureDevOps.browserSignIn).
 * VS Code's Microsoft authentication only applies the change after a reload, which it offers itself.
 */
async function ensureBrowserSignIn(): Promise<void> {
  const authConfig = vscode.workspace.getConfiguration('microsoft-authentication');
  if (!config('azureDevOps.browserSignIn', true) || authConfig.get<string>('implementation', 'msal') !== 'msal') {
    return;
  }
  await authConfig.update('implementation', 'msal-no-broker', vscode.ConfigurationTarget.Global);
  log.info('Set microsoft-authentication.implementation = msal-no-broker (browser sign-in).');
  const reload = 'Reload Window';
  const choice = await vscode.window.showInformationMessage(
    'Gitland signs in to Azure DevOps through your browser. Reload the window once, then sign in again.',
    reload,
  );
  if (choice === reload) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
  throw new AuthError('Reload the window to finish switching to browser sign-in.', true);
}

/**
 * The Windows account broker (WAM) is often blocked by company policies on machines that are not
 * managed by that company (e.g. a consultant laptop). A browser sign-in or a PAT usually still works.
 */
async function offerSignInAlternatives(org: string): Promise<void> {
  const authConfig = vscode.workspace.getConfiguration('microsoft-authentication');
  const usingBroker = authConfig.get<string>('implementation', 'msal') === 'msal';
  const browser = 'Sign in with the browser instead';
  const pat = 'Use a Personal Access Token';
  const choice = await vscode.window.showWarningMessage(
    `Microsoft sign-in to Azure DevOps (${org}) did not complete. ` +
      (usingBroker
        ? "On a laptop not managed by this organization, the Windows sign-in dialog is often blocked by its security policies. Signing in through the browser usually works."
        : 'You can use a Personal Access Token instead.'),
    ...(usingBroker ? [browser, pat] : [pat]),
  );
  if (choice === browser) {
    await authConfig.update('implementation', 'msal-no-broker', vscode.ConfigurationTarget.Global);
    log.info('Set microsoft-authentication.implementation = msal-no-broker (browser sign-in).');
    const reload = 'Reload Window';
    const r = await vscode.window.showInformationMessage(
      'VS Code will now sign in to Microsoft accounts through your browser. Reload the window, then click "Sign in to Azure DevOps" again.',
      reload,
    );
    if (r === reload) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } else if (choice === pat) {
    await vscode.env.openExternal(vscode.Uri.parse(`https://dev.azure.com/${encodeURIComponent(org)}/_usersSettings/tokens`));
    await vscode.commands.executeCommand('gitland.setAzurePat');
  }
}
const API = 'api-version=7.1';
const FIELDS = ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo', 'System.TeamProject'];

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

  get organization(): string {
    return this.org;
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

  /**
   * Projects the tickets come from: gitland.tickets.sources, else the repository's project.
   * Teams often keep all work items in one "backlog" project, separate from the code.
   */
  get ticketSources(): TicketSource[] {
    const list = config<TicketSource[]>('tickets.sources', []).filter((t) => t && t.organization && t.project);
    return list.length ? list : [{ organization: this.org, project: this.project }];
  }

  get ticketSourceLabel(): string {
    return this.ticketSources.map((t) => (t.organization === this.org ? t.project : `${t.organization}/${t.project}`)).join(', ');
  }

  ticketUrl(id: number | string, source = this.ticketSources[0]): string {
    return `https://dev.azure.com/${e(source.organization)}/${e(source.project)}/_workitems/edit/${id}`;
  }

  pullRequestUrl(id: number | string): string {
    return `${this.webUrl}/pullrequest/${id}`;
  }

  releaseUrl(tag: string): string {
    return `${this.webUrl}?version=GT${e(tag)}`;
  }

  async isSignedIn(): Promise<boolean> {
    if ((await this.secrets.get(patSecretKey(this.org))) ?? (await this.secrets.get(PAT_SECRET_KEY))) {
      return true;
    }
    const session = await vscode.authentication.getSession('microsoft', await azureDevOpsScopes(this.org), { silent: true });
    return !!session;
  }

  private async authHeader(org = this.org): Promise<string> {
    const pat = (await this.secrets.get(patSecretKey(org))) ?? (await this.secrets.get(PAT_SECRET_KEY));
    if (pat) {
      return 'Basic ' + Buffer.from(':' + pat).toString('base64');
    }
    const session =
      (await vscode.authentication.getSession('microsoft', await azureDevOpsScopes(org), { silent: true })) ??
      (await signInToAzureDevOps(org, false));
    log.info(`Azure DevOps (${org}): using Microsoft account ${session.account.label}`);
    return 'Bearer ' + session.accessToken;
  }

  private async request<T>(method: string, url: string, body?: unknown, contentType = 'application/json', org = this.org): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: await this.authHeader(org),
        'Content-Type': contentType,
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    // Azure DevOps answers 203 + HTML sign-in page when the credentials are not accepted.
    if (res.status === 401 || res.status === 203 || (res.ok && !isJson)) {
      throw new AuthError(
        `Azure DevOps (${org}) rejected the credentials. Run "Gitland: Switch Azure DevOps Account" to pick your work account, or "Gitland: Set Azure DevOps Personal Access Token".`,
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

  /** A plain-text answer (build logs): same credentials as request(). */
  private async requestText(url: string, org = this.org): Promise<string> {
    const res = await fetch(url, { headers: { Authorization: await this.authHeader(org), Accept: 'text/plain' } });
    if (res.status === 401 || res.status === 203) {
      throw new AuthError(`Azure DevOps (${org}) rejected the credentials.`);
    }
    if (!res.ok) {
      throw new Error(`Azure DevOps: ${res.status} ${res.statusText}`);
    }
    return res.text();
  }

  /**
   * Profile photo of an author: find the identity by email (identities API, else the people picker
   * the web UI uses), then its picture (Graph avatars JSON, else the MemberAvatars image).
   * Returns undefined when the person has no photo; throws when Azure DevOps could not be asked.
   */
  async avatarFor(email: string): Promise<string | undefined> {
    const descriptor = await this.subjectDescriptor(email);
    if (!descriptor) {
      return undefined;
    }
    try {
      const avatar = await this.request<{ isAutoGenerated?: boolean; value?: string }>(
        'GET',
        `https://vssps.dev.azure.com/${e(this.org)}/_apis/graph/Subjects/${e(descriptor)}/avatars?size=small&format=png&api-version=7.1-preview.1`,
      );
      // Azure DevOps generates an "initials" picture when there is no photo: use the default picture instead.
      return avatar.isAutoGenerated || !avatar.value ? undefined : `data:image/png;base64,${avatar.value}`;
    } catch (err) {
      log.info(`Azure DevOps avatar (graph API) for ${email}: ${errorMessage(err)} — trying MemberAvatars`);
    }
    const res = await fetch(`${this.orgUrl}/_apis/GraphProfile/MemberAvatars/${e(descriptor)}?size=1`, {
      headers: { Authorization: await this.authHeader(), Accept: 'image/*' },
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) {
      throw new Error(`MemberAvatars answered ${res.status} ${type}`);
    }
    return `data:${type.split(';')[0]};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
  }

  private async subjectDescriptor(email: string): Promise<string | undefined> {
    try {
      const ids = await this.request<{ value: { subjectDescriptor?: string }[] }>(
        'GET',
        `https://vssps.dev.azure.com/${e(this.org)}/_apis/identities?searchFilter=General&filterValue=${e(email)}&queryMembership=None&${API}`,
      );
      const d = ids.value.find((i) => i.subjectDescriptor)?.subjectDescriptor;
      if (d) {
        return d;
      }
    } catch (err) {
      log.info(`Azure DevOps identities API for ${email}: ${errorMessage(err)} — trying the people picker`);
    }
    // The people picker of the web UI: works for any member of the organization.
    const found = await this.request<{ results: { identities: { subjectDescriptor?: string; mail?: string; signInAddress?: string }[] }[] }>(
      'POST',
      `${this.orgUrl}/_apis/IdentityPicker/Identities?api-version=5.0-preview.1`,
      { query: email, identityTypes: ['user'], operationScopes: ['ims', 'source'], properties: ['DisplayName', 'Mail', 'SignInAddress', 'SubjectDescriptor'] },
    );
    const all = found.results.flatMap((r) => r.identities);
    const lower = email.toLowerCase();
    const match = all.find((i) => i.mail?.toLowerCase() === lower || i.signInAddress?.toLowerCase() === lower) ?? all[0];
    return match?.subjectDescriptor;
  }

  private currentUserId(): Promise<string> {
    this.userId ??= this.request<{ authenticatedUser: { id: string } }>(
      'GET',
      `${this.orgUrl}/_apis/connectionData`,
    ).then((d) => d.authenticatedUser.id);
    this.userId.catch(() => (this.userId = undefined));
    return this.userId;
  }

  private reviewerIds?: Promise<Set<string>>;
  /** My id plus every team / group I belong to: a PR can ask a team for review. */
  private myReviewerIds(): Promise<Set<string>> {
    this.reviewerIds ??= (async () => {
      const me = await this.currentUserId();
      const ids = new Set([me]);
      const identities = `https://vssps.dev.azure.com/${e(this.org)}/_apis/identities`;
      const self = await this.request<{ value: { memberOf?: string[] }[] }>('GET', `${identities}?identityIds=${e(me)}&queryMembership=Expanded&${API}`).catch(() => ({ value: [] }));
      const descriptors = self.value[0]?.memberOf ?? [];
      for (let i = 0; i < descriptors.length; i += 50) {
        const groups = await this.request<{ value: ({ id: string } | null)[] }>(
          'GET',
          `${identities}?descriptors=${e(descriptors.slice(i, i + 50).join(','))}&queryMembership=None&${API}`,
        ).catch(() => ({ value: [] }));
        groups.value.forEach((g) => g && ids.add(g.id));
      }
      return ids;
    })();
    this.reviewerIds.catch(() => (this.reviewerIds = undefined));
    return this.reviewerIds;
  }

  private toTicket(w: AzWorkItem, org = this.org): Ticket {
    const f = w.fields;
    const project = String(f['System.TeamProject'] ?? this.project);
    const assigned = f['System.AssignedTo'] as { displayName?: string } | undefined;
    return {
      id: String(w.id),
      title: String(f['System.Title'] ?? ''),
      type: String(f['System.WorkItemType'] ?? ''),
      state: String(f['System.State'] ?? ''),
      assignee: assigned?.displayName,
      url: this.ticketUrl(w.id, { organization: org, project }),
      org,
      project,
    };
  }

  /** Runs a WIQL query in one ticket source (@project = that project). */
  private async queryTickets(src: TicketSource, wiql: string, top = 100): Promise<Ticket[]> {
    const orgUrl = `https://dev.azure.com/${e(src.organization)}`;
    const result = await this.request<{ workItems: { id: number }[] }>(
      'POST',
      `${orgUrl}/${e(src.project)}/_apis/wit/wiql?$top=${top}&${API}`,
      { query: wiql },
      'application/json',
      src.organization,
    );
    const ids = result.workItems.map((w) => w.id).slice(0, 200);
    if (ids.length === 0) {
      return [];
    }
    const items = await this.request<{ value: AzWorkItem[] }>(
      'GET',
      `${orgUrl}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${FIELDS.join(',')}&${API}`,
      undefined,
      'application/json',
      src.organization,
    );
    const byId = new Map(items.value.map((w) => [w.id, w]));
    return ids.map((id) => byId.get(id)).filter((w): w is AzWorkItem => !!w).map((w) => this.toTicket(w, src.organization));
  }

  /** Same query in every ticket source; fails only when all of them fail. */
  private async queryAll(wiql: (src: TicketSource) => string, top?: number): Promise<Ticket[]> {
    const results = await Promise.allSettled(this.ticketSources.map((src) => this.queryTickets(src, wiql(src), top)));
    const ok = results.filter((r): r is PromiseFulfilledResult<Ticket[]> => r.status === 'fulfilled');
    if (!ok.length) {
      throw (results[0] as PromiseRejectedResult).reason;
    }
    results.forEach((r, i) => r.status === 'rejected' && log.error(`Tickets from ${this.ticketSources[i].project} failed`, r.reason));
    const seen = new Set<string>();
    return ok.flatMap((r) => r.value).filter((t) => !seen.has(`${t.org}#${t.id}`) && !!seen.add(`${t.org}#${t.id}`));
  }

  listMyTickets(): Promise<Ticket[]> {
    return this.queryAll((src) => src.wiql || config('azureDevOps.wiql', ''));
  }

  async searchTickets(text: string): Promise<Ticket[]> {
    const trimmed = text.trim().replace(/^(AB)?#/i, '');
    if (/^\d+$/.test(trimmed)) {
      const t = await this.getTicket(trimmed);
      return t ? [t] : [];
    }
    const escaped = trimmed.replace(/'/g, "''");
    return this.queryAll(
      () =>
        `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Title] CONTAINS '${escaped}' ORDER BY [System.ChangedDate] DESC`,
      30,
    );
  }

  /** A work item by ID, looked up in the organizations of the ticket sources (then the repository's). */
  async getTicket(id: string): Promise<Ticket | undefined> {
    const orgs = [...new Set([...this.ticketSources.map((t) => t.organization), this.org])];
    for (const org of orgs) {
      try {
        const w = await this.request<AzWorkItem>(
          'GET',
          `https://dev.azure.com/${e(org)}/_apis/wit/workitems/${e(id)}?fields=${FIELDS.join(',')}&${API}`,
          undefined,
          'application/json',
          org,
        );
        return this.toTicket(w, org);
      } catch (err) {
        if (err instanceof AuthError && org === orgs[orgs.length - 1]) {
          throw err;
        }
      }
    }
    return undefined;
  }

  /** The work item with its rich text, links and comments (for the ticket page). */
  async getTicketDetails(id: string, org?: string): Promise<TicketDetails | undefined> {
    const orgs = org ? [org] : [...new Set([...this.ticketSources.map((t) => t.organization), this.org])];
    for (const o of orgs) {
      let w: AzWorkItem & { relations?: { rel: string; url: string; attributes?: { name?: string } }[] };
      try {
        w = await this.request('GET', `https://dev.azure.com/${e(o)}/_apis/wit/workitems/${e(id)}?$expand=all&${API}`, undefined, 'application/json', o);
      } catch (err) {
        if (err instanceof AuthError || o === orgs[orgs.length - 1]) {
          throw err;
        }
        continue;
      }
      const f = w.fields;
      const ticket = this.toTicket(w, o);
      const person = (v: unknown) => (v as { displayName?: string } | undefined)?.displayName;
      const text = (k: string) => (typeof f[k] === 'string' && (f[k] as string).trim() ? (f[k] as string) : undefined);
      const fields = [
        ['Priority', f['Microsoft.VSTS.Common.Priority']],
        ['Severity', f['Microsoft.VSTS.Common.Severity']],
        ['Effort', f['Microsoft.VSTS.Scheduling.Effort'] ?? f['Microsoft.VSTS.Scheduling.StoryPoints'] ?? f['Microsoft.VSTS.Scheduling.OriginalEstimate']],
        ['Remaining', f['Microsoft.VSTS.Scheduling.RemainingWork']],
        ['Iteration', f['System.IterationPath']],
        ['Area', f['System.AreaPath']],
        ['Created by', person(f['System.CreatedBy'])],
        ['Reason', f['System.Reason']],
      ]
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([label, value]) => ({ label: String(label), value: String(value) }));
      const sections = [
        ['Acceptance criteria', text('Microsoft.VSTS.Common.AcceptanceCriteria')],
        ['Repro steps', text('Microsoft.VSTS.TCM.ReproSteps')],
        ['System info', text('Microsoft.VSTS.TCM.SystemInfo')],
      ]
        .filter(([, b]) => b)
        .map(([title, body]) => ({ title: title!, body: body! }));
      const pullRequests: TicketDetails['pullRequests'] = [];
      const related: TicketDetails['related'] = [];
      for (const r of w.relations ?? []) {
        // vstfs:///Git/PullRequestId/<project id>%2F<repository id>%2F<PR id> (the code may live in another project)
        const pr = /^vstfs:\/\/\/Git\/PullRequestId\/([^%]+)%2[Ff]([^%]+)%2[Ff](\d+)/.exec(r.url);
        if (pr) {
          pullRequests.push({ id: pr[3], url: `https://dev.azure.com/${e(o)}/${pr[1]}/_git/${pr[2]}/pullrequest/${pr[3]}` });
          continue;
        }
        const wi = /\/workItems\/(\d+)$/i.exec(r.url);
        if (wi) {
          const kind = r.attributes?.name ?? (r.rel.includes('Hierarchy-Reverse') ? 'Parent' : r.rel.includes('Hierarchy-Forward') ? 'Child' : 'Related');
          related.push({ id: wi[1], kind, url: this.ticketUrl(wi[1], { organization: o, project: ticket.project ?? this.project }) });
        }
      }
      let comments: TicketDetails['comments'] = [];
      try {
        const c = await this.request<{ comments: { text: string; createdBy: { displayName: string }; createdDate: string }[] }>(
          'GET',
          `https://dev.azure.com/${e(o)}/${e(ticket.project ?? this.project)}/_apis/wit/workItems/${e(id)}/comments?$top=50&order=desc&api-version=7.1-preview.4`,
          undefined,
          'application/json',
          o,
        );
        comments = c.comments.map((x) => ({ author: x.createdBy.displayName, date: Date.parse(x.createdDate), body: x.text }));
      } catch (err) {
        log.info(`Work item ${id}: comments unavailable (${err instanceof Error ? err.message : err})`);
      }
      return {
        ticket,
        format: 'html',
        description: text('System.Description'),
        sections,
        fields,
        tags: String(f['System.Tags'] ?? '')
          .split(';')
          .map((t) => t.trim())
          .filter(Boolean),
        comments,
        pullRequests,
        related,
        changed: f['System.ChangedDate'] ? Date.parse(String(f['System.ChangedDate'])) : undefined,
      };
    }
    return undefined;
  }

  async activateTicket(id: string, org = this.org): Promise<void> {
    await this.setTicketState(id, 'Active', org);
  }

  async setTicketState(id: string, state: string, org = this.org): Promise<void> {
    await this.patchWorkItem(id, '/fields/System.State', state, org);
  }

  async assignTicketToMe(id: string, org = this.org): Promise<void> {
    const me = await this.request<{ authenticatedUser: { properties?: { Account?: { $value?: string } }; providerDisplayName?: string } }>(
      'GET',
      `https://dev.azure.com/${e(org)}/_apis/connectionData`,
      undefined,
      'application/json',
      org,
    );
    const user = me.authenticatedUser.properties?.Account?.$value ?? me.authenticatedUser.providerDisplayName;
    if (!user) {
      throw new Error('Azure DevOps: could not tell who you are.');
    }
    await this.patchWorkItem(id, '/fields/System.AssignedTo', user, org);
  }

  /** The states of the ticket's work item type, in the process order. */
  async ticketStates(id: string, org = this.org): Promise<{ name: string; category?: string }[]> {
    const w = await this.request<{ fields: Record<string, unknown> }>(
      'GET',
      `https://dev.azure.com/${e(org)}/_apis/wit/workitems/${e(id)}?fields=System.WorkItemType,System.TeamProject&${API}`,
      undefined,
      'application/json',
      org,
    );
    const project = String(w.fields['System.TeamProject']);
    const type = String(w.fields['System.WorkItemType']);
    const data = await this.request<{ value: { name: string; category?: string }[] }>(
      'GET',
      `https://dev.azure.com/${e(org)}/${e(project)}/_apis/wit/workitemtypes/${e(type)}/states?api-version=7.1-preview.1`,
      undefined,
      'application/json',
      org,
    );
    return data.value.map((s) => ({ name: s.name, category: s.category }));
  }

  /** Adds a comment (plain text, shown as HTML paragraphs). */
  async commentTicket(id: string, text: string, org = this.org): Promise<void> {
    const w = await this.request<{ fields: Record<string, unknown> }>(
      'GET',
      `https://dev.azure.com/${e(org)}/_apis/wit/workitems/${e(id)}?fields=System.TeamProject&${API}`,
      undefined,
      'application/json',
      org,
    );
    const html = text
      .trim()
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c).replace(/\n/g, '<br>')}</p>`)
      .join('');
    await this.request(
      'POST',
      `https://dev.azure.com/${e(org)}/${e(String(w.fields['System.TeamProject']))}/_apis/wit/workItems/${e(id)}/comments?api-version=7.1-preview.4`,
      { text: html },
      'application/json',
      org,
    );
  }

  private async patchWorkItem(id: string, field: string, value: string, org: string): Promise<void> {
    await this.request(
      'PATCH',
      `https://dev.azure.com/${e(org)}/_apis/wit/workitems/${e(id)}?${API}`,
      [{ op: 'add', path: field, value }],
      'application/json-patch+json',
      org,
    );
  }

  /** Projects of an organization, to pick ticket sources. */
  async listProjects(org = this.org): Promise<{ name: string; description?: string }[]> {
    const data = await this.request<{ value: { name: string; description?: string }[] }>(
      'GET',
      `https://dev.azure.com/${e(org)}/_apis/projects?$top=500&${API}`,
      undefined,
      'application/json',
      org,
    );
    return data.value.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listPullRequests(): Promise<PullRequest[]> {
    const [data, me, mine] = await Promise.all([
      this.request<{ value: AzPullRequest[] }>('GET', `${this.repoApi}/pullrequests?searchCriteria.status=active&$top=100&${API}`),
      this.currentUserId().catch(() => ''),
      this.myReviewerIds().catch(() => new Set<string>()),
    ]);
    return data.value.map((pr) => this.toPullRequest(pr, me, mine));
  }

  /** `mine`: my id and my teams' ids, so a PR asking one of my teams is "to review". */
  private toPullRequest(pr: AzPullRequest, me: string, mine = new Set([me])): PullRequest {
    let group: PullRequest['group'] = 'other';
    if (pr.createdBy.id === me) {
      group = 'mine';
    } else if (pr.reviewers?.some((r) => mine.has(r.id))) {
      group = 'review';
    }
    const myVote = pr.reviewers?.find((r) => r.id === me)?.vote ?? 0;
    return {
      id: String(pr.pullRequestId),
      label: `!${pr.pullRequestId}`,
      title: pr.title,
      sourceBranch: stripHeads(pr.sourceRefName),
      targetBranch: stripHeads(pr.targetRefName),
      author: pr.createdBy.displayName,
      url: this.pullRequestUrl(pr.pullRequestId),
      isDraft: !!pr.isDraft,
      group,
      created: pr.creationDate ? Date.parse(pr.creationDate) : undefined,
      // Votes: 10 approved, 5 approved with suggestions, -5 waiting for author, -10 rejected.
      review: pr.reviewers?.some((r) => r.vote < 0)
        ? 'changes'
        : pr.reviewers?.some((r) => r.vote > 0)
          ? 'approved'
          : 'waiting',
      needsMyReview: myVote === 0 && !!pr.reviewers?.some((r) => mine.has(r.id)),
    };
  }

  /** Pull request with its description, reviewers, work items, commits and discussion. */
  async getPullRequestDetails(id: string): Promise<PullRequestDetails> {
    type AzPrFull = Omit<AzPullRequest, 'reviewers'> & {
      description?: string;
      status: string;
      mergeStatus?: string;
      reviewers?: { id: string; vote: number; displayName: string; isRequired?: boolean }[];
      lastMergeSourceCommit?: { commitId: string };
    };
    const base = `${this.repoApi}/pullrequests/${e(id)}`;
    const [pr, me, mine, items, commits, threads] = await Promise.all([
      this.request<AzPrFull>('GET', `${base}?${API}`),
      this.currentUserId().catch(() => ''),
      this.myReviewerIds().catch(() => new Set<string>()),
      this.request<{ value: { id: string }[] }>('GET', `${base}/workitems?${API}`).catch(() => ({ value: [] })),
      this.request<{ value: { commitId: string; comment: string; author: { name: string; date: string } }[] }>('GET', `${base}/commits?$top=100&${API}`).catch(() => ({ value: [] })),
      this.request<{
        value: { id: number; status?: string; isDeleted?: boolean; threadContext?: { filePath?: string; rightFileStart?: { line: number } }; comments: { content?: string; commentType?: string; author: { displayName: string }; publishedDate: string }[] }[];
      }>('GET', `${base}/threads?${API}`).catch(() => ({ value: [] })),
    ]);
    const vote = (v: number): PullRequestDetails['reviewers'][number]['vote'] =>
      v >= 10 ? 'approved' : v >= 5 ? 'suggestions' : v <= -10 ? 'rejected' : v < 0 ? 'waiting' : 'none';
    return {
      pr: this.toPullRequest(pr, me, mine),
      status: pr.status,
      description: pr.description,
      mergeStatus: pr.mergeStatus,
      reviewers: (pr.reviewers ?? []).map((r) => ({ name: r.displayName, vote: vote(r.vote), required: r.isRequired })),
      workItems: items.value.map((w) => ({ id: String(w.id), url: this.ticketUrl(w.id) })),
      commits: commits.value.map((c) => ({ sha: c.commitId, subject: (c.comment ?? '').split('\n')[0], author: c.author?.name ?? '', date: Date.parse(c.author?.date ?? '') })),
      comments: threads.value
        .filter((t) => !t.isDeleted)
        .flatMap((t) =>
          t.comments
            .filter((c) => c.commentType === 'text' && c.content)
            .map((c) => ({ author: c.author.displayName, date: Date.parse(c.publishedDate), body: c.content!, file: t.threadContext?.filePath })),
        )
        .sort((a, b) => a.date - b.date),
      threads: threads.value
        .filter((t) => !t.isDeleted && t.comments.some((c) => c.commentType === 'text' && c.content))
        .map((t) => ({
          id: String(t.id),
          status: t.status,
          file: t.threadContext?.filePath,
          line: t.threadContext?.rightFileStart?.line,
          comments: t.comments
            .filter((c) => c.commentType === 'text' && c.content)
            .map((c) => ({ author: c.author.displayName, date: Date.parse(c.publishedDate), body: c.content! })),
        })),
      myVote: (() => {
        const mine = pr.reviewers?.find((r) => r.id === me);
        return mine ? vote(mine.vote) : undefined;
      })(),
      amReviewer: !!pr.reviewers?.some((r) => mine.has(r.id)),
      lastSourceCommit: pr.lastMergeSourceCommit?.commitId,
    };
  }

  private repoId?: Promise<string>;
  /** Repository GUID (the build API filters by it). */
  private repositoryId(): Promise<string> {
    this.repoId ??= this.request<{ id: string }>('GET', `${this.repoApi}?${API}`).then((r) => r.id);
    this.repoId.catch(() => (this.repoId = undefined));
    return this.repoId;
  }

  async pipelineRuns(o: { prId?: string; max?: number; branch?: string }): Promise<PipelineRun[]> {
    const repositoryId = await this.repositoryId();
    const q = o.prId ? `&branchName=${e(`refs/pull/${o.prId}/merge`)}` : o.branch ? `&branchName=${e(`refs/heads/${o.branch}`)}` : '';
    const data = await this.request<{
      value: { id: number; definition: { id: number; name: string }; status: string; result?: string; sourceVersion: string; sourceBranch: string; startTime?: string; finishTime?: string; _links: { web: { href: string } } }[];
    }>('GET', `${this.projectUrl}/_apis/build/builds?repositoryId=${e(repositoryId)}&repositoryType=TfsGit&$top=${o.max ?? 60}&queryOrder=queueTimeDescending${q}&${API}`);
    return data.value.map((b) => ({
      id: String(b.id),
      definitionId: String(b.definition.id),
      name: b.definition.name,
      state:
        b.status === 'inProgress' ? 'running'
        : b.status === 'notStarted' || b.status === 'postponed' ? 'queued'
        : b.result === 'succeeded' ? 'succeeded'
        : b.result === 'partiallySucceeded' ? 'partial'
        : b.result === 'canceled' ? 'canceled'
        : 'failed',
      url: b._links.web.href,
      sha: b.sourceVersion,
      branch: stripHeads(b.sourceBranch),
      finished: b.finishTime ? Date.parse(b.finishTime) : undefined,
      started: b.startTime ? Date.parse(b.startTime) : undefined,
    }));
  }

  /** Queues a new run of the same pipeline on the same commit. */
  async rerunPipeline(run: PipelineRun): Promise<void> {
    await this.request('POST', `${this.projectUrl}/_apis/build/builds?${API}`, {
      definition: { id: Number(run.definitionId) },
      sourceBranch: run.branch ? `refs/heads/${run.branch}` : undefined,
      sourceVersion: run.sha,
    });
  }

  async cancelPipeline(run: PipelineRun): Promise<void> {
    await this.request('PATCH', `${this.projectUrl}/_apis/build/builds/${e(run.id)}?${API}`, { status: 'cancelling' });
  }

  /** Jobs and their tasks, from the build timeline. */
  async pipelineJobs(run: PipelineRun): Promise<PipelineJob[]> {
    const data = await this.request<{
      records: { id: string; parentId?: string; type: string; name: string; state?: string; result?: string; order?: number; log?: { id: number } }[];
    }>('GET', `${this.projectUrl}/_apis/build/builds/${e(run.id)}/timeline?${API}`);
    const state = (r: { state?: string; result?: string }): PipelineJob['state'] =>
      r.state === 'inProgress' ? 'running'
      : r.state === 'pending' ? 'queued'
      : r.result === 'succeeded' ? 'succeeded'
      : r.result === 'succeededWithIssues' ? 'partial'
      : r.result === 'canceled' || r.result === 'skipped' ? 'canceled'
      : r.result ? 'failed'
      : 'queued';
    const byOrder = (a: { order?: number }, b: { order?: number }) => (a.order ?? 0) - (b.order ?? 0);
    const records = data.records ?? [];
    return records
      .filter((r) => r.type === 'Job')
      .sort(byOrder)
      .map((j) => ({
        id: j.id,
        name: j.name,
        state: state(j),
        logId: j.log ? String(j.log.id) : undefined,
        steps: records
          .filter((t) => t.type === 'Task' && t.parentId === j.id)
          .sort(byOrder)
          .map((t) => ({ id: t.id, name: t.name, state: state(t), logId: t.log ? String(t.log.id) : undefined })),
      }));
  }

  async pipelineLog(run: PipelineRun, job: PipelineJob): Promise<string> {
    if (!job.logId) {
      return '';
    }
    return this.requestText(`${this.projectUrl}/_apis/build/builds/${e(run.id)}/logs/${e(job.logId)}?${API}`);
  }

  async votePullRequest(id: string, vote: ReviewVote, comment?: string): Promise<void> {
    const me = await this.currentUserId();
    const value = { approve: 10, suggestions: 5, reset: 0, wait: -5, reject: -10 }[vote];
    await this.request('PUT', `${this.repoApi}/pullRequests/${e(id)}/reviewers/${e(me)}?${API}`, { vote: value });
    if (comment?.trim()) {
      await this.commentPullRequest(id, comment);
    }
  }

  async requestMyReview(id: string): Promise<void> {
    const me = await this.currentUserId();
    await this.request('PUT', `${this.repoApi}/pullRequests/${e(id)}/reviewers/${e(me)}?${API}`, { vote: 0, isRequired: false });
  }

  async commentPullRequest(id: string, text: string, threadId?: string): Promise<void> {
    if (threadId) {
      await this.request('POST', `${this.repoApi}/pullRequests/${e(id)}/threads/${e(threadId)}/comments?${API}`, { content: text, parentCommentId: 1, commentType: 1 });
    } else {
      await this.request('POST', `${this.repoApi}/pullRequests/${e(id)}/threads?${API}`, { comments: [{ parentCommentId: 0, content: text, commentType: 1 }], status: 'active' });
    }
  }

  async resolveThread(id: string, threadId: string, resolved: boolean): Promise<void> {
    await this.request('PATCH', `${this.repoApi}/pullRequests/${e(id)}/threads/${e(threadId)}?${API}`, { status: resolved ? 'fixed' : 'active' });
  }

  async updatePullRequest(
    id: string,
    change: { publish?: boolean; abandon?: boolean; complete?: { strategy: 'squash' | 'noFastForward' | 'rebase' | 'rebaseMerge'; deleteSourceBranch: boolean; lastSourceCommit: string; message?: string; transitionWorkItems?: boolean } },
  ): Promise<void> {
    const body = change.publish
      ? { isDraft: false }
      : change.abandon
        ? { status: 'abandoned' }
        : {
            status: 'completed',
            lastMergeSourceCommit: { commitId: change.complete!.lastSourceCommit },
            completionOptions: {
              mergeStrategy: change.complete!.strategy,
              deleteSourceBranch: change.complete!.deleteSourceBranch,
              mergeCommitMessage: change.complete!.message,
              transitionWorkItems: !!change.complete!.transitionWorkItems,
            },
          };
    await this.request('PATCH', `${this.repoApi}/pullrequests/${e(id)}?${API}`, body);
  }

  async createPullRequest(o: CreatePullRequestOptions): Promise<PullRequest> {
    const me = o.addMeAsReviewer ? await this.currentUserId().catch(() => '') : '';
    const pr = await this.request<AzPullRequest>('POST', `${this.repoApi}/pullrequests?${API}`, {
      sourceRefName: `refs/heads/${o.source}`,
      targetRefName: `refs/heads/${o.target}`,
      title: o.title,
      description: o.description,
      isDraft: o.draft,
      workItemRefs: o.ticketIds.map((id) => ({ id })),
      reviewers: me ? [{ id: me, isRequired: false }] : undefined,
    });
    return this.toPullRequest(pr, pr.createdBy.id);
  }
}
