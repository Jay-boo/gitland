// GitLab mappings (src/providers/gitlabMap.pure.ts): pipeline states, stages, draft titles.
const test = require('node:test');
const assert = require('node:assert');
const { pipelineState, worstState, groupJobsByStage, stripDraft } = require('../../out/unit/gitlabMap.js');

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
