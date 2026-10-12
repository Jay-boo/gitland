import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Repo } from './git/repo';
import { log } from './log';
import { getProvider } from './providers';
import { config } from './util';
import { avatarDataUri, isGravatarStyle, isLocalStyle, remoteAvatarUrl } from './avatarArt';

// A miss is stored as '' so the default picture follows the configured style.
// v3: earlier versions also stored lookup *errors* as misses (Azure DevOps photos never came back).
// v4: Azure DevOps photos are fetched small (big data: URIs don't render in hovers).
const STORE_KEY = 'gitland.avatars.v4';
const TTL = 3 * 24 * 3600 * 1000;
/** Online default pictures (DiceBear) downloaded once, as data URIs: "<style>:<email>" → data URI. */
const GENERATED_KEY = 'gitland.avatars.generated.v1';
const MAX_PARALLEL_DOWNLOADS = 2;

type Stored = Record<string, { url: string; at: number }>;

/**
 * Author pictures, resolved the GitLens way:
 * GitHub noreply address → GitHub avatar; hosting provider photo (Azure DevOps profile picture);
 * otherwise Gravatar. Without a real picture: a picture drawn locally ('pixel', 'geometric'…)
 * or one of Gravatar's generated defaults ('robohash' like GitLens…), per `gitland.avatars.defaultStyle`.
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
      return hit.url || this.defaultFor(key);
    }
    return githubNoReplyAvatar(key) ?? this.defaultFor(key);
  }

  /**
   * Picture for a hover (inline blame, CodeLens…): the same as urlFor, but an embedded picture
   * (data: URI, e.g. an Azure DevOps photo) is saved to a small cache file and referenced by path —
   * editor hovers don't render big data: URIs (the <img> tag showed as text).
   */
  hoverUrlFor(email: string): string {
    const url = this.urlFor(email);
    const m = /^data:image\/(png|jpeg|gif|svg\+xml);base64,(.*)$/s.exec(url);
    // Small embedded pictures render fine (and work in remote windows, unlike file paths).
    if (!m || url.length <= 12000) {
      return url;
    }
    try {
      const dir = path.join(this.context.globalStorageUri.fsPath, 'avatars');
      const file = path.join(dir, `${createHash('md5').update(url).digest('hex')}.${m[1] === 'svg+xml' ? 'svg' : m[1]}`);
      if (!fs.existsSync(file)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      }
      return vscode.Uri.file(file).toString();
    } catch (e) {
      log.info(`Avatar file cache failed: ${e instanceof Error ? e.message : e}`);
      return gravatarUrl(email);
    }
  }

  /**
   * Default picture in the configured style. Online styles are downloaded once (a few at a time: the
   * service throttles) and kept; meanwhile the author's initials show.
   */
  private defaultFor(email: string): string {
    const style = config('avatars.defaultStyle', 'pixel');
    const url = remoteAvatarUrl(style, email);
    if (!url) {
      return defaultPicture(email, style);
    }
    const cached = this.context.globalState.get<Record<string, string>>(GENERATED_KEY, {})[`${style}:${email}`];
    if (cached) {
      return cached;
    }
    this.download(style, email, url);
    return avatarDataUri('initials', email);
  }

  private readonly downloads = new Set<string>();
  private readonly queue: (() => Promise<void>)[] = [];
  private running = 0;

  private download(style: string, email: string, url: string): void {
    const key = `${style}:${email}`;
    if (this.downloads.has(key)) {
      return;
    }
    this.downloads.add(key);
    this.queue.push(async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
          throw new Error(`${res.status}`);
        }
        const data = `data:image/svg+xml;base64,${Buffer.from(await res.text()).toString('base64')}`;
        const all = this.context.globalState.get<Record<string, string>>(GENERATED_KEY, {});
        await this.context.globalState.update(GENERATED_KEY, { ...all, [key]: data });
        // Only if no real photo is known for this author.
        if (this.urlFor(email) === data) {
          this.emitter.fire({ email, url: data });
        }
      } catch (e) {
        this.downloads.delete(key); // retry on a later refresh
        log.info(`Default picture download failed (${style}): ${e instanceof Error ? e.message : e}`);
      }
    });
    this.pump();
  }

  private pump(): void {
    while (this.running < MAX_PARALLEL_DOWNLOADS && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      job().finally(() => {
        this.running--;
        this.pump();
      });
    }
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
    const found = async (url: string) => {
      await this.context.globalState.update(STORE_KEY, { ...this.stored, [email]: { url, at: Date.now() } });
      this.emitter.fire({ email, url });
      return url;
    };
    try {
      const provider = await getProvider(repo, this.context.secrets);
      if (provider?.avatarFor && (await provider.isSignedIn())) {
        const url = await provider.avatarFor(email, sha);
        if (url) {
          return found(url);
        }
      }
      // With a locally drawn default, still prefer a real Gravatar photo when the author has one.
      if (!isGravatarStyle(config('avatars.defaultStyle', 'pixel'))) {
        const url = gravatarUrl(email, 64, '404');
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          return found(url);
        }
      }
    } catch (e) {
      // Not a miss: don't remember it, the next session asks again (the pending map avoids retries meanwhile).
      log.info(`Avatar lookup failed for ${email}: ${e instanceof Error ? e.message : e}`);
      return this.defaultFor(email);
    }
    // Remember the miss, so we don't query the provider for this email on every refresh.
    await this.context.globalState.update(STORE_KEY, { ...this.stored, [email]: { url: '', at: Date.now() } });
    return this.defaultFor(email);
  }

  async clear(): Promise<void> {
    this.pending.clear();
    this.downloads.clear();
    await this.context.globalState.update(STORE_KEY, undefined);
    await this.context.globalState.update(GENERATED_KEY, undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export function gravatarUrl(email: string, size = 64, fallback = config('avatars.defaultStyle', 'pixel')): string {
  const hash = createHash('md5').update(email.trim().toLowerCase()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=${encodeURIComponent(fallback)}`;
}

/** Picture for an author without a profile photo, in the configured style. */
export function defaultPicture(email: string, style = config('avatars.defaultStyle', 'pixel')): string {
  if (isLocalStyle(style)) {
    return avatarDataUri(style, email);
  }
  return remoteAvatarUrl(style, email) ?? gravatarUrl(email, 64, isGravatarStyle(style) ? style : 'robohash');
}

function githubNoReplyAvatar(email: string): string | undefined {
  const m = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/.exec(email);
  if (!m) {
    return undefined;
  }
  return m[1] ? `https://avatars.githubusercontent.com/u/${m[1]}?s=64&v=4` : `https://github.com/${m[2]}.png?size=64`;
}
