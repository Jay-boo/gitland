import type { PipelineJob, PipelineRun } from './types';

type State = PipelineRun['state'];

/** GitLab pipeline / job status → Gitland run state (unknown statuses count as queued). */
export function pipelineState(status: string): State {
  switch (status) {
    case 'success':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'running':
      return 'running';
    case 'canceled':
    case 'skipped':
      return 'canceled';
    default:
      return 'queued';
  }
}

const SEVERITY: State[] = ['failed', 'running', 'queued', 'partial', 'canceled', 'succeeded'];

/** The state shown for a group of jobs: failed > running > queued > partial > canceled > succeeded. */
export function worstState(states: State[]): State {
  return SEVERITY.find((s) => states.includes(s)) ?? 'succeeded';
}

export interface GlJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  allow_failure?: boolean;
}

/** A job's state; a failure the pipeline allows is only a warning. */
function jobState(j: GlJob): State {
  const state = pipelineState(j.status);
  return state === 'failed' && j.allow_failure ? 'partial' : state;
}

/**
 * GitLab jobs (retried ones included) as stages, the "jobs" of the Pipelines view, whose jobs are the steps.
 * Stages keep pipeline order (their first attempt), each job shows its latest attempt. Manual and skipped
 * jobs only count when the stage has nothing else.
 */
export function groupJobsByStage(jobs: GlJob[]): PipelineJob[] {
  const stages = new Map<string, { first: number; jobs: Map<string, GlJob> }>();
  for (const j of jobs) {
    const stage = stages.get(j.stage) ?? { first: j.id, jobs: new Map<string, GlJob>() };
    stage.first = Math.min(stage.first, j.id);
    const prev = stage.jobs.get(j.name);
    if (!prev || prev.id < j.id) {
      stage.jobs.set(j.name, j);
    }
    stages.set(j.stage, stage);
  }
  return [...stages]
    .sort(([, a], [, b]) => a.first - b.first)
    .map(([name, stage]) => {
      const latest = [...stage.jobs.values()].sort((a, b) => a.id - b.id);
      const steps: PipelineJob[] = latest.map((j) => ({ id: String(j.id), name: j.name, state: jobState(j), logId: String(j.id) }));
      const counted = latest.filter((j) => j.status !== 'manual' && j.status !== 'skipped');
      return { id: `stage:${name}`, name, state: worstState((counted.length ? counted : latest).map(jobState)), steps };
    });
}

/** Host name of a gitland.gitlab.hosts entry, also when written as a URL ("https://git.corp:8443/"). */
export function normalizeHost(entry: string): string {
  return entry.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, '').toLowerCase();
}

const pending = new Map<string, Promise<unknown>>();

/** Runs fn once per key at a time: concurrent callers share its result (one token prompt per host). */
export function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let p = pending.get(key) as Promise<T> | undefined;
  if (!p) {
    p = fn().finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

/** MR title without its draft marker ("Draft:", "[Draft]", "(Draft)", "WIP:"). */
export function stripDraft(title: string): string {
  return title.replace(/^\s*(?:\[draft\]|\(draft\)|draft:|wip:)\s*/i, '');
}
