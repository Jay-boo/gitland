import { Provider } from './providers/types';

export interface MessageLink {
  kind: 'pr' | 'ticket';
  id: string;
  url: string;
}

/**
 * Pull requests and work items / issues mentioned in a commit message:
 * "Merged PR 527", "Merge pull request 522 / #12", "(#12)" (GitHub), "!42" / "See merge request g/r!42" (GitLab),
 * "AB#1234", "#1234".
 * Same rules as `linksIn` in media/graph.js.
 */
export function findLinks(text: string, provider: Provider | undefined): MessageLink[] {
  if (!provider || !text) {
    return [];
  }
  const out: MessageLink[] = [];
  const seen = new Set<string>();
  const add = (kind: MessageLink['kind'], id: string) => {
    // GitHub issues and PRs share numbers; GitLab issues (#n) and MRs (!n) do not.
    if (seen.has(kind + id) || (provider.kind !== 'gitlab' && seen.has('pr' + id))) {
      return;
    }
    seen.add(kind + id);
    out.push({ kind, id, url: kind === 'pr' ? provider.pullRequestUrl(id) : provider.ticketUrl(id) });
  };
  for (const m of text.matchAll(/\b(?:Merged PR|Merge pull request|pull request) #?(\d+)/gi)) {
    add('pr', m[1]);
  }
  if (provider.kind === 'github') {
    for (const m of text.split('\n')[0].matchAll(/\(#(\d+)\)/g)) {
      add('pr', m[1]);
    }
  }
  if (provider.kind === 'gitlab') {
    for (const m of text.matchAll(/merge request \S*!(\d+)|(?:^|[^\w])!(\d+)\b/gi)) {
      add('pr', m[1] ?? m[2]);
    }
  }
  for (const m of text.matchAll(/(?:^|[\s([,;])(?:AB)?#(\d+)\b/g)) {
    add('ticket', m[1]);
  }
  return out;
}
