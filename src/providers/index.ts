import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { AzureDevOpsProvider } from './azureDevOps';
import { GitHubProvider } from './github';
import { GitLabProvider } from './gitlab';
import { resolveRemoteUrl } from './remote';
import { Provider } from './types';

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
  for (const remote of remotes) {
    // The GitLab hosts setting is part of the key, so editing it takes effect without a reload.
    const key = `${remote.url}|${gitlabHosts.join(',')}`;
    const cached = cache.get(repo.root);
    if (cached && cached.key === key) {
      return cached.provider;
    }
    const info = await resolveRemoteUrl(remote.url, undefined, gitlabHosts);
    if (!info) {
      continue;
    }
    const provider =
      info.kind === 'azure' ? new AzureDevOpsProvider(info.org, info.project, info.repo, secrets)
      : info.kind === 'gitlab' ? new GitLabProvider(info.host, info.path, secrets)
      : new GitHubProvider(info.owner, info.repo);
    cache.set(repo.root, { key, provider });
    return provider;
  }
  return undefined;
}
