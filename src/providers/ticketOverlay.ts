import type { CreatePullRequestOptions, PullRequest, Provider } from './types';

/** What a ticket tracker that is not the code host (Jira) provides. */
export type TicketBackend = Pick<
  Provider,
  | 'ticketNoun' | 'ticketSourceLabel' | 'ticketKind' | 'ticketKeys' | 'isSignedIn' | 'listMyTickets' | 'searchTickets' | 'getTicket'
  | 'getTicketDetails' | 'activateTicket' | 'ticketStates' | 'setTicketState' | 'assignTicketToMe' | 'commentTicket' | 'ticketUrl'
>;

/** Host members that are forwarded as they are (optional ones stay undefined when the host has none). */
const HOST = [
  'listPullRequests', 'getPullRequestDetails', 'pipelineRuns', 'rerunPipeline', 'cancelPipeline', 'pipelineJobs', 'pipelineLog',
  'votePullRequest', 'requestMyReview', 'commentPullRequest', 'resolveThread', 'updatePullRequest', 'avatarFor',
  'commitUrl', 'branchUrl', 'pullRequestUrl', 'releaseUrl',
] as const;

/** Ticket members taken from the tracker, never from the host (no mixing of Jira and host tickets). */
const TICKETS = [
  'listMyTickets', 'searchTickets', 'getTicket', 'getTicketDetails', 'activateTicket', 'ticketStates', 'setTicketState',
  'assignTicketToMe', 'commentTicket', 'ticketUrl',
] as const;

/** "DATA-12: Fix login": Jira's GitHub / GitLab / Azure DevOps integrations link a PR by the key in its title. */
export function withKey(title: string, key: string | undefined): string {
  return !key || title.toLowerCase().includes(key.toLowerCase()) ? title : `${key}: ${title}`;
}

export interface TicketOverlay extends Provider {}

/**
 * A code host whose tickets come from another tracker (Jira): pull requests, pipelines and URLs are the
 * host's, tickets are the tracker's.
 */
export class TicketOverlay {
  readonly kind: Provider['kind'];
  readonly displayName: string;
  readonly ticketNoun: string;
  readonly ticketSourceLabel?: string;
  readonly ticketKind?: 'jira';
  readonly ticketKeys?: Record<string, string>;

  constructor(readonly host: Provider, readonly tickets: TicketBackend) {
    this.kind = host.kind;
    this.displayName = host.displayName;
    this.ticketNoun = tickets.ticketNoun;
    this.ticketSourceLabel = tickets.ticketSourceLabel;
    this.ticketKind = tickets.ticketKind;
    this.ticketKeys = tickets.ticketKeys;
    const self = this as unknown as Record<string, unknown>;
    for (const [from, names] of [[host, HOST], [tickets, TICKETS]] as const) {
      for (const name of names) {
        const fn = (from as unknown as Record<string, unknown>)[name];
        self[name] = typeof fn === 'function' ? fn.bind(from) : undefined;
      }
    }
  }

  /** Signed in to the code host (pull requests, pipelines). */
  isSignedIn(): Promise<boolean> {
    return this.host.isSignedIn();
  }

  /** Signed in to the ticket tracker. */
  ticketsSignedIn(): Promise<boolean> {
    return this.tickets.isSignedIn();
  }

  /** Ticket ids are not host work items: the first key goes into the title instead. */
  createPullRequest(o: CreatePullRequestOptions): Promise<PullRequest> {
    return this.host.createPullRequest({ ...o, ticketIds: [], title: withKey(o.title, o.ticketIds[0]) });
  }
}

/** The code host behind a provider (for host-specific checks such as `instanceof AzureDevOpsProvider`). */
export function hostOf<P extends Provider | undefined>(provider: P): P | Provider {
  return provider instanceof TicketOverlay ? provider.host : provider;
}
