import { Commit } from '../git/repo';

export interface GraphFilters {
  /** Only commits by the current git user. */
  mine?: boolean;
  noMerges?: boolean;
  /** Author name or email. */
  author?: string;
  /** Only commits of the last N days. */
  sinceDays?: number;
  /**
   * What the graph shows: every branch (default), the history of one branch, or its timeline
   * (first parents only: each merged branch is one merge commit).
   */
  scope?: 'all' | 'branch' | 'timeline';
  /** The branch for 'branch' / 'timeline' (default: the current branch). */
  ref?: string;
}

export function hasFilters(f: GraphFilters): boolean {
  return !!(f.mine || f.noMerges || f.author || f.sinceDays);
}

export function commitMatcher(f: GraphFilters, me: { email?: string; name?: string }): (c: Commit) => boolean {
  const email = me.email?.toLowerCase();
  const name = me.name?.toLowerCase();
  const author = f.author?.toLowerCase();
  const since = f.sinceDays ? Date.now() - f.sinceDays * 86400e3 : 0;
  return (c) =>
    (!f.noMerges || c.parents.length <= 1) &&
    (!f.mine || (!!email && c.email.toLowerCase() === email) || (!!name && c.author.toLowerCase() === name)) &&
    (!author || c.email.toLowerCase() === author || c.author.toLowerCase() === author) &&
    (!since || c.date >= since);
}

/**
 * Keeps the commits that match and rewrites their parents to the nearest kept ancestors,
 * so the graph stays connected (git's own parent rewriting does not apply to --author etc.).
 * `commits` must be in topological order (children first).
 */
export function filterCommits(commits: Commit[], keep: (c: Commit) => boolean): Commit[] {
  const nearest = new Map<string, string[]>();
  const kept = new Set<string>();
  const resolve = (parents: string[]) => [...new Set(parents.flatMap((p) => nearest.get(p) ?? [p]))];
  // Parents come after their children: walk from the end so each parent is resolved first.
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i];
    if (keep(c)) {
      kept.add(c.sha);
      nearest.set(c.sha, [c.sha]);
    } else {
      nearest.set(c.sha, resolve(c.parents));
    }
  }
  return commits.filter((c) => kept.has(c.sha)).map((c) => ({ ...c, parents: resolve(c.parents) }));
}

/** Inserts stash entries above the commit they were made on, at their date. */
export function insertStashes(list: Commit[], stashes: Commit[]): Commit[] {
  const out = [...list];
  for (const s of stashes) {
    const base = out.findIndex((c) => c.sha === s.parents[0]);
    if (base < 0) {
      continue;
    }
    let at = out.findIndex((c) => c.date < s.date);
    if (at < 0 || at > base) {
      at = base;
    }
    out.splice(at, 0, s);
  }
  return out;
}
