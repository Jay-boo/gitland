/** The URL builders of a provider (see providers/types.ts), all a link needs to be recognised. */
export interface LinkUrls {
  kind: 'azure' | 'github' | 'gitlab';
  pullRequestUrl(id: string): string;
  ticketUrl(id: string): string;
  releaseUrl(tag: string): string;
  /** Jira project key → site, when the tickets come from Jira. */
  ticketKeys?: Record<string, string>;
}

export type LinkTarget = { kind: 'pr'; id: string } | { kind: 'ticket'; id: string; org?: string } | { kind: 'release'; tag: string };

const same = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

/**
 * The Gitland page a link stands for: a pull request or release of this repository, or a work item
 * / issue. Undefined for anything else, which then opens in the browser.
 */
export function linkTarget(url: string, provider: LinkUrls | undefined): LinkTarget | undefined {
  const bare = url.replace(/[?#].*$/, '');
  // Work items of any Azure DevOps project: the ticket page loads them by organization.
  const wi = /^https:\/\/dev\.azure\.com\/([^/]+)\/[^/]+\/_workitems\/edit\/(\d+)\/?$/i.exec(bare);
  if (wi) {
    return { kind: 'ticket', id: wi[2], org: decodeURIComponent(wi[1]) };
  }
  if (!provider) {
    return undefined;
  }
  // Jira issues of the configured projects: <site>/browse/DATA-12.
  const browse = /\/browse\/([A-Za-z][A-Za-z0-9_]*)-(\d+)\/?$/.exec(bare);
  const site = browse && provider.ticketKeys?.[browse[1].toUpperCase()];
  if (browse && site && same(bare, `${site}/browse/${browse[1]}-${browse[2]}`)) {
    return { kind: 'ticket', id: `${browse[1].toUpperCase()}-${browse[2]}`, org: site };
  }
  const id = /\/(\d+)\/?$/.exec(bare)?.[1];
  if (id && same(bare, provider.pullRequestUrl(id))) {
    return { kind: 'pr', id };
  }
  if (id && provider.kind !== 'azure' && same(bare, provider.ticketUrl(id))) {
    return { kind: 'ticket', id };
  }
  const tag =
    provider.kind === 'github' ? /\/releases\/tag\/([^/]+)\/?$/.exec(bare)?.[1]
    : provider.kind === 'gitlab' ? /\/-\/releases\/([^/]+)\/?$/.exec(bare)?.[1]
    : /[?&]version=GT([^&#]+)/.exec(url)?.[1];
  if (tag && same(provider.kind === 'azure' ? url : bare, provider.releaseUrl(decodeURIComponent(tag)))) {
    return { kind: 'release', tag: decodeURIComponent(tag) };
  }
  return undefined;
}
