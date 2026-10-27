import * as fs from 'fs/promises';
import * as path from 'path';
import { Repo } from './git/repo';

/**
 * The repository's pull request template, the way Azure DevOps and GitHub look for it:
 * a template for the target branch first (Azure DevOps: .azuredevops/pull_request_template/branches/<target>.md),
 * then pull_request_template.md in .azuredevops/, .vsts/, .github/, docs/ or the root (any case).
 * Azure DevOps reads it from the default branch, so look there first, then in the target branch, then the working tree
 * (a template committed on dev is found for a PR into main).
 */
export async function findPullRequestTemplate(repo: Repo, remote: string, target: string): Promise<{ path: string; text: string } | undefined> {
  const def = await repo.defaultBranch(remote).catch(() => undefined);
  const refs = [...new Set([def, target].filter((b): b is string => !!b).map((b) => `${remote}/${b}`))];
  for (const ref of refs) {
    const found = await findIn(repo, ref, target, () => repo.exec(['ls-tree', '-r', '--name-only', ref]));
    if (found) {
      return found;
    }
  }
  return findIn(repo, undefined, target, () => repo.exec(['ls-files']));
}

async function findIn(
  repo: Repo,
  ref: string | undefined,
  target: string,
  list: () => Promise<string>,
): Promise<{ path: string; text: string } | undefined> {
  const files = (await list().catch(() => '')).split('\n').filter((f) => /pull_request_template/i.test(f));
  const lower = new Map(files.map((f) => [f.toLowerCase(), f]));
  const branchName = target.toLowerCase();
  const candidates = [
    `.azuredevops/pull_request_template/branches/${branchName}.md`,
    `.azuredevops/pull_request_template/branches/${branchName}.txt`,
    `.vsts/pull_request_template/branches/${branchName}.md`,
    ...['.azuredevops/', '.vsts/', '.github/', 'docs/', ''].flatMap((dir) => [`${dir}pull_request_template.md`, `${dir}pull_request_template.txt`]),
  ];
  let file = candidates.map((c) => lower.get(c)).find(Boolean);
  // A folder of templates (GitHub .github/PULL_REQUEST_TEMPLATE/*.md): the first one.
  file ??= files.filter((f) => /^(\.github\/|docs\/)?pull_request_template\/[^/]+\.md$/i.test(f)).sort()[0];
  if (!file) {
    return undefined;
  }
  const text = ref
    ? await repo.exec(['show', `${ref}:${file}`]).catch(() => undefined)
    : await fs.readFile(path.join(repo.root, file), 'utf8').catch(() => undefined);
  return text?.trim() ? { path: file, text } : undefined;
}
