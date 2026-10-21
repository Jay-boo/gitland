/** Pipelines view helpers (no vscode import: unit-tested). */

type State = 'succeeded' | 'failed' | 'running' | 'queued' | 'canceled' | 'partial';

/** "45s", "3m 05s", "1h 02m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** The last `lines` lines of a log, without ANSI colours, CI timestamps or trailing blank lines. */
export function tailLog(text: string, lines: number): string {
  const clean = text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ''));
  while (clean.length && !clean[clean.length - 1].trim()) {
    clean.pop();
  }
  return clean.slice(-lines).join('\n');
}

/** When to refresh the runs: soon while something runs, slowly otherwise, never while the view is hidden. */
export function nextPollDelay(runs: { state: State | string }[], visible: boolean): number | undefined {
  if (!visible) {
    return undefined;
  }
  return runs.some((r) => r.state === 'running' || r.state === 'queued') ? 30000 : 120000;
}

export interface JobLike {
  id: string;
  name: string;
  state: State | string;
  steps?: JobLike[];
}

/** The first failed step (depth first), or the failed job itself when it has no steps. */
export function firstFailed<T extends JobLike>(jobs: T[]): T | undefined {
  for (const j of jobs) {
    if (j.steps?.length) {
      const inner = firstFailed(j.steps as T[]);
      if (inner) {
        return inner;
      }
    } else if (j.state === 'failed') {
      return j;
    }
  }
  return undefined;
}
