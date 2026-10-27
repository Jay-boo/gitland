/** What goes before a ticket id in labels and commit messages: "AB#12" (Azure DevOps), "#12" (GitHub, GitLab), "DATA-12" (Jira). */
export function ticketPrefix(provider: { kind: string; ticketKind?: 'jira' } | undefined): string {
  if (provider?.ticketKind === 'jira') {
    return '';
  }
  return provider?.kind === 'github' || provider?.kind === 'gitlab' ? '#' : 'AB#';
}

/** A ticket in titles and messages: "#12" for numbered tickets, a Jira key as it is ("DATA-12"). */
export function ticketLabel(id: string): string {
  return /^\d+$/.test(id) ? `#${id}` : id;
}

/** `git log -E --grep` pattern for commits that mention the ticket: "AB#12" / "#12", or a Jira key as a whole word. */
export function mentionGrep(id: string, provider: { kind: string; ticketKind?: 'jira' } | undefined): string {
  return provider?.ticketKind === 'jira' ? `(^|[^A-Za-z0-9_/-])${id}([^0-9]|$)` : `(AB)?#${id}([^0-9]|$)`;
}

/** Completing a PR can close its linked work items: Azure DevOps, and only when they are its own (not Jira issues). */
export function closesHostWorkItems(provider: { kind: string; ticketKind?: 'jira' }): boolean {
  return provider.kind === 'azure' && provider.ticketKind !== 'jira';
}
