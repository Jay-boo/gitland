import * as fs from 'fs/promises';
import * as path from 'path';
import { Repo } from './git/repo';

/**
 * The repository's pull request template, the way Azure DevOps and GitHub look for it:
 * a template for the target branch first (Azure DevOps: .azuredevops/pull_request_template/branches/<target>.md),
 * then pull_request_template.md in .azuredevops/, .vsts/, .github/, docs/ or the root (any case).
 * Read from the target branch when it is available (that is the one the host uses), else the working tree.
 */
export async function findPullRequestTemplate(repo: Repo, targetRef: string, target: string): Promise<{ path: string; text: string } | undefined> {
  const files = await listFiles(repo, targetRef);
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
  const text = await readFile(repo, targetRef, file);
  return text?.trim() ? { path: file, text } : undefined;
}

async function listFiles(repo: Repo, ref: string): Promise<string[]> {
  const out = await repo.exec(['ls-tree', '-r', '--name-only', ref]).catch(() => repo.exec(['ls-files']).catch(() => ''));
  return out.split('\n').filter((f) => /pull_request_template/i.test(f));
}

async function readFile(repo: Repo, ref: string, file: string): Promise<string | undefined> {
  try {
    return await repo.exec(['show', `${ref}:${file}`]);
  } catch {
    return fs.readFile(path.join(repo.root, file), 'utf8').catch(() => undefined);
  }
}
