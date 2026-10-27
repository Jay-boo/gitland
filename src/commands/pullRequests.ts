import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { checkoutRef } from '../graph/graphPanel';
import { PullRequest } from '../providers/types';

export function ticketIdFromBranch(branch: string): string | undefined {
  const m = /(?:^|[/_-])#?(\d{1,7})(?=$|[/_-])/.exec(branch);
  return m?.[1];
}

/**
 * Ticket ids mentioned in commit messages (subject + body), in order of first appearance. Catches the
 * Azure DevOps PR merge commits ("Related work items: #12, #34", "AB#12", "Merge feature/12-x into dev"),
 * so a dev → main pull request links every ticket merged into dev since the last release.
 * GitHub / GitLab: only closing keywords ("Fixes #12") and merged branch names; "#12" alone is often a PR.
 */
export function ticketIdsFromMessages(messages: string[], kind: 'azure' | 'github' | 'gitlab'): string[] {
  const ids = new Set<string>();
  const add = (id: string | undefined) => id && ids.add(String(Number(id)));
  for (const msg of messages) {
    const subject = msg.split('\n', 1)[0];
    const merged =
      /^Merged PR \d+: Merge (\S+) into \S+/.exec(subject)?.[1] ??
      /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject)?.[1] ??
      /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject)?.[1];
    if (merged) {
      add(ticketIdFromBranch(merged));
    }
    for (const m of msg.matchAll(/^Related work items:(.*)$/gim)) {
      for (const n of m[1].matchAll(/#(\d+)/g)) {
        add(n[1]);
      }
    }
    for (const m of msg.matchAll(/\bAB#(\d+)/g)) {
      add(m[1]);
    }
    const mention = kind === 'azure' ? /(?<![\w&#])#(\d+)\b/g : /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
    for (const m of msg.matchAll(mention)) {
      add(m[1]);
    }
  }
  return [...ids];
}

export function humanize(branch: string): string {
  const last = branch.split('/').pop() ?? branch;
  const words = last.replace(/^\d+[-_]?/, '').replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : branch;
}

export async function checkoutPullRequest(repo: Repo, pr: PullRequest): Promise<void> {
  const remote = (await repo.defaultRemote()) ?? 'origin';
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Checking out ${pr.label}…` },
    async () => {
      await repo.fetch().catch(() => undefined);
      if (await repo.localBranchExists(pr.sourceBranch)) {
        await repo.checkout(pr.sourceBranch);
        try {
          await repo.exec(['merge', '--ff-only', `${remote}/${pr.sourceBranch}`]);
        } catch {
          /* local branch diverged; leave it */
        }
      } else {
        await checkoutRef(repo, `${remote}/${pr.sourceBranch}`, true);
      }
    },
  );
}
