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

/** The state shown for a group of jobs: failed > running > queued > canceled > succeeded. */
export function worstState(states: State[]): State {
  return SEVERITY.find((s) => states.includes(s)) ?? 'succeeded';
}

/** GitLab jobs as stages (the "jobs" of the Pipelines view) whose jobs are the steps, in pipeline order. */
export function groupJobsByStage(jobs: { id: number; name: string; stage: string; status: string }[]): PipelineJob[] {
  const stages = new Map<string, PipelineJob[]>();
  for (const j of jobs) {
    const steps = stages.get(j.stage) ?? [];
    steps.push({ id: String(j.id), name: j.name, state: pipelineState(j.status), logId: String(j.id) });
    stages.set(j.stage, steps);
  }
  return [...stages].map(([stage, steps]) => ({ id: `stage:${stage}`, name: stage, state: worstState(steps.map((s) => s.state)), steps }));
}

/** MR title without its draft marker ("Draft:", "[Draft]", "(Draft)", "WIP:"). */
export function stripDraft(title: string): string {
  return title.replace(/^\s*(?:\[draft\]|\(draft\)|draft:|wip:)\s*/i, '');
}
