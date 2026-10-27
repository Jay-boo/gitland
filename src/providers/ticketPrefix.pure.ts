/** What goes before a ticket id in labels and commit messages: "AB#12" (Azure DevOps), "#12" (GitHub, GitLab), "DATA-12" (Jira). */
export function ticketPrefix(provider: { kind: string; ticketKind?: 'jira' } | undefined): string {
  if (provider?.ticketKind === 'jira') {
    return '';
  }
  return provider?.kind === 'github' || provider?.kind === 'gitlab' ? '#' : 'AB#';
}
