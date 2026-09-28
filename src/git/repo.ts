import * as path from 'path';
import { runGit } from './exec';
import { GitApiRepository } from './gitApi';

export const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';
export const WORKTREE_SHA = 'WORKTREE';

export type RefType = 'head' | 'branch' | 'remote' | 'tag';

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

  exec(args: string[], input?: string): Promise<string> {
    return runGit(this.root, args, input);
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

  async log(max: number, allRefs = true): Promise<Commit[]> {
    const args = [
      'log',
      `--max-count=${max}`,
      '--topo-order',
      `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%D${FS}%s${RS}`,
    ];
    if (allRefs) {
      args.push('--exclude=refs/stash', '--all');
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
    const files = parseNameStatus(await this.exec(diffArgs));
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
