// GitLab mappings (src/providers/gitlabMap.pure.ts): pipeline states, stages, draft titles.
const test = require('node:test');
const assert = require('node:assert');
const { pipelineState, worstState, groupJobsByStage, stripDraft, normalizeHost, once } = require('../../out/unit/gitlabMap.js');

test('pipelineState', () => {
  assert.strictEqual(pipelineState('success'), 'succeeded');
  assert.strictEqual(pipelineState('failed'), 'failed');
  assert.strictEqual(pipelineState('running'), 'running');
  for (const s of ['canceled', 'skipped']) assert.strictEqual(pipelineState(s), 'canceled');
  for (const s of ['created', 'pending', 'preparing', 'waiting_for_resource', 'scheduled', 'manual']) assert.strictEqual(pipelineState(s), 'queued');
});

test('worstState: failed > running > queued > canceled > succeeded', () => {
  assert.strictEqual(worstState(['queued', 'canceled', 'failed']), 'failed');
  assert.strictEqual(worstState(['succeeded', 'canceled']), 'canceled');
  assert.strictEqual(worstState(['succeeded', 'queued', 'running']), 'running');
});

test('groupJobsByStage', () => {
  const g = groupJobsByStage([
    { id: 1, name: 'lint', stage: 'test', status: 'success' },
    { id: 2, name: 'build', stage: 'build', status: 'manual' },
    { id: 3, name: 'unit', stage: 'test', status: 'failed' },
  ]);
  assert.deepStrictEqual(g.map((s) => [s.id, s.name, s.state, s.steps.map((j) => j.logId)]), [
    ['stage:test', 'test', 'failed', ['1', '3']],
    ['stage:build', 'build', 'queued', ['2']],
  ]);
});

test('stripDraft', () => {
  for (const t of ['Draft: Fix x', '[Draft] Fix x', '(Draft) Fix x', 'WIP: Fix x', 'draft:Fix x']) assert.strictEqual(stripDraft(t), 'Fix x');
  assert.strictEqual(stripDraft('Drafting rules'), 'Drafting rules');
});

test('groupJobsByStage: a retried job keeps its stage in place and shows its latest attempt', () => {
  const g = groupJobsByStage([
    { id: 1, name: 'build', stage: 'build', status: 'failed' },
    { id: 2, name: 'unit', stage: 'test', status: 'success' },
    { id: 3, name: 'build', stage: 'build', status: 'success' },
  ]);
  assert.deepStrictEqual(g.map((s) => [s.name, s.state, s.steps.map((j) => j.logId)]), [
    ['build', 'succeeded', ['3']],
    ['test', 'succeeded', ['2']],
  ]);
});

test('groupJobsByStage: manual / skipped jobs and allowed failures do not spoil a passed stage', () => {
  const g = groupJobsByStage([
    { id: 1, name: 'deploy', stage: 'deploy', status: 'success' },
    { id: 2, name: 'deploy-prod', stage: 'deploy', status: 'manual' },
    { id: 3, name: 'cleanup', stage: 'deploy', status: 'skipped' },
    { id: 4, name: 'lint', stage: 'test', status: 'failed', allow_failure: true },
    { id: 5, name: 'unit', stage: 'test', status: 'success' },
    { id: 6, name: 'release', stage: 'release', status: 'manual' },
  ]);
  assert.deepStrictEqual(g.map((s) => [s.name, s.state]), [['deploy', 'succeeded'], ['test', 'partial'], ['release', 'queued']]);
  assert.strictEqual(g[1].steps[0].state, 'partial');
});

test('normalizeHost: setting entries with scheme, port or slash', () => {
  assert.strictEqual(normalizeHost(' https://Git.Corp:8443/ '), 'git.corp');
  assert.strictEqual(normalizeHost('git.corp'), 'git.corp');
});

test('once: concurrent calls for a key share one run', async () => {
  let runs = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const fn = () => (runs++, gate);
  const a = once('gitlab.com', fn);
  const b = once('gitlab.com', fn);
  release('tok');
  assert.deepStrictEqual(await Promise.all([a, b]), ['tok', 'tok']);
  assert.strictEqual(runs, 1);
  assert.strictEqual(await once('gitlab.com', async () => (runs++, 'new')), 'new');
  assert.strictEqual(runs, 2);
});
