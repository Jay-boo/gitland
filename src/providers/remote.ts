import { execFile } from 'child_process';

export type RemoteInfo =
  | { kind: 'azure'; org: string; project: string; repo: string }
  | { kind: 'github'; owner: string; repo: string }
  | { kind: 'gitlab'; host: string; path: string };

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** gitlab.com, a host of setting gitland.gitlab.hosts, or any `gitlab.*` host (port ignored). */
export function isGitLabHost(host: string, gitlabHosts: string[]): boolean {
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === 'gitlab.com' || name.startsWith('gitlab.') || gitlabHosts.some((h) => h.trim().toLowerCase() === name);
}

export function parseRemoteUrl(url: string, gitlabHosts: string[] = []): RemoteInfo | undefined {
  let m: RegExpExecArray | null;

  // git@ssh.dev.azure.com:v3/org/project/repo
  if ((m = /^(?:ssh:\/\/)?[^@]+@ssh\.dev\.azure\.com(?::22)?[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i.exec(url))) {
    return { kind: 'azure', org: dec(m[1]), project: dec(m[2]), repo: dec(m[3]) };
  }
  // org@vs-ssh.visualstudio.com:v3/org/project/repo
  if ((m = /^(?:ssh:\/\/)?[^@]+@vs-ssh\.visualstudio\.com(?::22)?[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i.exec(url))) {
    return { kind: 'azure', org: dec(m[1]), project: dec(m[2]), repo: dec(m[3]) };
  }
  // https://[user@]dev.azure.com/org/project/_git/repo
  if ((m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)\/?$/i.exec(url))) {
    return { kind: 'azure', org: dec(m[1]), project: dec(m[2]), repo: dec(m[3]) };
  }
  // https://org.visualstudio.com/[DefaultCollection/]project/_git/repo
  if ((m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)\/?$/i.exec(url))) {
    return { kind: 'azure', org: dec(m[1]), project: dec(m[2]), repo: dec(m[3]) };
  }
  // GitHub: git@github.com:owner/repo.git, ssh://git@github.com/owner/repo, https://github.com/owner/repo(.git)
  if ((m = /^(?:[^@]+@github\.com:|ssh:\/\/[^@]+@github\.com(?::\d+)?\/|https?:\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url))) {
    return { kind: 'github', owner: m[1], repo: m[2] };
  }
  // GitLab: git@host:group/sub/repo.git, ssh://git@host[:port]/group/repo, https://host[:port]/group/repo(.git)
  // The SSH port is dropped (the web stays on 443); an HTTPS port is kept.
  if (
    (m = /^[^@/:]+@([^:/]+):(?!\d+\/)(.+)$/.exec(url)) ??
    (m = /^ssh:\/\/[^@/]+@([^:/]+)(?::\d+)?\/(.+)$/i.exec(url)) ??
    (m = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(url))
  ) {
    const path = m[2].replace(/\/+$/, '').replace(/\.git$/i, '');
    if (isGitLabHost(m[1], gitlabHosts) && /^[^/]+(?:\/[^/]+)+$/.test(path)) {
      return { kind: 'gitlab', host: m[1].toLowerCase(), path: dec(path) };
    }
  }
  return undefined;
}

const sshHostCache = new Map<string, Promise<string | undefined>>();

/** Real host name for an ~/.ssh/config alias (`ssh -G` evaluates the config without connecting). */
export function resolveSshHost(alias: string): Promise<string | undefined> {
  let p = sshHostCache.get(alias);
  if (!p) {
    p = new Promise((resolve) => {
      execFile('ssh', ['-G', alias], { timeout: 5000 }, (err, stdout) => {
        const m = !err && /^hostname\s+(\S+)/im.exec(stdout);
        resolve(m && m[1].toLowerCase() !== alias.toLowerCase() ? m[1] : undefined);
      });
    });
    sshHostCache.set(alias, p);
  }
  return p;
}

/** Splits an SSH remote (`user@host:path` or `ssh://user@host[:port]/path`) around its host. */
function splitSshHost(url: string): { before: string; host: string; after: string } | undefined {
  const m = /^(ssh:\/\/[^@/]+@)([^:/]+)((?::\d+)?\/.*)$/i.exec(url) ?? /^([^@/:]+@)([^:/]+)(:.*)$/.exec(url);
  return m ? { before: m[1], host: m[2], after: m[3] } : undefined;
}

/** Like parseRemoteUrl, but also understands SSH host aliases such as `git@github-perso:owner/repo.git`. */
export async function resolveRemoteUrl(
  url: string,
  resolveHost: (alias: string) => Promise<string | undefined> = resolveSshHost,
  gitlabHosts: string[] = [],
): Promise<RemoteInfo | undefined> {
  const info = parseRemoteUrl(url, gitlabHosts);
  if (info) {
    return info;
  }
  const parts = splitSshHost(url);
  if (!parts) {
    return undefined;
  }
  const host = await resolveHost(parts.host);
  return host ? parseRemoteUrl(parts.before + host + parts.after, gitlabHosts) : undefined;
}
