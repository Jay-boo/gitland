import { Provider } from './providers/types';

export interface MessageLink {
  kind: 'pr' | 'ticket';
  id: string;
  url: string;
}

/**
 * Pull requests and work items / issues mentioned in a commit message:
 * "Merged PR 527", "Merge pull request 522 / #12", "(#12)" (GitHub), "AB#1234", "#1234".
 * Same rules as `linksIn` in media/graph.js.
 */
export function findLinks(text: string, provider: Provider | undefined): MessageLink[] {
  if (!provider || !text) {
    return [];
  }
  const out: MessageLink[] = [];
  const seen = new Set<string>();
  const add = (kind: MessageLink['kind'], id: string) => {
    if (seen.has(kind + id) || seen.has('pr' + id)) {
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
  for (const m of text.matchAll(/(?:^|[\s([,;])(?:AB)?#(\d+)\b/g)) {
    add('ticket', m[1]);
  }
  return out;
}
