// Branch ↔ ticket reminder at commit (src/tickets/reminder.pure.ts).
const test = require('node:test');
const assert = require('node:assert');
const { needsTicketReminder, withTicketRef } = require('../../out/unit/reminder.js');

const base = { enabled: true, branch: 'feature/login', skipped: false, message: 'add form', prefix: 'AB#' };

test('reminds on a feature branch with no ticket', () => {
  assert.strictEqual(needsTicketReminder(base), true);
});

test('never reminds when off, skipped, detached, linked or already referenced', () => {
  assert.strictEqual(needsTicketReminder({ ...base, enabled: false }), false);
  assert.strictEqual(needsTicketReminder({ ...base, skipped: true }), false);
  assert.strictEqual(needsTicketReminder({ ...base, branch: undefined }), false);
  assert.strictEqual(needsTicketReminder({ ...base, linkedTicket: '12' }), false);
  assert.strictEqual(needsTicketReminder({ ...base, message: 'add form AB#123' }), false);
});

test('never reminds on protected branches', () => {
  for (const branch of ['main', 'master', 'dev', 'develop', 'release/1.2', 'hotfix/x']) {
    assert.strictEqual(needsTicketReminder({ ...base, branch }), false, branch);
  }
  assert.strictEqual(needsTicketReminder({ ...base, branch: 'mainline' }), true);
});

test('GitHub references are #number', () => {
  assert.strictEqual(needsTicketReminder({ ...base, prefix: '#', message: 'fix #42' }), false);
  assert.strictEqual(needsTicketReminder({ ...base, prefix: '#', message: 'fix the #tag thing' }), true);
});

test('withTicketRef appends to the subject line', () => {
  assert.strictEqual(withTicketRef('fix: x\n\nbody', 'AB#7'), 'fix: x AB#7\n\nbody');
  assert.strictEqual(withTicketRef('', 'AB#7'), 'AB#7');
  assert.strictEqual(withTicketRef('fix: x  ', 'AB#7'), 'fix: x AB#7');
});
