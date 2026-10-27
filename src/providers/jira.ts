import * as vscode from 'vscode';
import { log } from '../log';
import { once } from './gitlabMap.pure';
import {
  adfBody, apiBase, isJiraSource, JiraComment, jiraErrorMessage, jiraFlavour, JiraIssue, keyOf, mergeTickets, myTicketsJql, normalizeSite,
  parseTicketId, searchJql, TICKET_FIELDS, toDetails, toTicket,
} from './jiraMap.pure';
import { AuthError, JiraTicketSource, Ticket, TicketDetails, TicketSource } from './types';

/** The Jira entries of gitland.tickets.sources (for the folder of `scope` when given). */
export function jiraSources(scope?: vscode.Uri): JiraTicketSource[] {
  return vscode.workspace
    .getConfiguration('gitland', scope)
    .get<TicketSource[]>('tickets.sources', [])
    .filter((s): s is JiraTicketSource => isJiraSource(s) && !!s.site && !!s.project);
}

/** Configured Jira sites, normalized. */
export function jiraSites(scope?: vscode.Uri): string[] {
  return [...new Set(jiraSources(scope).map((s) => normalizeSite(s.site)))];
}

/** Credentials are stored per site: Cloud = email + API token, Server / Data Center = personal access token. */
export const jiraTokenKey = (site: string) => `gitland.jira.token:${normalizeSite(site)}`;

interface JiraCredentials {
  email?: string;
  token: string;
}

async function ask(o: { title: string; prompt: string; value?: string; password?: boolean; createUrl?: string }): Promise<string | undefined> {
  const input = vscode.window.createInputBox();
  input.title = o.title;
  input.prompt = o.prompt;
  input.value = o.value ?? '';
  input.password = !!o.password;
  input.ignoreFocusOut = true;
  if (o.createUrl) {
    input.buttons = [{ iconPath: new vscode.ThemeIcon('link-external'), tooltip: 'Create token' }];
  }
  const value = await new Promise<string | undefined>((resolve) => {
    input.onDidTriggerButton(() => o.createUrl && vscode.env.openExternal(vscode.Uri.parse(o.createUrl)));
    input.onDidAccept(() => {
      resolve(input.value);
      input.hide();
    });
    input.onDidHide(() => resolve(undefined));
    input.show();
  });
  input.dispose();
  return value;
}

/** Asks for the credentials of a site, stores them (an empty token removes them) and returns them. */
export async function promptJiraToken(site: string, secrets: vscode.SecretStorage): Promise<JiraCredentials | undefined> {
  site = normalizeSite(site);
  const cloud = jiraFlavour(site) === 'cloud';
  let email: string | undefined;
  if (cloud) {
    const old = await secrets.get(jiraTokenKey(site));
    email = (await ask({ title: `Jira sign-in for ${site} (1/2)`, prompt: 'Your Atlassian account email', value: old ? (JSON.parse(old) as JiraCredentials).email : '' }))?.trim();
    if (!email) {
      return undefined;
    }
  }
  const token = await ask({
    title: cloud ? `Jira sign-in for ${site} (2/2)` : `Jira personal access token for ${site}`,
    prompt: `${cloud ? 'API token' : 'Personal access token'}. Leave empty to remove it.`,
    password: true,
    createUrl: cloud
      ? 'https://id.atlassian.com/manage-profile/security/api-tokens'
      : `${site}/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens`,
  });
  if (token === undefined) {
    return undefined;
  }
  if (!token.trim()) {
    await secrets.delete(jiraTokenKey(site));
    return undefined;
  }
  const creds: JiraCredentials = { email, token: token.trim() };
  await secrets.store(jiraTokenKey(site), JSON.stringify(creds));
  return creds;
}

/** "Gitland: Set Jira Token": one of the configured sites, or another one. */
export async function setJiraToken(sites: string[], secrets: vscode.SecretStorage): Promise<boolean> {
  const other = '$(add) Other site…';
  let site: string | undefined = sites.length === 1 ? sites[0] : (await vscode.window.showQuickPick([...sites, other], { placeHolder: 'Jira site' }));
  if (site === other || (!site && !sites.length)) {
    site = (await vscode.window.showInputBox({ title: 'Jira site', placeHolder: 'https://your-company.atlassian.net', ignoreFocusOut: true }))?.trim();
  }
  if (!site) {
    return false;
  }
  const creds = await promptJiraToken(site, secrets);
  if (creds) {
    vscode.window.showInformationMessage(`Gitland: Jira token saved for ${normalizeSite(site)}.`);
  }
  return true;
}

interface JiraUser {
  accountId?: string;
  name?: string;
  displayName?: string;
}

interface JiraTransition {
  id: string;
  name: string;
  to?: { statusCategory?: { key?: string } };
}

/** The ticket half of a provider, read from Jira projects (gitland.tickets.sources entries of type "jira"). */
export class JiraTickets {
  readonly ticketKind = 'jira' as const;
  readonly ticketNoun = 'issue';
  readonly ticketKeys: Record<string, string> = {};
  readonly sites: string[];
  private readonly users = new Map<string, { token: string; user: Promise<JiraUser> }>();

  constructor(private readonly sources: JiraTicketSource[], private readonly secrets: vscode.SecretStorage) {
    this.sources = sources.map((s) => ({ ...s, site: normalizeSite(s.site), project: s.project.toUpperCase() }));
    for (const s of this.sources) {
      this.ticketKeys[s.project] ??= s.site;
    }
    this.sites = [...new Set(this.sources.map((s) => s.site))];
  }

  get ticketSourceLabel(): string {
    return `Jira · ${this.sources.map((s) => s.project).join(', ')}`;
  }

  private siteOf(id: string, org?: string): string {
    return org ? normalizeSite(org) : this.ticketKeys[keyOf(id)] ?? this.sites[0];
  }

  ticketUrl(id: number | string): string {
    return `${this.siteOf(String(id))}/browse/${id}`;
  }

  async isSignedIn(): Promise<boolean> {
    const all = await Promise.all(this.sites.map((s) => this.secrets.get(jiraTokenKey(s))));
    return all.every(Boolean);
  }

  private async credentials(site: string): Promise<JiraCredentials> {
    const stored = await this.secrets.get(jiraTokenKey(site));
    // Parallel requests share one prompt.
    const creds = stored ? (JSON.parse(stored) as JiraCredentials) : await once(`jira:${site}`, () => promptJiraToken(site, this.secrets));
    if (!creds?.token) {
      throw new AuthError('Set a Jira token to continue.', true);
    }
    return creds;
  }

  private async request<T>(site: string, method: string, path: string, body?: unknown): Promise<T> {
    const creds = await this.credentials(site);
    const auth = jiraFlavour(site) === 'cloud' ? `Basic ${Buffer.from(`${creds.email ?? ''}:${creds.token}`).toString('base64')}` : `Bearer ${creds.token}`;
    const res = await fetch(`${apiBase(site)}${path}`, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'gitland-vscode' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 || (res.status === 403 && path === '/myself')) {
      throw new AuthError(`Jira rejected the token for ${site}. Run "Gitland: Set Jira Token".`);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => undefined);
      throw Object.assign(new Error(`Jira: ${jiraErrorMessage(data) ?? `${res.status} ${res.statusText}`}`), { status: res.status });
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async me(site: string): Promise<JiraUser> {
    const { token } = await this.credentials(site);
    const cached = this.users.get(site);
    if (cached?.token === token) {
      return cached.user;
    }
    const user = this.request<JiraUser>(site, 'GET', '/myself');
    user.catch(() => this.users.get(site)?.user === user && this.users.delete(site));
    this.users.set(site, { token, user });
    return user;
  }

  private async search(site: string, jql: string): Promise<(Ticket & { updated?: number })[]> {
    const body = { jql, fields: TICKET_FIELDS.split(','), maxResults: 50 };
    // Jira Cloud retired POST /search in favour of /search/jql; Server / Data Center only has /search.
    const res = await this.request<{ issues?: JiraIssue[] }>(site, 'POST', jiraFlavour(site) === 'cloud' ? '/search/jql' : '/search', body);
    return (res?.issues ?? []).map((i) => toTicket(i, site));
  }

  async listMyTickets(): Promise<Ticket[]> {
    const results = await Promise.allSettled(this.sources.map((s) => this.search(s.site, s.jql || myTicketsJql(s.project))));
    results.forEach((r, i) => r.status === 'rejected' && log.error(`Tickets from Jira ${this.sources[i].project} failed`, r.reason));
    const ok = results.filter((r): r is PromiseFulfilledResult<(Ticket & { updated?: number })[]> => r.status === 'fulfilled');
    if (!ok.length && results.length) {
      throw (results[0] as PromiseRejectedResult).reason;
    }
    return mergeTickets(ok.map((r) => r.value));
  }

  async searchTickets(text: string): Promise<Ticket[]> {
    const id = parseTicketId(text, this.sources.map((s) => s.project));
    if (id) {
      const t = await this.getTicket(id);
      return t ? [t] : [];
    }
    if (!text.trim()) {
      return [];
    }
    const lists = await Promise.all(
      this.sites.map((site) => this.search(site, searchJql(this.sources.filter((s) => s.site === site).map((s) => s.project), text.trim())).catch(() => [])),
    );
    return mergeTickets(lists);
  }

  async getTicket(id: string, org?: string): Promise<Ticket | undefined> {
    const key = parseTicketId(id, this.sources.map((s) => s.project)) ?? id;
    const site = this.siteOf(key, org);
    try {
      return toTicket(await this.request<JiraIssue>(site, 'GET', `/issue/${encodeURIComponent(key)}?fields=${TICKET_FIELDS}`), site);
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        return undefined;
      }
      throw e;
    }
  }

  async getTicketDetails(id: string, org?: string): Promise<TicketDetails | undefined> {
    const site = this.siteOf(id, org);
    const key = encodeURIComponent(id);
    try {
      const [issue, comments] = await Promise.all([
        this.request<JiraIssue>(site, 'GET', `/issue/${key}?expand=renderedFields`),
        this.request<{ comments?: JiraComment[] }>(site, 'GET', `/issue/${key}/comment?expand=renderedBody&orderBy=created`),
      ]);
      return toDetails(issue, comments?.comments ?? [], site);
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        return undefined;
      }
      throw e;
    }
  }

  private async transitions(id: string, org?: string): Promise<JiraTransition[]> {
    const res = await this.request<{ transitions?: JiraTransition[] }>(this.siteOf(id, org), 'GET', `/issue/${encodeURIComponent(id)}/transitions`);
    return res?.transitions ?? [];
  }

  /** Jira only allows the issue's transitions, so these are the "states" it can move to. */
  async ticketStates(id: string, org?: string): Promise<{ name: string; category?: string }[]> {
    return (await this.transitions(id, org)).map((t) => ({ name: t.name, category: t.to?.statusCategory?.key }));
  }

  private async transition(id: string, t: JiraTransition, org?: string): Promise<void> {
    await this.request(this.siteOf(id, org), 'POST', `/issue/${encodeURIComponent(id)}/transitions`, { transition: { id: t.id } });
  }

  async setTicketState(id: string, state: string, org?: string): Promise<void> {
    const t = (await this.transitions(id, org)).find((x) => x.name === state);
    if (!t) {
      throw new Error(`Jira: "${state}" is not available for ${id}.`);
    }
    await this.transition(id, t, org);
  }

  /** Start Work: the first transition into an "In Progress" status. */
  async activateTicket(id: string, org?: string): Promise<void> {
    const t = (await this.transitions(id, org)).find((x) => x.to?.statusCategory?.key === 'indeterminate');
    if (t) {
      await this.transition(id, t, org);
    }
  }

  async assignTicketToMe(id: string, org?: string): Promise<void> {
    const site = this.siteOf(id, org);
    const me = await this.me(site);
    await this.request(site, 'PUT', `/issue/${encodeURIComponent(id)}/assignee`, jiraFlavour(site) === 'cloud' ? { accountId: me.accountId } : { name: me.name });
  }

  async commentTicket(id: string, text: string, org?: string): Promise<void> {
    const site = this.siteOf(id, org);
    await this.request(site, 'POST', `/issue/${encodeURIComponent(id)}/comment`, { body: jiraFlavour(site) === 'cloud' ? adfBody(text) : text });
  }

  /** Projects of a site, for "Add a Jira project…". */
  async listProjects(site: string): Promise<{ key: string; name: string }[]> {
    site = normalizeSite(site);
    if (jiraFlavour(site) !== 'cloud') {
      return (await this.request<{ key: string; name: string }[]>(site, 'GET', '/project')).map((p) => ({ key: p.key, name: p.name }));
    }
    const out: { key: string; name: string }[] = [];
    for (let startAt = 0; ; ) {
      const page = await this.request<{ values: { key: string; name: string }[]; isLast?: boolean }>(site, 'GET', `/project/search?maxResults=100&startAt=${startAt}`);
      out.push(...page.values.map((p) => ({ key: p.key, name: p.name })));
      startAt += page.values.length;
      if (page.isLast !== false || !page.values.length) {
        return out;
      }
    }
  }
}
