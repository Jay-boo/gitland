export interface Ticket {
  id: string;
  title: string;
  type: string;
  state: string;
  url: string;
  assignee?: string;
  /** Where the ticket lives, e.g. the Azure DevOps organization and project it comes from. */
  org?: string;
  project?: string;
}

/** Everything the ticket page shows. Rich text is HTML (Azure DevOps) or markdown (GitHub). */
export interface TicketDetails {
  ticket: Ticket;
  format: 'html' | 'markdown';
  description?: string;
  /** Azure DevOps "Acceptance Criteria" / "Repro Steps". */
  sections: { title: string; body: string }[];
  /** Label → value (priority, iteration, area, created by…). */
  fields: { label: string; value: string }[];
  tags: string[];
  comments: { author: string; date: number; body: string }[];
  pullRequests: { id: string; url: string }[];
  /** Parent / child / related work items. */
  related: { id: string; kind: string; url: string }[];
  changed?: number;
}

/** An Azure DevOps project the tickets come from (setting gitland.tickets.sources). */
export interface TicketSource {
  organization: string;
  project: string;
  /** WIQL for "My Tickets" in this project (default: gitland.azureDevOps.wiql). */
  wiql?: string;
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
  /** Review outcome so far: approved, changes requested, or nobody voted yet. */
  review?: 'approved' | 'changes' | 'waiting';
  /** I am a reviewer (by name or through a team) and have not voted yet, even on my own PR. */
  needsMyReview?: boolean;
}

/** Everything the pull request page shows (description is markdown on both hosts). */
export interface PullRequestDetails {
  pr: PullRequest;
  status: 'active' | 'completed' | 'abandoned' | 'merged' | 'closed' | string;
  description?: string;
  reviewers: { name: string; vote: 'approved' | 'suggestions' | 'waiting' | 'rejected' | 'none'; required?: boolean }[];
  workItems: { id: string; url: string }[];
  commits: { sha: string; subject: string; author: string; date: number }[];
  comments: { author: string; date: number; body: string; file?: string }[];
  /** Discussion threads (Azure DevOps; GitHub: one thread per comment). */
  threads?: { id: string; status?: string; file?: string; line?: number; comments: { author: string; date: number; body: string }[] }[];
  /** Id of the signed-in user among the reviewers (to show "your vote"). */
  myVote?: PullRequestDetails['reviewers'][number]['vote'];
  /** True when the signed-in user is asked to review (by name, or through a team / group). */
  amReviewer?: boolean;
  /** Last commit of the source branch (needed to complete the PR). */
  lastSourceCommit?: string;
  /** e.g. "conflicts", "succeeded" (Azure DevOps), "clean" / "dirty" (GitHub). */
  mergeStatus?: string;
}

/** A CI run (Azure Pipelines build, GitHub check). */
export interface PipelineRun {
  name: string;
  state: 'succeeded' | 'failed' | 'running' | 'queued' | 'canceled' | 'partial';
  url: string;
  sha?: string;
  branch?: string;
  finished?: number;
}

export type ReviewVote = 'approve' | 'suggestions' | 'wait' | 'reject' | 'reset';

export interface CreatePullRequestOptions {
  source: string;
  target: string;
  title: string;
  description: string;
  draft: boolean;
  ticketIds: string[];
  /** Add the creator as an optional reviewer (Azure DevOps; GitHub refuses the author). */
  addMeAsReviewer?: boolean;
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
  getTicketDetails?(id: string, org?: string): Promise<TicketDetails | undefined>;
  activateTicket?(id: string, org?: string): Promise<void>;
  /** States the ticket can move to (Azure DevOps: its work item type's states; GitHub: open / closed). */
  ticketStates?(id: string, org?: string): Promise<{ name: string; category?: string }[]>;
  setTicketState?(id: string, state: string, org?: string): Promise<void>;
  assignTicketToMe?(id: string, org?: string): Promise<void>;
  commentTicket?(id: string, text: string, org?: string): Promise<void>;
  /** Where tickets are read from, for the Tickets view title (e.g. "Backlog"). */
  readonly ticketSourceLabel?: string;
  listPullRequests(): Promise<PullRequest[]>;
  getPullRequestDetails?(id: string): Promise<PullRequestDetails>;
  /** Latest CI runs of the repository (by commit), or of a pull request. */
  pipelineRuns?(o: { prId?: string; max?: number }): Promise<PipelineRun[]>;
  votePullRequest?(id: string, vote: ReviewVote, comment?: string): Promise<void>;
  /** Add the signed-in user as a reviewer, so the PR shows under "to review". */
  requestMyReview?(id: string): Promise<void>;
  commentPullRequest?(id: string, text: string, threadId?: string): Promise<void>;
  resolveThread?(id: string, threadId: string, resolved: boolean): Promise<void>;
  /** Publish a draft, complete (merge) or abandon. transitionWorkItems: close the linked work items (Azure DevOps). */
  updatePullRequest?(id: string, change: { publish?: boolean; abandon?: boolean; complete?: { strategy: 'squash' | 'noFastForward' | 'rebase' | 'rebaseMerge'; deleteSourceBranch: boolean; lastSourceCommit: string; message?: string; transitionWorkItems?: boolean } }): Promise<void>;
  createPullRequest(options: CreatePullRequestOptions): Promise<PullRequest>;
  /** Profile picture of a commit author (URL or data URI), when the host has a real one. */
  avatarFor?(email: string, sha?: string): Promise<string | undefined>;
  commitUrl(sha: string): string;
  branchUrl(branch: string): string;
  ticketUrl(id: number | string): string;
  pullRequestUrl(id: number | string): string;
}

export class AuthError extends Error {
  /** True when the user was already told about it (no extra error popup needed). */
  constructor(message: string, readonly handled = false) {
    super(message);
  }
}
