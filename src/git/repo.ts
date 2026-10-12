import * as path from 'path';
import { runGit } from './exec';
import { GitApiRepository } from './gitApi';
import { notebookDiff, notebookLines } from './notebookDiff';

export const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';
export const WORKTREE_SHA = 'WORKTREE';

export type RefType = 'head' | 'branch' | 'remote' | 'tag' | 'stash';

export interface Ref {
  type: RefType;
  name: string;
  /** True for the branch HEAD points to. */
  current?: boolean;
}

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  subject: string;
  refs: Ref[];
}

export interface FileChange {
  status: string;
  path: string;
  oldPath?: string;
  /** Lines added / deleted (undefined for binary files). */
  added?: number;
  deleted?: number;
}

export interface CommitDetails {
  sha: string;
  author: string;
  email: string;
  authorDate: number;
  committer: string;
  commitDate: number;
  message: string;
  parents: string[];
  files: FileChange[];
}

export interface Release {
  name: string;
  sha: string;
  date: number;
  author: string;
  /** Message subject of an annotated tag. */
  subject: string;
  annotated: boolean;
  previous?: string;
  commits: number;
  pullRequests: number;
}

/** Orders "v3.10.0" after "v3.9.2" (numbers compared as numbers; pre-releases before releases). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+(?:\.\d+)*)(.*)$/.exec(v);
    return m ? { nums: m[1].split('.').map(Number), pre: m[2] } : undefined;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) {
    return x ? 1 : y ? -1 : a.localeCompare(b);
  }
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) {
      return d;
    }
  }
  if (x.pre === y.pre) {
    return 0;
  }
  return !x.pre ? 1 : !y.pre ? -1 : x.pre.localeCompare(y.pre);
}

export interface ComparedCommit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  subject: string;
}

/** First lines of a file's diff, for the hover previews of the file lists. */
export interface DiffPreview {
  lines: string[];
  /** Lines left out. */
  more: number;
  binary?: boolean;
  /** Shown instead of an empty diff, e.g. a notebook whose outputs only changed. */
  note?: string;
}

const PREVIEW_LINES = 400;

/** One side of a previewed change: a git object (`rev` '' = the index) or the file on disk. */
export type PreviewSide = { rev: string; path: string } | { file: string } | undefined;

export interface RefComparison {
  from: string;
  to: string;
  /** In `to`, not in `from`. */
  ahead: ComparedCommit[];
  /** In `from`, not in `to`. */
  behind: ComparedCommit[];
  files: FileChange[];
  mergeBase?: { sha: string; subject: string; date: number };
}

export interface TimelineEntry {
  sha: string;
  author: string;
  email: string;
  date: number;
  subject: string;
  body: string;
  /** Path of the file at that commit (renames). */
  path: string;
  added?: number;
  deleted?: number;
  /** Line history: the diff of the lines at that commit. */
  patch?: string;
}

export interface RepoOperation {
  kind: 'rebase' | 'merge' | 'cherry-pick' | 'revert';
  branch?: string;
  onto?: string;
  step?: number;
  total?: number;
  title?: string;
}

export interface RepoStatus {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  conflicts: FileChange[];
}

export interface BlameCommit {
  sha: string;
  author: string;
  email: string;
  date: number;
  summary: string;
  previous?: { sha: string; path: string };
  filename: string;
}

export interface Branch {
  name: string;
  shortName: string;
  remote: boolean;
  sha: string;
  upstream?: string;
  current: boolean;
}

export interface HistoryEntry {
  sha: string;
  author: string;
  date: number;
  subject: string;
  path: string;
}

const FS = '\x1f';
const RS = '\x1e';

export class Repo {
  private remoteNamesCache?: Promise<string[]>;

  constructor(public readonly root: string, public readonly api?: GitApiRepository) {}

  exec(args: string[], input?: string, env?: Record<string, string>): Promise<string> {
    return runGit(this.root, args, input, env);
  }

  /**
   * Hunks of a file's diff for a hover preview. `args`: the git diff / show command (without
   * formatting options); `untracked`: a new file not in git yet, shown as all added.
   * `sides`: both versions of the file, to compare a Jupyter notebook by its cells only.
   */
  async diffPreview(args: string[], untracked?: string, sides?: { path: string; before: PreviewSide; after: PreviewSide }): Promise<DiffPreview> {
    let lines: string[];
    if (sides && /\.ipynb$/i.test(sides.path)) {
      const [before, after] = await Promise.all([this.previewText(sides.before), this.previewText(sides.after)]);
      lines = notebookDiff(notebookLines(before), notebookLines(after));
      if (!lines.length) {
        return { lines, more: 0, note: 'No code change: only outputs, execution counts or metadata.' };
      }
    } else if (untracked) {
      const fs = await import('fs');
      const text = await fs.promises.readFile(path.join(this.root, untracked), 'utf8').catch(() => '');
      if (text.includes('\0')) {
        return { lines: [], more: 0, binary: true };
      }
      lines = text.split('\n').map((l) => `+${l}`);
    } else {
      const [cmd, ...rest] = args;
      const out = await this.exec([cmd, '--no-color', '-M', '-U2', ...rest]).catch(() => '');
      if (/^Binary files /m.test(out)) {
        return { lines: [], more: 0, binary: true };
      }
      const body = out.split('\n');
      const start = body.findIndex((l) => l.startsWith('@@'));
      lines = start < 0 ? [] : body.slice(start).filter((l) => !l.startsWith('\\ No newline'));
    }
    while (lines.length && (lines[lines.length - 1] === '' || lines[lines.length - 1] === '+')) {
      lines.pop();
    }
    return { lines: lines.slice(0, PREVIEW_LINES), more: Math.max(0, lines.length - PREVIEW_LINES) };
  }

  private async previewText(side: PreviewSide): Promise<string> {
    if (!side) {
      return '';
    }
    if ('file' in side) {
      const fs = await import('fs');
      return fs.promises.readFile(path.join(this.root, side.file), 'utf8').catch(() => '');
    }
    return this.exec(['show', `${side.rev}:${side.path}`]).catch(() => '');
  }

  /** Merge, rebase, cherry-pick or revert in progress (stopped on conflicts or an "edit" step). */
  async operation(): Promise<RepoOperation | undefined> {
    const fs = await import('fs');
    const p = async (name: string) => {
      const rel = (await this.exec(['rev-parse', '--git-path', name])).trim();
      return path.isAbsolute(rel) ? rel : path.join(this.root, rel);
    };
    const exists = async (name: string) => fs.existsSync(await p(name));
    if ((await exists('rebase-merge')) || (await exists('rebase-apply'))) {
      const dir = (await exists('rebase-merge')) ? await p('rebase-merge') : await p('rebase-apply');
      const read = (f: string) => {
        try {
          return fs.readFileSync(path.join(dir, f), 'utf8').trim();
        } catch {
          return '';
        }
      };
      const onto = read('onto');
      const head = read('head-name').replace(/^refs\/heads\//, '');
      const step = Number(read('msgnum') || read('next')) || 0;
      const total = Number(read('end') || read('last')) || 0;
      return { kind: 'rebase', branch: head || undefined, onto: onto ? onto.slice(0, 7) : undefined, step, total };
    }
    if (await exists('MERGE_HEAD')) {
      const msg = fs.readFileSync(await p('MERGE_MSG'), 'utf8').split('\n')[0] ?? '';
      return { kind: 'merge', title: msg };
    }
    if (await exists('CHERRY_PICK_HEAD')) {
      return { kind: 'cherry-pick' };
    }
    if (await exists('REVERT_HEAD')) {
      return { kind: 'revert' };
    }
    return undefined;
  }

  relativePath(fsPath: string): string {
    return path.relative(this.root, fsPath).split(path.sep).join('/');
  }

  invalidate(): void {
    this.remoteNamesCache = undefined;
  }

  async currentBranch(): Promise<string | undefined> {
    try {
      const name = (await this.exec(['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
      return name || undefined;
    } catch {
      return undefined;
    }
  }

  async headSha(): Promise<string | undefined> {
    try {
      return (await this.exec(['rev-parse', 'HEAD'])).trim();
    } catch {
      return undefined;
    }
  }

  async userEmail(): Promise<string | undefined> {
    return this.getConfig('user.email');
  }

  async getConfig(key: string): Promise<string | undefined> {
    try {
      return (await this.exec(['config', '--get', key])).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.exec(['config', key, value]);
  }

  async remotes(): Promise<{ name: string; url: string }[]> {
    const out = await this.exec(['remote', '-v']);
    const seen = new Map<string, string>();
    for (const line of out.split('\n')) {
      const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line);
      if (m && !seen.has(m[1])) {
        seen.set(m[1], m[2]);
      }
    }
    return [...seen].map(([name, url]) => ({ name, url }));
  }

  remoteNames(): Promise<string[]> {
    this.remoteNamesCache ??= this.remotes().then((r) => r.map((x) => x.name)).catch(() => []);
    return this.remoteNamesCache;
  }

  async defaultRemote(): Promise<string | undefined> {
    const names = await this.remoteNames();
    return names.includes('origin') ? 'origin' : names[0];
  }

  /** Default branch name on the remote (without remote prefix), e.g. "main". */
  async defaultBranch(remote?: string): Promise<string | undefined> {
    remote ??= await this.defaultRemote();
    if (remote) {
      try {
        const ref = (await this.exec(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])).trim();
        if (ref.startsWith(remote + '/')) {
          return ref.slice(remote.length + 1);
        }
      } catch {
        /* origin/HEAD is not always set */
      }
    }
    const branches = await this.branches();
    for (const candidate of ['main', 'master', 'develop', 'dev']) {
      if (branches.some((b) => b.shortName === candidate || (remote && b.shortName === `${remote}/${candidate}`))) {
        return candidate;
      }
    }
    return undefined;
  }

  async branches(): Promise<Branch[]> {
    const out = await this.exec([
      'for-each-ref',
      `--format=%(refname)${FS}%(refname:short)${FS}%(objectname)${FS}%(upstream:short)${FS}%(HEAD)`,
      'refs/heads',
      'refs/remotes',
    ]);
    const result: Branch[] = [];
    for (const line of out.split('\n')) {
      if (!line) {
        continue;
      }
      const [name, shortName, sha, upstream, head] = line.split(FS);
      if (name.endsWith('/HEAD')) {
        continue;
      }
      result.push({
        name,
        shortName,
        sha,
        upstream: upstream || undefined,
        remote: name.startsWith('refs/remotes/'),
        current: head === '*',
      });
    }
    return result;
  }

  async localBranchExists(name: string): Promise<boolean> {
    try {
      await this.exec(['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  async aheadBehind(branch: string): Promise<{ upstream?: string; ahead: number; behind: number }> {
    let upstream: string | undefined;
    try {
      upstream = (await this.exec(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])).trim();
    } catch {
      return { ahead: 0, behind: 0 };
    }
    const out = (await this.exec(['rev-list', '--left-right', '--count', `${branch}...${upstream}`])).trim();
    const [ahead, behind] = out.split(/\s+/).map(Number);
    return { upstream, ahead: ahead || 0, behind: behind || 0 };
  }

  async isDirty(): Promise<boolean> {
    const out = await this.exec(['status', '--porcelain', '--untracked-files=normal']);
    return out.trim().length > 0;
  }

  /** Stash entries as commits whose only parent is the commit they were made on. */
  async stashes(): Promise<Commit[]> {
    let out: string;
    try {
      out = await this.exec(['stash', 'list', `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%gd${FS}%s${RS}`]);
    } catch {
      return [];
    }
    const list: Commit[] = [];
    for (const record of out.split(RS)) {
      const r = record.replace(/^\n/, '');
      if (!r) {
        continue;
      }
      const [sha, parents, author, email, date, name, subject] = r.split(FS);
      list.push({
        sha,
        parents: parents ? [parents.split(' ')[0]] : [],
        author,
        email,
        date: Number(date) * 1000,
        // "WIP on dev: 1a2b3c4 subject" (git's default) → "WIP on dev"; "On dev: my message" → "my message"
        subject: (subject ?? '').replace(/^WIP on ([^:]+): .*$/, 'WIP on $1').replace(/^On [^:]+: /, ''),
        refs: [{ type: 'stash', name }],
      });
    }
    return list;
  }

  /**
   * Commits of `to` that are not in `from` (and the reverse), the files changed between them and
   * where they diverged: what a compare / release notes view shows.
   */
  async compare(from: string, to: string, max = 500): Promise<RefComparison> {
    const fmt = `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%s${RS}`;
    const parse = (out: string) =>
      out
        .split(RS)
        .map((r) => r.replace(/^\n/, ''))
        .filter(Boolean)
        .map((r) => {
          const [sha, parents, author, email, date, subject] = r.split(FS);
          return { sha, parents: parents ? parents.split(' ') : [], author, email, date: Number(date) * 1000, subject: subject ?? '' };
        });
    const [ahead, behind, base, nameStatus, numstat] = await Promise.all([
      this.exec(['log', `--max-count=${max}`, fmt, `${from}..${to}`]),
      this.exec(['log', `--max-count=${max}`, fmt, `${to}..${from}`]),
      this.exec(['merge-base', from, to]).catch(() => ''),
      this.exec(['diff', '--name-status', '-M', from, to]),
      this.exec(['diff', '--numstat', '-z', '-M', from, to]).catch(() => ''),
    ]);
    const files = parseNameStatus(nameStatus);
    applyNumstat(files, numstat);
    const mergeBase = base.trim() || undefined;
    let baseInfo: { sha: string; subject: string; date: number } | undefined;
    if (mergeBase) {
      const [subject, date] = (await this.exec(['show', '-s', `--format=%s${FS}%at`, mergeBase])).trim().split(FS);
      baseInfo = { sha: mergeBase, subject, date: Number(date) * 1000 };
    }
    return { from, to, ahead: parse(ahead), behind: parse(behind), files, mergeBase: baseInfo };
  }

  /** Tags, newest version first, with what each one added since the previous one. */
  async releases(max = 60): Promise<Release[]> {
    const out = await this.exec([
      'for-each-ref',
      '--sort=-creatordate',
      `--format=%(refname:short)${FS}%(objectname)${FS}%(*objectname)${FS}%(creatordate:unix)${FS}%(taggername)%(if)%(taggername)%(then)%(else)%(authorname)%(end)${FS}%(contents:subject)${FS}%(objecttype)`,
      'refs/tags',
    ]);
    const tags = out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, obj, peeled, date, who, subject, type] = l.split(FS);
        return { name, sha: peeled || obj, date: Number(date) * 1000, author: who, subject: type === 'tag' ? subject : '', annotated: type === 'tag' };
      })
      .sort((a, b) => compareVersions(b.name, a.name) || b.date - a.date)
      .slice(0, max);
    // What each tag added: commits (and PR merges) since the previous tag in its history.
    return Promise.all(
      tags.map(async (t) => {
        const previous = await this.previousTag(t.name);
        const range = previous ? `${previous}..${t.name}` : t.name;
        const [count, merges] = await Promise.all([
          this.exec(['rev-list', '--count', '--no-merges', range]).catch(() => '0'),
          this.exec(['log', '--merges', '--format=%s', range]).catch(() => ''),
        ]);
        const prs = merges.split('\n').filter((m) => /^(Merged PR \d+|Merge pull request #?\d+)/i.test(m)).length;
        return { ...t, previous, commits: Number(count.trim()) || 0, pullRequests: prs };
      }),
    );
  }

  /** The first release (tag) that contains a commit, e.g. "3.7.1" — undefined when not released yet. */
  async releaseOf(sha: string): Promise<string | undefined> {
    try {
      const out = await this.exec(['tag', '--contains', sha, '--sort=creatordate']);
      return out.split('\n').find(Boolean)?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** The tag before `tag` in its history (git describe), for "compare with previous tag". */
  async previousTag(tag: string): Promise<string | undefined> {
    try {
      return (await this.exec(['describe', '--tags', '--abbrev=0', `${tag}^`])).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Every local branch, remote branch and tag, most recent first. */
  async allRefs(): Promise<{ type: RefType; name: string; sha: string; date: number; current: boolean }[]> {
    const out = await this.exec([
      'for-each-ref',
      '--sort=-creatordate',
      `--format=%(refname)${FS}%(refname:short)${FS}%(objectname)${FS}%(*objectname)${FS}%(creatordate:unix)${FS}%(HEAD)`,
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ]);
    const refs = [];
    for (const line of out.split('\n')) {
      const [full, name, sha, peeled, date, head] = line.split(FS);
      if (!full || full.endsWith('/HEAD')) {
        continue;
      }
      const type: RefType = full.startsWith('refs/heads/') ? 'branch' : full.startsWith('refs/remotes/') ? 'remote' : 'tag';
      refs.push({ type, name, sha: peeled || sha, date: Number(date) * 1000, current: head === '*' });
    }
    return refs;
  }

  /**
   * Commits in topological order: of every ref (default), or of `refs` only.
   * `firstParent`: only the main line of those refs (merged branches become one merge commit).
   */
  async log(max: number, allRefs: boolean | { refs: string[]; firstParent?: boolean } = true): Promise<Commit[]> {
    const args = [
      'log',
      `--max-count=${max}`,
      '--topo-order',
      `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%D${FS}%s${RS}`,
    ];
    if (allRefs === true) {
      args.push('--exclude=refs/stash', '--all');
    } else if (allRefs) {
      if (allRefs.firstParent) {
        args.push('--first-parent');
      }
      args.push(...allRefs.refs, '--');
    }
    let out: string;
    try {
      out = await this.exec(args);
    } catch {
      return []; // empty repository
    }
    const remotes = await this.remoteNames();
    const commits: Commit[] = [];
    for (const record of out.split(RS)) {
      const r = record.replace(/^\n/, '');
      if (!r) {
        continue;
      }
      const [sha, parents, author, email, date, decorations, subject] = r.split(FS);
      commits.push({
        sha,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        date: Number(date) * 1000,
        subject: subject ?? '',
        refs: parseDecorations(decorations, remotes),
      });
    }
    return commits;
  }

  async commitDetails(sha: string): Promise<CommitDetails> {
    const out = await this.exec(['show', '-s', `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%cn${FS}%ct${FS}%B`, sha]);
    const [full, parents, author, email, ad, committer, cd, message] = out.split(FS);
    const parentList = parents ? parents.split(' ') : [];
    const diffArgs =
      parentList.length > 1
        ? ['diff', '--name-status', '-M', `${full}^1`, full]
        : ['diff-tree', '--no-commit-id', '-r', '-M', '--name-status', '--root', full];
    const [nameStatus, numstat] = await Promise.all([
      this.exec(diffArgs),
      this.exec([...diffArgs.filter((a) => a !== '--name-status'), '--numstat', '-z']).catch(() => ''),
    ]);
    const files = parseNameStatus(nameStatus);
    applyNumstat(files, numstat);
    return {
      sha: full,
      author,
      email,
      authorDate: Number(ad) * 1000,
      committer,
      commitDate: Number(cd) * 1000,
      message: (message ?? '').trim(),
      parents: parentList,
      files,
    };
  }

  async workingTreeChanges(): Promise<FileChange[]> {
    const out = await this.exec(['status', '--porcelain', '-z', '--untracked-files=all']);
    const entries = out.split('\0');
    const files: FileChange[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) {
        continue;
      }
      const xy = e.slice(0, 2);
      const p = e.slice(3);
      if (xy[0] === 'R' || xy[0] === 'C') {
        files.push({ status: 'R', path: p, oldPath: entries[++i] });
      } else if (xy === '??') {
        files.push({ status: 'U', path: p });
      } else {
        const s = xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : 'M';
        files.push({ status: s, path: p });
      }
    }
    return files;
  }

  /** Blame a file. Pass `contents` for unsaved documents. Returns one entry per line (index 0 = line 1). */
  async blame(relPath: string, contents?: string): Promise<{ lines: BlameCommit[] }> {
    const args = ['blame', '--line-porcelain', '-w'];
    if (contents !== undefined) {
      args.push('--contents', '-');
    }
    args.push('--', relPath);
    const out = await this.exec(args, contents);
    const commits = new Map<string, BlameCommit>();
    const lines: BlameCommit[] = [];
    const raw = out.split('\n');
    let i = 0;
    while (i < raw.length) {
      const header = raw[i++];
      if (!header) {
        continue;
      }
      const sha = header.split(' ')[0];
      const info: Record<string, string> = {};
      while (i < raw.length && !raw[i].startsWith('\t')) {
        const line = raw[i++];
        const sp = line.indexOf(' ');
        if (sp > 0) {
          info[line.slice(0, sp)] = line.slice(sp + 1);
        } else {
          info[line] = '';
        }
      }
      i++; // content line
      let commit = commits.get(sha);
      if (!commit) {
        let previous: BlameCommit['previous'];
        if (info.previous) {
          const sp = info.previous.indexOf(' ');
          previous = { sha: info.previous.slice(0, sp), path: info.previous.slice(sp + 1) };
        }
        commit = {
          sha,
          author: info.author ?? '',
          email: (info['author-mail'] ?? '').replace(/^<|>$/g, ''),
          date: Number(info['author-time'] ?? 0) * 1000,
          summary: info.summary ?? '',
          previous,
          filename: info.filename ?? relPath,
        };
        commits.set(sha, commit);
      }
      lines.push(commit);
    }
    return { lines };
  }

  async fileHistory(relPath: string, max = 200): Promise<HistoryEntry[]> {
    const out = await this.exec([
      'log',
      '--follow',
      `--max-count=${max}`,
      `--format=${RS}%H${FS}%an${FS}%at${FS}%s`,
      '--name-only',
      '--',
      relPath,
    ]);
    const entries: HistoryEntry[] = [];
    for (const record of out.split(RS)) {
      if (!record.trim()) {
        continue;
      }
      const lines = record.split('\n');
      const [sha, author, date, subject] = lines[0].split(FS);
      const file = lines.slice(1).filter((l) => l.trim()).pop() ?? relPath;
      entries.push({ sha, author, date: Number(date) * 1000, subject, path: file });
    }
    return entries;
  }

  async lineHistory(relPath: string, start: number, end: number, max = 100): Promise<HistoryEntry[]> {
    const out = await this.exec([
      'log',
      `-L${start},${end}:${relPath}`,
      `--max-count=${max}`,
      `--format=${RS}%H${FS}%an${FS}%at${FS}%s`,
    ]);
    const entries: HistoryEntry[] = [];
    for (const record of out.split(RS)) {
      if (!record.trim()) {
        continue;
      }
      const [sha, author, date, subject] = record.split('\n')[0].split(FS);
      entries.push({ sha, author, date: Number(date) * 1000, subject, path: relPath });
    }
    return entries;
  }

  /**
   * History of a file (following renames) or of a line range (git log -L, with the patch of those
   * lines at each commit), newest first.
   */
  async timeline(relPath: string, range?: { start: number; end: number }, max = 200): Promise<TimelineEntry[]> {
    const GS = '\x1d';
    const fmt = `--format=${RS}%H${FS}%an${FS}%ae${FS}%at${FS}%s${FS}%b${GS}`;
    const args = range
      ? ['log', `-L${range.start},${range.end}:${relPath}`, `--max-count=${max}`, fmt]
      : ['log', '--follow', `--max-count=${max}`, fmt, '--numstat', '--', relPath];
    const out = await this.exec(args);
    const entries: TimelineEntry[] = [];
    for (const record of out.split(RS)) {
      if (!record.trim()) {
        continue;
      }
      const cut = record.indexOf(GS);
      const [sha, author, email, date, subject, body] = record.slice(0, cut).split(FS);
      const rest = record.slice(cut + 1).replace(/^\n+/, '');
      const e: TimelineEntry = { sha, author, email, date: Number(date) * 1000, subject, body: (body ?? '').trim(), path: relPath };
      if (range) {
        e.patch = rest.trim();
        e.added = (rest.match(/^\+(?!\+\+)/gm) ?? []).length;
        e.deleted = (rest.match(/^-(?!--)/gm) ?? []).length;
        const m = /^\+\+\+ b\/(.+)$/m.exec(rest);
        if (m) {
          e.path = m[1];
        }
      } else {
        const line = rest.split('\n').find((l) => /^(\d+|-)\t(\d+|-)\t/.test(l));
        if (line) {
          const [a, d, ...p] = line.split('\t');
          e.added = a === '-' ? undefined : Number(a);
          e.deleted = d === '-' ? undefined : Number(d);
          // "dir/{old => new}.ts" or "old => new": the path at that commit.
          e.path = p.join('\t').replace(/\{[^{}]* => ([^{}]*)\}/, '$1').replace(/^.* => /, '').replace(/\/\//g, '/');
        }
      }
      entries.push(e);
    }
    return entries;
  }

  /** Signature of a commit: G good, B bad, U good but untrusted key, X/Y expired, R revoked, E cannot check, N none. */
  async signature(sha: string): Promise<{ status: string; signer?: string; key?: string } | undefined> {
    const out = await this.exec(['log', '-1', `--format=%G?${FS}%GS${FS}%GK`, sha]).catch(() => '');
    const [status, signer, key] = out.trim().split(FS);
    return status && status !== 'N' ? { status, signer: signer || undefined, key: key || undefined } : undefined;
  }

  /** Commit hooks that will run (pre-commit, commit-msg…), from core.hooksPath or .git/hooks. */
  async commitHooks(): Promise<string[]> {
    const fs = await import('fs');
    const custom = await this.getConfig('core.hooksPath');
    const dir = custom
      ? path.isAbsolute(custom) ? custom : path.join(this.root, custom)
      : path.join(this.root, (await this.exec(['rev-parse', '--git-path', 'hooks'])).trim());
    const names = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'];
    return names.filter((n) => {
      try {
        const st = fs.statSync(path.join(dir, n));
        return st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0);
      } catch {
        return false;
      }
    });
  }

  /** Patch of one file in one commit (against its first parent). */
  async filePatch(sha: string, relPath: string): Promise<string> {
    return this.exec(['show', '--format=', '--patch', '-M', '--first-parent', sha, '--', relPath]).catch(() => '');
  }

  /** Branch, upstream, ahead/behind and the staged / unstaged / conflicted files (git status v2). */
  async status(): Promise<RepoStatus> {
    const out = await this.exec(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
    const st: RepoStatus = { ahead: 0, behind: 0, staged: [], unstaged: [], conflicts: [] };
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (line.startsWith('# branch.head ')) {
        const b = line.slice(14);
        st.branch = b === '(detached)' ? undefined : b;
      } else if (line.startsWith('# branch.upstream ')) {
        st.upstream = line.slice(18);
      } else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(line);
        if (m) {
          st.ahead = Number(m[1]);
          st.behind = Number(m[2]);
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const f = line.split(' ');
        const xy = f[1];
        const renamed = line.startsWith('2 ');
        const file = f.slice(renamed ? 9 : 8).join(' ');
        const oldPath = renamed ? parts[++i] : undefined;
        if (xy[0] !== '.') {
          st.staged.push({ status: xy[0] === 'C' ? 'C' : xy[0], path: file, oldPath: xy[0] === 'R' || xy[0] === 'C' ? oldPath : undefined });
        }
        if (xy[1] !== '.') {
          st.unstaged.push({ status: xy[1], path: file });
        }
      } else if (line.startsWith('u ')) {
        st.conflicts.push({ status: '!', path: line.split(' ').slice(10).join(' ') });
      } else if (line.startsWith('? ')) {
        st.unstaged.push({ status: 'U', path: line.slice(2) });
      }
    }
    const [cached, work] = await Promise.all([
      this.exec(['diff', '--cached', '--numstat', '-z', '-M']).catch(() => ''),
      this.exec(['diff', '--numstat', '-z']).catch(() => ''),
    ]);
    applyNumstat(st.staged, cached);
    applyNumstat(st.unstaged, work);
    return st;
  }

  async fetch(): Promise<void> {
    if (this.api) {
      await this.api.fetch();
    } else {
      await this.exec(['fetch', '--prune']);
    }
  }

  async push(remote: string, branch: string, setUpstream: boolean): Promise<void> {
    if (this.api) {
      await this.api.push(remote, branch, setUpstream);
    } else {
      await this.exec(['push', ...(setUpstream ? ['-u'] : []), remote, branch]);
    }
  }

  async checkout(ref: string): Promise<void> {
    if (this.api) {
      await this.api.checkout(ref);
    } else {
      await this.exec(['checkout', ref]);
    }
  }
}

function parseDecorations(decorations: string, remotes: string[]): Ref[] {
  if (!decorations) {
    return [];
  }
  const refs: Ref[] = [];
  for (let d of decorations.split(', ')) {
    d = d.trim();
    if (!d) {
      continue;
    }
    if (d === 'HEAD') {
      refs.push({ type: 'head', name: 'HEAD' });
    } else if (d.startsWith('HEAD -> ')) {
      refs.push({ type: 'branch', name: d.slice(8), current: true });
    } else if (d.startsWith('tag: ')) {
      refs.push({ type: 'tag', name: d.slice(5) });
    } else if (remotes.some((r) => d.startsWith(r + '/'))) {
      if (!d.endsWith('/HEAD')) {
        refs.push({ type: 'remote', name: d });
      }
    } else {
      refs.push({ type: 'branch', name: d });
    }
  }
  return refs;
}

/** Adds line counts from `--numstat -z` output (renames are "a\td\t\0old\0new\0"). */
export function applyNumstat(files: FileChange[], out: string): void {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i].replace(/^\n/, ''));
    if (!m) {
      continue;
    }
    const path = m[3] || ((i += 2), parts[i]);
    const f = byPath.get(path);
    if (f && m[1] !== '-') {
      f.added = Number(m[1]);
      f.deleted = Number(m[2]);
    }
  }
}

function parseNameStatus(out: string): FileChange[] {
  const files: FileChange[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    const status = parts[0][0];
    if ((status === 'R' || status === 'C') && parts.length >= 3) {
      files.push({ status, oldPath: parts[1], path: parts[2] });
    } else {
      files.push({ status, path: parts[1] });
    }
  }
  return files;
}
