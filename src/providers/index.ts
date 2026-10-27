import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { AzureDevOpsProvider } from './azureDevOps';
import { GitHubProvider } from './github';
import { GitLabProvider } from './gitlab';
import { JiraTickets, jiraSources } from './jira';
import { resolveRemoteUrl } from './remote';
import { TicketOverlay } from './ticketOverlay';
import { Provider } from './types';

/**
 * Command that signs in to the provider's host, and the host's name for "Sign in to …".
 * `part: 'tickets'` is the ticket tracker's sign-in (Jira when the tickets come from Jira).
 */
export function signIn(provider: Provider | Provider['kind'], part: 'host' | 'tickets' = 'host'): { command: string; host: string } {
  if (part === 'tickets' && typeof provider === 'object' && provider.ticketKind === 'jira') {
    return { command: 'gitland.setJiraToken', host: 'Jira' };
  }
  const kind = typeof provider === 'object' ? provider.kind : provider;
  return kind === 'azure' ? { command: 'gitland.switchAzureAccount', host: 'Azure DevOps' }
    : kind === 'gitlab' ? { command: 'gitland.setGitLabToken', host: 'GitLab' }
    : { command: 'gitland.switchGitHubAccount', host: 'GitHub' };
}

const cache = new Map<string, { key: string; provider: Provider }>();

/** Returns the hosting provider for the repo's default remote (origin first). */
export async function getProvider(repo: Repo, secrets: vscode.SecretStorage): Promise<Provider | undefined> {
  let remotes: { name: string; url: string }[];
  try {
    remotes = await repo.remotes();
  } catch {
    return undefined;
  }
  remotes.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
  const gitlabHosts = vscode.workspace.getConfiguration('gitland').get<string[]>('gitlab.hosts', []);
  const jira = jiraSources(vscode.Uri.file(repo.root));
  for (const remote of remotes) {
    // The GitLab hosts and Jira sources are part of the key, so editing them takes effect without a reload.
    const key = `${remote.url}|${gitlabHosts.join(',')}|${JSON.stringify(jira)}`;
    const cached = cache.get(repo.root);
    if (cached && cached.key === key) {
      return cached.provider;
    }
    const info = await resolveRemoteUrl(remote.url, undefined, gitlabHosts);
    if (!info) {
      continue;
    }
    const host =
      info.kind === 'azure' ? new AzureDevOpsProvider(info.org, info.project, info.repo, secrets)
      : info.kind === 'gitlab' ? new GitLabProvider(info.host, info.path, secrets)
      : new GitHubProvider(info.owner, info.repo);
    // Jira only for tickets: pull requests and pipelines stay on the code host.
    const provider = jira.length ? new TicketOverlay(host, new JiraTickets(jira, secrets)) : host;
    cache.set(repo.root, { key, provider });
    return provider;
  }
  return undefined;
}
