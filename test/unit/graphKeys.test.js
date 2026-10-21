// Graph keyboard navigation (media/graphKeys.js).
const test = require('node:test');
const assert = require('node:assert');
const { keyAction, moveIndex, parentIndex, childIndex } = require('../../media/graphKeys.js');

test('keyAction maps keys to actions', () => {
  const k = (key, mods = {}) => keyAction({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods }, false);
  assert.strictEqual(k('j'), 'down');
  assert.strictEqual(k('k'), 'up');
  assert.strictEqual(k('ArrowDown'), 'down');
  assert.strictEqual(k('ArrowUp'), 'up');
  assert.strictEqual(k('Home'), 'home');
  assert.strictEqual(k('End'), 'end');
  assert.strictEqual(k('PageDown'), 'pageDown');
  assert.strictEqual(k('PageUp'), 'pageUp');
  assert.strictEqual(k('Enter'), 'toggleDetails');
  assert.strictEqual(k(' '), 'toggleDetails');
  assert.strictEqual(k('ArrowLeft'), 'parent');
  assert.strictEqual(k('ArrowRight'), 'child');
  assert.strictEqual(k('m'), 'mergeBase');
  assert.strictEqual(k('c'), 'compare');
  assert.strictEqual(k('?', { shiftKey: true }), 'help');
  assert.strictEqual(k('x'), null);
  assert.strictEqual(k('j', { ctrlKey: true }), null);
  assert.strictEqual(k('j', { metaKey: true }), null);
  assert.strictEqual(k('j', { altKey: true }), null);
});

test('keyAction ignores keys typed in inputs', () => {
  assert.strictEqual(keyAction({ key: 'j', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }, true), null);
});

test('moveIndex clamps and starts at the top when nothing is selected', () => {
  assert.strictEqual(moveIndex('down', 9, 10, 5), 9);
  assert.strictEqual(moveIndex('down', 3, 10, 5), 4);
  assert.strictEqual(moveIndex('up', 0, 10, 5), 0);
  assert.strictEqual(moveIndex('pageDown', 2, 10, 5), 7);
  assert.strictEqual(moveIndex('pageUp', 2, 10, 5), 0);
  assert.strictEqual(moveIndex('up', -1, 10, 5), 0);
  assert.strictEqual(moveIndex('end', 0, 10, 5), 9);
  assert.strictEqual(moveIndex('home', 6, 10, 5), 0);
});

test('parentIndex and childIndex follow the history', () => {
  const f = [
    { sha: 'd', parents: ['c', 'b'] },
    { sha: 'c', parents: ['a'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'a', parents: [] },
  ];
  assert.strictEqual(parentIndex(f, 0), 1);
  assert.strictEqual(parentIndex(f, 3), -1);
  assert.strictEqual(childIndex(f, 3), 2);
  assert.strictEqual(childIndex(f, 1), 0);
  assert.strictEqual(childIndex(f, 0), -1);
});
