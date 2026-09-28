import * as vscode from 'vscode';

export function timeAgo(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.345, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  if (seconds < 30) {
    return 'just now';
  }
  let value = seconds;
  for (const [size, name] of units) {
    if (Math.abs(value) < size) {
      const v = Math.floor(value);
      return `${v} ${name}${v === 1 ? '' : 's'} ago`;
    }
    value /= size;
  }
  return '';
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

export function slugify(text: string, max = 50): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/, '');
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function showError(prefix: string, e: unknown): Promise<void> {
  await vscode.window.showErrorMessage(`${prefix}: ${errorMessage(e)}`);
}

export function commandUri(command: string, ...args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

export function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('gitland').get<T>(key, fallback);
}
