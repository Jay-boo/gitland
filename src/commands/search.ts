import * as vscode from 'vscode';
import { Repo } from '../git/repo';
import { getProvider } from '../providers';
import { Provider, PullRequest } from '../providers/types';
import { timeAgo } from '../util';

type Item = vscode.QuickPickItem & { run?: () => unknown };

const PREFIXES: Record<string, string> = { 'b:': 'refs', 'c:': 'commits', 's:': 'content', 'pr:': 'prs', 't:': 'tickets' };
const FS = '\x1f';

/**
 * "Gitland: Search Everywhere": branches and tags, commits (message, author, SHA), the commits that
 * added or removed some text (git log -S), pull requests and tickets — from one input.
 * Prefixes narrow it: b: c: s: pr: t:
 */
export async function searchEverywhere(repo: Repo, secrets: vscode.SecretStorage, open: { commit(sha: string): void; pr(id: string): void; ticket(id: string, org?: string): void }): Promise<void> {
  const provider = await getProvider(repo, secrets);
  const signedIn = provider ? await provider.isSignedIn().catch(() => false) : false;
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = 'Gitland: Search Everywhere';
  qp.placeholder = 'Branches, tags, commits, code, pull requests, tickets…   (b: c: s: pr: t:)';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  let prs: Promise<PullRequest[]> | undefined;
  let seq = 0;
  let timer: NodeJS.Timeout | undefined;

  const search = async (raw: string) => {
    const my = ++seq;
    const prefix = Object.keys(PREFIXES).find((p) => raw.toLowerCase().startsWith(p));
    const only = prefix ? PREFIXES[prefix] : undefined;
    const q = (prefix ? raw.slice(prefix.length) : raw).trim();
    if (q.length < 2) {
      qp.items = [{ label: 'Type at least 2 characters', kind: vscode.QuickPickItemKind.Separator }];
      return;
    }
    qp.busy = true;
    const want = (k: string) => !only || only === k;
    const sections = await Promise.all([
      want('refs') ? refs(repo, q, open) : [],
      want('commits') ? commits(repo, q, open) : [],
      want('content') && (only === 'content' || q.length >= 3) ? content(repo, q, open) : [],
      want('prs') && provider && signedIn ? pullRequests((prs ??= provider.listPullRequests().catch(() => [])), q, open) : [],
      want('tickets') && provider && signedIn ? tickets(provider, q, open) : [],
    ]);
    if (my !== seq) {
      return; // a newer query is running
    }
    const labels = ['Branches & tags', 'Commits', 'Changed the text', 'Pull requests', 'Tickets'];
    const items: Item[] = [];
    sections.forEach((list, i) => {
      if (list.length) {
        items.push({ label: labels[i], kind: vscode.QuickPickItemKind.Separator }, ...list);
      }
    });
    qp.items = items.length ? items : [{ label: `Nothing found for “${q}”`, kind: vscode.QuickPickItemKind.Separator }];
    qp.busy = false;
  };

  qp.onDidChangeValue((v) => {
    clearTimeout(timer);
    timer = setTimeout(() => search(v), 250);
  });
  qp.onDidAccept(() => {
    const item = qp.selectedItems[0];
    if (item?.run) {
      qp.hide();
      item.run();
    }
  });
  qp.onDidHide(() => {
    clearTimeout(timer);
    qp.dispose();
  });
  qp.show();
}

async function refs(repo: Repo, q: string, open: { commit(sha: string): void }): Promise<Item[]> {
  const lower = q.toLowerCase();
  return (await repo.allRefs())
    .filter((r) => r.name.toLowerCase().includes(lower))
    .slice(0, 15)
    .map((r) => ({
      label: `$(${r.type === 'tag' ? 'tag' : r.type === 'remote' ? 'cloud' : 'git-branch'}) ${r.name}`,
      description: `${r.current ? '● current · ' : ''}${timeAgo(r.date)}`,
      run: () => open.commit(r.sha),
    }));
}

async function commits(repo: Repo, q: string, open: { commit(sha: string): void }): Promise<Item[]> {
  const fmt = `--format=%H${FS}%an${FS}%at${FS}%s`;
  const [byMessage, byAuthor, bySha] = await Promise.all([
    repo.exec(['log', '--all', '-n', '20', '-i', '--fixed-strings', `--grep=${q}`, fmt]).catch(() => ''),
    repo.exec(['log', '--all', '-n', '10', '-i', '--fixed-strings', `--author=${q}`, fmt]).catch(() => ''),
    /^[0-9a-f]{4,40}$/i.test(q) ? repo.exec(['log', '-1', fmt, q, '--']).catch(() => '') : Promise.resolve(''),
  ]);
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const [src, why] of [[bySha, 'sha'], [byMessage, 'message'], [byAuthor, 'author']] as const) {
    for (const line of src.split('\n').filter(Boolean)) {
      const [sha, author, date, subject] = line.split(FS);
      if (seen.has(sha)) {
        continue;
      }
      seen.add(sha);
      out.push({
        label: `$(git-commit) ${subject}`,
        description: `${author} · ${timeAgo(Number(date) * 1000)}`,
        detail: `${sha.slice(0, 8)}${why === 'author' ? ' · by author' : why === 'sha' ? ' · SHA' : ''}`,
        run: () => open.commit(sha),
      });
    }
  }
  return out.slice(0, 25);
}

/** Commits whose diff adds or removes the text (the "pickaxe"). */
async function content(repo: Repo, q: string, open: { commit(sha: string): void }): Promise<Item[]> {
  const out = await repo.exec(['log', '--all', '-n', '15', `-S${q}`, `--format=%H${FS}%an${FS}%at${FS}%s`, '--name-only']).catch(() => '');
  const items: Item[] = [];
  for (const block of out.split('\n\n')) {
    const [head, ...files] = block.split('\n').filter(Boolean);
    if (!head?.includes(FS)) {
      continue;
    }
    const [sha, author, date, subject] = head.split(FS);
    items.push({
      label: `$(search) ${subject}`,
      description: `${author} · ${timeAgo(Number(date) * 1000)}`,
      detail: `${sha.slice(0, 8)} · ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}`,
      run: () => open.commit(sha),
    });
  }
  return items;
}

async function pullRequests(list: Promise<PullRequest[]>, q: string, open: { pr(id: string): void }): Promise<Item[]> {
  const lower = q.toLowerCase().replace(/^[!#]/, '');
  return (await list)
    .filter((p) => `${p.id} ${p.title} ${p.sourceBranch} ${p.author}`.toLowerCase().includes(lower))
    .slice(0, 10)
    .map((p) => ({
      label: `$(git-pull-request) ${p.title}`,
      description: `${p.label} · ${p.sourceBranch} → ${p.targetBranch}`,
      detail: `${p.author}${p.review ? ` · ${p.review}` : ''}`,
      run: () => open.pr(p.id),
    }));
}

async function tickets(provider: Provider, q: string, open: { ticket(id: string, org?: string): void }): Promise<Item[]> {
  const found = await provider.searchTickets(q).catch(() => []);
  return found.slice(0, 10).map((t) => ({
    label: `$(issues) ${t.title}`,
    description: `#${t.id} · ${t.type} · ${t.state}`,
    detail: t.project,
    run: () => open.ticket(t.id, t.org),
  }));
}
