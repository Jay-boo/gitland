// Pipelines view helpers (src/pipelines/format.pure.ts).
const test = require('node:test');
const assert = require('node:assert');
const { tailLog, formatDuration, nextPollDelay, firstFailed } = require('../../out/unit/format.js');

test('formatDuration', () => {
  assert.strictEqual(formatDuration(45000), '45s');
  assert.strictEqual(formatDuration(185000), '3m 05s');
  assert.strictEqual(formatDuration(3720000), '1h 02m');
  assert.strictEqual(formatDuration(0), '0s');
});

test('tailLog keeps the last lines, without colours or timestamps', () => {
  assert.strictEqual(tailLog('a\nb\nc\n\n', 2), 'b\nc');
  assert.strictEqual(tailLog('\u001b[31m2026-10-21T10:00:00.1234567Z boom', 5), 'boom');
  assert.strictEqual(tailLog('x\r\ny', 5), 'x\ny');
});

test('nextPollDelay: fast while running, slow otherwise, none when hidden', () => {
  assert.strictEqual(nextPollDelay([{ state: 'running' }], true), 30000);
  assert.strictEqual(nextPollDelay([{ state: 'queued' }, { state: 'failed' }], true), 30000);
  assert.strictEqual(nextPollDelay([{ state: 'succeeded' }], true), 120000);
  assert.strictEqual(nextPollDelay([], false), undefined);
  assert.strictEqual(nextPollDelay([{ state: 'running' }], false), undefined);
});

test('firstFailed walks jobs then steps', () => {
  const jobs = [
    { id: '1', name: 'build', state: 'succeeded', steps: [{ id: '1a', name: 'npm ci', state: 'succeeded' }] },
    { id: '2', name: 'test', state: 'failed', steps: [{ id: '2a', name: 'setup', state: 'succeeded' }, { id: '2b', name: 'npm test', state: 'failed' }] },
  ];
  assert.strictEqual(firstFailed(jobs).id, '2b');
  assert.strictEqual(firstFailed([{ id: '3', name: 'x', state: 'failed' }]).id, '3');
  assert.strictEqual(firstFailed([{ id: '4', name: 'y', state: 'succeeded' }]), undefined);
});
