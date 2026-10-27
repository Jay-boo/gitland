import type { JiraTicketSource, Ticket, TicketDetails, TicketSource } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The parts of a Jira issue the ticket views use (REST v2 and v3 share them). */
export interface JiraIssue {
  key: string;
  fields: Record<string, any>;
  /** With ?expand=renderedFields: HTML rendered by Jira (both Cloud and Server). */
  renderedFields?: Record<string, any>;
}

export interface JiraComment {
  author?: { displayName?: string };
  created?: string;
  /** With ?expand=renderedBody. */
  renderedBody?: string;
  /** Plain text (Server) or an ADF document (Cloud). */
  body?: unknown;
}

export type JiraFlavour = 'cloud' | 'server';

export function isJiraSource(s: TicketSource): s is JiraTicketSource {
  return !!s && s.type === 'jira';
}

/** Jira Cloud sites are on atlassian.net; anything else is Server / Data Center. */
export function jiraFlavour(site: string): JiraFlavour {
  try {
    return new URL(site).hostname.toLowerCase().endsWith('.atlassian.net') ? 'cloud' : 'server';
  } catch {
    return 'server';
  }
}

/** "ACME.atlassian.net/" → "https://acme.atlassian.net". A Server context path (/jira) is kept. */
export function normalizeSite(input: string): string {
  const raw = input.trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

export function apiBase(site: string): string {
  return `${site}/rest/api/${jiraFlavour(site) === 'cloud' ? 3 : 2}`;
}

/** An issue key from what the user typed: "data-12" → "DATA-12", "12" / "#12" → "<first project>-12". */
export function parseTicketId(text: string, keys: string[]): string | undefined {
  const t = text.trim();
  const key = /^([a-z][a-z0-9_]*)-(\d+)$/i.exec(t);
  if (key) {
    return `${key[1].toUpperCase()}-${key[2]}`;
  }
  const n = /^#?(\d+)$/.exec(t);
  return n && keys.length ? `${keys[0]}-${n[1]}` : undefined;
}

/** "DATA-12" for the given project keys, as a whole word (not "XDATA-12", "UTF-8", nor inside a URL path). */
export function jiraKeyPattern(keys: string[]): RegExp {
  const alt = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?<![\\w/-])(${alt || '(?!)'})-\\d+\\b`, 'g');
}

/** Issue keys of the given projects mentioned in a text, in order of first appearance. */
export function jiraKeysIn(text: string, keys: string[]): string[] {
  return [...new Set([...text.matchAll(jiraKeyPattern(keys))].map((m) => m[0]))];
}

/** "feature/DATA-12-fix-login" → "DATA-12" (case-insensitive, configured projects only). */
export function jiraKeyFromBranch(branch: string, keys: string[]): string | undefined {
  const m = /(?:^|[/_])([a-z][a-z0-9_]*)-(\d+)(?=$|[/_-])/i.exec(branch);
  return m && keys.includes(m[1].toUpperCase()) ? `${m[1].toUpperCase()}-${m[2]}` : undefined;
}

export function keyOf(id: string): string {
  return id.replace(/-\d+$/, '').toUpperCase();
}

/** A JQL string literal. */
export function jqlString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function myTicketsJql(project: string): string {
  return `project = ${jqlString(project)} AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`;
}

export function searchJql(keys: string[], text: string): string {
  return `project in (${keys.map(jqlString).join(', ')}) AND text ~ ${jqlString(text)} ORDER BY updated DESC`;
}

/** Fields the lists ask for. */
export const TICKET_FIELDS = 'summary,issuetype,status,assignee,project,updated';

const time = (s: unknown) => (typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? Date.parse(s) : undefined);
const browse = (site: string, key: string) => `${site}/browse/${key}`;

export function toTicket(issue: JiraIssue, site: string): Ticket & { updated?: number } {
  const f = issue.fields ?? {};
  return {
    id: issue.key,
    title: f.summary ?? '',
    type: f.issuetype?.name ?? 'Issue',
    state: f.status?.name ?? '',
    assignee: f.assignee?.displayName ?? undefined,
    url: browse(site, issue.key),
    org: site,
    project: f.project?.key ?? issue.key.replace(/-\d+$/, ''),
    updated: time(f.updated),
  };
}

/** Tickets of several sources, most recently updated first. */
export function mergeTickets(lists: (Ticket & { updated?: number })[][]): Ticket[] {
  return lists.flat().sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
}

/** The sprint field has no fixed id: the first custom field holding sprints (objects on Cloud, strings on Server). */
function sprintOf(fields: Record<string, any>): string | undefined {
  for (const [k, v] of Object.entries(fields)) {
    if (!k.startsWith('customfield_') || !Array.isArray(v) || !v.length) {
      continue;
    }
    if (v.every((s) => s && typeof s === 'object' && 'name' in s && 'state' in s)) {
      return (v.find((s) => String(s.state).toLowerCase() === 'active') ?? v[v.length - 1]).name;
    }
    if (v.every((s) => typeof s === 'string' && /Sprint@/.test(s))) {
      const parsed = v.map((s: string) => ({ name: /name=([^,\]]+)/.exec(s)?.[1], state: /state=([^,\]]+)/.exec(s)?.[1] }));
      return (parsed.find((s) => s.state?.toLowerCase() === 'active') ?? parsed[parsed.length - 1]).name;
    }
  }
  return undefined;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Plain text of an ADF document (Cloud comment bodies without renderedBody). */
function adfText(node: any): string {
  if (!node || typeof node !== 'object') {
    return '';
  }
  if (node.type === 'text') {
    return node.text ?? '';
  }
  const inner = (node.content ?? []).map(adfText).join('');
  return node.type === 'paragraph' || node.type === 'heading' ? `${inner}\n` : inner;
}

export function toDetails(issue: JiraIssue, comments: JiraComment[], site: string): TicketDetails {
  const f = issue.fields ?? {};
  const fields: TicketDetails['fields'] = [];
  const add = (label: string, value: unknown) => typeof value === 'string' && value && fields.push({ label, value });
  add('Status', f.status?.name);
  add('Priority', f.priority?.name);
  add('Reporter', f.reporter?.displayName);
  add('Sprint', sprintOf(f));
  add('Fix versions', (f.fixVersions ?? []).map((v: any) => v.name).join(', '));
  add('Due date', f.duedate);
  const related: TicketDetails['related'] = [];
  const rel = (key: string | undefined, kind: string) => key && related.push({ id: key, kind, url: browse(site, key) });
  rel(f.parent?.key, 'parent');
  for (const s of f.subtasks ?? []) {
    rel(s.key, 'child');
  }
  for (const l of f.issuelinks ?? []) {
    l.outwardIssue ? rel(l.outwardIssue.key, l.type?.outward ?? 'related') : rel(l.inwardIssue?.key, l.type?.inward ?? 'related');
  }
  return {
    ticket: toTicket(issue, site),
    format: 'html',
    description: issue.renderedFields?.description || undefined,
    sections: [],
    fields,
    tags: [...(f.labels ?? []), ...(f.components ?? []).map((c: any) => c.name)],
    comments: comments.map((c) => ({
      author: c.author?.displayName ?? '',
      date: time(c.created) ?? 0,
      body: c.renderedBody ?? escapeHtml(typeof c.body === 'string' ? c.body : adfText(c.body).trim()),
    })),
    pullRequests: [],
    related,
    changed: time(f.updated),
  };
}

/** A Cloud (v3) comment body: one paragraph per line. */
export function adfBody(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
  };
}

/** The message of a Jira error response. */
export function jiraErrorMessage(body: unknown): string | undefined {
  const b = body as { errorMessages?: string[]; errors?: Record<string, string>; message?: string } | undefined;
  if (!b || typeof b !== 'object') {
    return undefined;
  }
  if (b.errorMessages?.length) {
    return b.errorMessages.join(' ');
  }
  const errors = Object.entries(b.errors ?? {});
  if (errors.length) {
    return errors.map(([k, v]) => `${k}: ${v}`).join(', ');
  }
  return b.message || undefined;
}
