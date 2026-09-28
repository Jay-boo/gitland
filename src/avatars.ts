import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { Repo } from './git/repo';
import { log } from './log';
import { getProvider } from './providers';
import { config } from './util';

const STORE_KEY = 'gitland.avatars.v1';
const TTL = 3 * 24 * 3600 * 1000;

type Stored = Record<string, { url: string; at: number }>;

/**
 * Author pictures, resolved the GitLens way:
 * GitHub noreply address → GitHub avatar; hosting provider photo (Azure DevOps profile picture);
 * otherwise Gravatar, which falls back to a generated default picture (robohash, like GitLens).
 */
export class AvatarService {
  private readonly pending = new Map<string, Promise<string>>();
  private readonly emitter = new vscode.EventEmitter<{ email: string; url: string }>();
  /** Fires when a better picture than the default one was found for an email. */
  readonly onDidResolve = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get stored(): Stored {
    return this.context.globalState.get<Stored>(STORE_KEY, {});
  }

  /** Immediate URL: cached picture or Gravatar with the generated default. */
  urlFor(email: string): string {
    const key = email.trim().toLowerCase();
    const hit = this.stored[key];
    if (hit && Date.now() - hit.at < TTL) {
      return hit.url;
    }
    return githubNoReplyAvatar(key) ?? gravatarUrl(key);
  }

  /** Looks for the provider's picture in the background; `onDidResolve` fires when one is found. */
  resolve(repo: Repo, email: string, sha?: string): Promise<string> {
    const key = email.trim().toLowerCase();
    const hit = this.stored[key];
    if (!key || (hit && Date.now() - hit.at < TTL) || githubNoReplyAvatar(key)) {
      return Promise.resolve(this.urlFor(key));
    }
    let p = this.pending.get(key);
    if (!p) {
      p = this.lookup(repo, key, sha);
      this.pending.set(key, p);
    }
    return p;
  }

  private async lookup(repo: Repo, email: string, sha?: string): Promise<string> {
    const fallback = gravatarUrl(email);
    try {
      const provider = await getProvider(repo, this.context.secrets);
      if (provider?.avatarFor && (await provider.isSignedIn())) {
        const url = await provider.avatarFor(email, sha);
        if (url) {
          await this.context.globalState.update(STORE_KEY, { ...this.stored, [email]: { url, at: Date.now() } });
          this.emitter.fire({ email, url });
          return url;
        }
      }
    } catch (e) {
      log.info(`Avatar lookup failed for ${email}: ${e instanceof Error ? e.message : e}`);
    }
    // Remember the miss too, so we don't query the provider for this email on every refresh.
    await this.context.globalState.update(STORE_KEY, { ...this.stored, [email]: { url: fallback, at: Date.now() } });
    return fallback;
  }

  async clear(): Promise<void> {
    this.pending.clear();
    await this.context.globalState.update(STORE_KEY, undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export function gravatarUrl(email: string, size = 64): string {
  const hash = createHash('md5').update(email.trim().toLowerCase()).digest('hex');
  const style = config('avatars.defaultStyle', 'robohash');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=${encodeURIComponent(style)}`;
}

function githubNoReplyAvatar(email: string): string | undefined {
  const m = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/.exec(email);
  if (!m) {
    return undefined;
  }
  return m[1] ? `https://avatars.githubusercontent.com/u/${m[1]}?s=64&v=4` : `https://github.com/${m[2]}.png?size=64`;
}
