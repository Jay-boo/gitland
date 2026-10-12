import { createHash } from 'crypto';

/** Default pictures drawn locally (no network), in the graph's muted palette. */
export const LOCAL_STYLES = ['pixel', 'geometric', 'marble', 'rings', 'initials'] as const;
export type LocalStyle = (typeof LOCAL_STYLES)[number];

/** All DiceBear styles (dicebear.com, free), characters then their "neutral" (face only) versions, then abstract ones: value "dicebear-<style>". */
export const DICEBEAR_STYLES = [
  'notionists',
  'notionists-neutral',
  'lorelei',
  'lorelei-neutral',
  'avataaars',
  'avataaars-neutral',
  'adventurer',
  'adventurer-neutral',
  'big-ears',
  'big-ears-neutral',
  'big-smile',
  'micah',
  'open-peeps',
  'personas',
  'dylan',
  'miniavs',
  'croodles',
  'croodles-neutral',
  'fun-emoji',
  'thumbs',
  'bottts',
  'bottts-neutral',
  'pixel-art',
  'pixel-art-neutral',
  'icons',
  'identicon',
  'initials',
  'rings',
  'shapes',
  'glass',
];


export const STYLE_LABELS: Record<string, string> = {
  pixel: 'Pixel — symmetric 5×5 identicon',
  geometric: 'Geometric — Bauhaus shapes',
  marble: 'Marble — soft blurred blobs',
  rings: 'Rings — concentric arcs',
  initials: 'Initials — letters on a color',
  ...Object.fromEntries(DICEBEAR_STYLES.map((d) => [`dicebear-${d}`, `${d.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())} — DiceBear`])),
  robohash: 'Robots (Gravatar, like GitLens)',
  identicon: 'Identicon (Gravatar)',
  retro: 'Retro (Gravatar)',
  monsterid: 'Monsters (Gravatar)',
  wavatar: 'Wavatar (Gravatar)',
  mp: 'Silhouette (Gravatar)',
};

/** Pictures from an online library (no Gravatar needed). The seed is a hash, never the email. */
export function remoteAvatarUrl(style: string, email: string): string | undefined {
  const seed = bytes(email).toString('hex').slice(0, 24);
  if (style.startsWith('dicebear-')) {
    const bg = PALETTE.map((c) => c.slice(1)).join(',');
    return `https://api.dicebear.com/9.x/${style.slice(9)}/svg?seed=${seed}&radius=50&backgroundColor=${bg}`;
  }
  return undefined;
}

export function isGravatarStyle(style: string): boolean {
  return ['robohash', 'identicon', 'retro', 'monsterid', 'wavatar', 'mp'].includes(style);
}

const PALETTE = ['#6f9fd0', '#a08cc8', '#6fb293', '#c792ab', '#c6ab6e', '#c98585', '#6aaeb5', '#8c96cc', '#9db573', '#c99a74'];

export function isLocalStyle(style: string): style is LocalStyle {
  return (LOCAL_STYLES as readonly string[]).includes(style);
}

/** Stable color of an author (same email → same color everywhere). */
export function authorColor(email: string): string {
  return PALETTE[bytes(email)[0] % PALETTE.length];
}

/** SVG picture as a data URI. */
export function avatarDataUri(style: LocalStyle, email: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(avatarSvg(style, email)).toString('base64')}`;
}

export function avatarSvg(style: LocalStyle, email: string): string {
  const b = bytes(email);
  const c = (i: number) => PALETTE[b[i] % PALETTE.length];
  // Three distinct colors
  const c1 = c(0);
  const c2 = PALETTE[(PALETTE.indexOf(c1) + 3 + (b[1] % 3)) % PALETTE.length];
  const c3 = PALETTE[(PALETTE.indexOf(c1) + 6 + (b[2] % 3)) % PALETTE.length];
  let body = '';
  switch (style) {
    case 'pixel': {
      body = `<rect width="64" height="64" fill="${tint(c1, 0.22)}"/>`;
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 3; x++) {
          if ((b[3 + y * 3 + x] & 1) === 0) {
            continue;
          }
          for (const xx of x === 2 ? [2] : [x, 4 - x]) {
            body += `<rect x="${7 + xx * 10}" y="${7 + y * 10}" width="10" height="10" fill="${c1}"/>`;
          }
        }
      }
      break;
    }
    case 'geometric': {
      const r = (b[4] % 4) * 45;
      body =
        `<rect width="64" height="64" fill="${c1}"/>` +
        `<rect x="${8 + (b[5] % 16)}" y="${8 + (b[6] % 16)}" width="34" height="34" fill="${c2}" transform="rotate(${r} 32 32)"/>` +
        `<circle cx="${18 + (b[7] % 28)}" cy="${18 + (b[8] % 28)}" r="${9 + (b[9] % 7)}" fill="${c3}"/>` +
        `<line x1="0" y1="${b[10] % 64}" x2="64" y2="${b[11] % 64}" stroke="${tint('#ffffff', 0.55)}" stroke-width="3"/>`;
      break;
    }
    case 'marble': {
      body =
        `<defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7"/></filter></defs>` +
        `<rect width="64" height="64" fill="${c1}"/>` +
        `<g filter="url(#f)">` +
        `<ellipse cx="${10 + (b[4] % 44)}" cy="${10 + (b[5] % 44)}" rx="${18 + (b[6] % 12)}" ry="${12 + (b[7] % 10)}" fill="${c2}" transform="rotate(${b[8] % 180} 32 32)"/>` +
        `<circle cx="${10 + (b[9] % 44)}" cy="${10 + (b[10] % 44)}" r="${10 + (b[11] % 10)}" fill="${c3}"/>` +
        `</g>`;
      break;
    }
    case 'rings': {
      body = `<rect width="64" height="64" fill="${tint(c1, 0.2)}"/>`;
      [26, 19, 12, 5].forEach((rad, i) => {
        const col = [c1, c2, c3, c1][i];
        const len = Math.round(2 * Math.PI * rad);
        const dash = Math.round(len * (0.45 + (b[4 + i] % 50) / 100));
        body += `<circle cx="32" cy="32" r="${rad}" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${dash} ${len}" transform="rotate(${b[8 + i] % 360} 32 32)"/>`;
      });
      break;
    }
    case 'initials': {
      body =
        `<rect width="64" height="64" fill="${tint(c1, 0.3)}"/>` +
        `<text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="Segoe UI, system-ui, sans-serif" font-size="24" font-weight="600" letter-spacing="1" fill="${c1}">${initials(email)}</text>`;
      break;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><defs><clipPath id="o"><circle cx="32" cy="32" r="32"/></clipPath></defs><g clip-path="url(#o)">${body}</g></svg>`;
}

function bytes(email: string): Buffer {
  return createHash('sha256').update(email.trim().toLowerCase()).digest();
}

/** "ja.morel-ext@voltalia.com" → "JM" */
function initials(email: string): string {
  const parts = email
    .split('@')[0]
    .split(/[._\-+\d]+/)
    .filter((p) => p && !/^(ext|external|dev|admin)$/i.test(p));
  const s = ((parts[0] ?? '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] ?? '')).toUpperCase();
  return s.replace(/[^A-Z0-9?]/g, '') || '?';
}

/** Color at the given opacity over nothing (#RRGGBBAA). */
function tint(hex: string, alpha: number): string {
  return hex + Math.round(alpha * 255).toString(16).padStart(2, '0');
}
