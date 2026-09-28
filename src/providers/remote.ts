export type RemoteInfo =
  | { kind: 'azure'; org: string; project: string; repo: string }
  | { kind: 'github'; owner: string; repo: string };

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function parseRemoteUrl(url: string): RemoteInfo | undefined {
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
  if ((m = /^(?:[^@]+@github\.com:|ssh:\/\/[^@]+@github\.com\/|https?:\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url))) {
    return { kind: 'github', owner: m[1], repo: m[2] };
  }
  return undefined;
}
