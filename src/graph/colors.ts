/**
 * Branch colors that mean something, instead of one color per lane in order of appearance:
 * main = blue, dev = green, feature = violet, fix = rose, hotfix = red, release = amber, chore = slate;
 * any other name always gets the same color. Indexes --gl-lane-0 … --gl-lane-10 (media/base.css), which
 * take the colours of the VS Code theme.
 */
export const BRANCH_COLORS = 11;
const OTHER_FIRST = 7;

export function branchColor(name: string): number {
  const n = name.toLowerCase().replace(/^refs\/(heads|remotes)\//, '');
  if (/^(main|master|trunk|prod|production)$/.test(n)) {
    return 0;
  }
  if (/^(dev|develop|development|staging|qa|qual|integration)$/.test(n)) {
    return 1;
  }
  if (/^(feat|feature|features)([/_-]|$)/.test(n)) {
    return 2;
  }
  if (/^(bug|bugfix|fix|fixes)([/_-]|$)/.test(n)) {
    return 3;
  }
  if (/^hotfix([/_-]|$)/.test(n)) {
    return 4;
  }
  if (/^(release|releases|rel)([/_-]|$)|^v?\d+\.\d+/.test(n)) {
    return 5;
  }
  if (/^(chore|ci|build|docs|refactor|test|tests|perf|style|deps)([/_-]|$)/.test(n)) {
    return 6;
  }
  let h = 0;
  for (const ch of n) {
    h = (h * 31 + ch.charCodeAt(0)) | 0;
  }
  return OTHER_FIRST + (Math.abs(h) % (BRANCH_COLORS - OTHER_FIRST));
}

/** Name of the branch a merge commit brought in, from its message (the branch is often deleted since). */
export function mergedBranchName(subject: string): string | undefined {
  const patterns = [
    /^Merge pull request #?\d+ from (?:[\w.-]+:)?(\S+?)(?: into \S+)?$/i, // Azure DevOps / GitHub ("owner:branch")
    /^Merge branch '([^']+)'/i,
    /^Merge remote-tracking branch '[^/']+\/([^']+)'/i,
    /^Merged PR \d+: (\w+)(?:\([^)]*\))?!?:/i, // Azure DevOps squash title "Merged PR 12: fix: …" → "fix"
  ];
  for (const p of patterns) {
    const m = p.exec(subject);
    if (m) {
      return m[1].replace(/^[^/]+\/(?=(main|master|dev|develop)$)/, '');
    }
  }
  return undefined;
}

/** Conventional commit type of a subject ("fix(api): …" → "fix"), used when no branch name is known. */
export function conventionalType(subject: string): string | undefined {
  return /^(\w+)(?:\([^)]*\))?!?:/.exec(subject)?.[1];
}
