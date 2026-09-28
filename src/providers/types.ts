export interface Ticket {
  id: string;
  title: string;
  type: string;
  state: string;
  url: string;
  assignee?: string;
}

export type PullRequestGroup = 'mine' | 'review' | 'other';

export interface PullRequest {
  id: string;
  /** Display label, e.g. "!42" or "#42". */
  label: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  url: string;
  isDraft: boolean;
  group: PullRequestGroup;
  created?: number;
}

export interface CreatePullRequestOptions {
  source: string;
  target: string;
  title: string;
  description: string;
  draft: boolean;
  ticketIds: string[];
}

export interface Provider {
  readonly kind: 'azure' | 'github';
  readonly displayName: string;
  /** Name used in the UI for tickets, e.g. "work item" or "issue". */
  readonly ticketNoun: string;
  /** True when a request can be made without prompting the user to sign in. */
  isSignedIn(): Promise<boolean>;
  listMyTickets(): Promise<Ticket[]>;
  searchTickets(text: string): Promise<Ticket[]>;
  getTicket(id: string): Promise<Ticket | undefined>;
  activateTicket?(id: string): Promise<void>;
  listPullRequests(): Promise<PullRequest[]>;
  createPullRequest(options: CreatePullRequestOptions): Promise<PullRequest>;
  commitUrl(sha: string): string;
  branchUrl(branch: string): string;
}

export class AuthError extends Error {}
