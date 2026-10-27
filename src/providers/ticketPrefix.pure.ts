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
