import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { AzureDevOpsProvider } from './azureDevOps';
import { GitHubProvider } from './github';
import { parseRemoteUrl } from './remote';
import { Provider } from './types';

const cache = new Map<string, { remoteUrl: string; provider: Provider }>();

/** Returns the hosting provider for the repo's default remote (origin first). */
export async function getProvider(repo: Repo, secrets: vscode.SecretStorage): Promise<Provider | undefined> {
  let remotes: { name: string; url: string }[];
  try {
    remotes = await repo.remotes();
  } catch {
    return undefined;
  }
  remotes.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
  for (const remote of remotes) {
    const cached = cache.get(repo.root);
    if (cached && cached.remoteUrl === remote.url) {
      return cached.provider;
    }
    const info = parseRemoteUrl(remote.url);
    if (!info) {
      continue;
    }
    const provider =
      info.kind === 'azure'
        ? new AzureDevOpsProvider(info.org, info.project, info.repo, secrets)
        : new GitHubProvider(info.owner, info.repo);
    cache.set(repo.root, { remoteUrl: remote.url, provider });
    return provider;
  }
  return undefined;
}
