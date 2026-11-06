import assert from 'node:assert/strict';
import { test } from 'node:test';

import { captureOrigins, checkMove, invertJournal, restoreIndex, validatePlan } from '../../extension/core/plan.js';

/**
 * '0' root; '1' local bar with folder '10' (holding '11', '12') and bookmark '13'; '2' local
 * other; '5' account bar with folder '50'; '9' managed with '90'.
 */
const node = (/** @type {Record<string, unknown>} */ fields) => ({ title: String(fields.id), syncing: false, ...fields });
const TREE = [
  node({
    id: '0',
    children: [
      node({
        id: '1', parentId: '0', index: 0, folderType: 'bookmarks-bar',
        children: [
          node({ id: '10', parentId: '1', index: 0, children: [node({ id: '11', parentId: '10', index: 0, url: 'https://a.test/' }), node({ id: '12', parentId: '10', index: 1, url: 'https://b.test/' })] }),
          node({ id: '13', parentId: '1', index: 1, url: 'https://c.test/' }),
        ],
      }),
      node({ id: '2', parentId: '0', index: 1, folderType: 'other', children: [] }),
      node({ id: '5', parentId: '0', index: 2, folderType: 'bookmarks-bar', syncing: true, children: [node({ id: '50', parentId: '5', index: 0, syncing: true, children: [] })] }),
      node({
        id: '9', parentId: '0', index: 3, folderType: 'managed', unmodifiable: 'managed',
        children: [node({ id: '90', parentId: '9', index: 0, url: 'https://m.test/', unmodifiable: 'managed' })],
      }),
    ],
  }),
];

const move = (/** @type {string} */ id, /** @type {string} */ from, /** @type {string} */ to, index = 0) => ({ id, from: { parentId: from, index }, to: { parentId: to } });

test('a valid plan has no problems', () => {
  assert.deepEqual(validatePlan([move('13', '1', '2', 1), move('10', '1', '2'), move('11', '10', '1')], TREE), []);
});

for (const [name, plan, reason] of /** @type {[string, unknown[], string][]} */ ([
  ['a node that does not exist', [move('77', '1', '2')], 'missing'],
  ['a root folder', [move('2', '0', '1')], 'root'],
  ['the tree root', [{ id: '0', from: { parentId: '0', index: 0 }, to: { parentId: '1' } }], 'root'],
  ['a managed bookmark', [move('90', '9', '2')], 'managed'],
  ['a node that is no longer in its origin folder', [move('11', '1', '2')], 'moved'],
  ['a destination that does not exist', [move('13', '1', '77')], 'missing-destination'],
  ['a bookmark as destination', [move('11', '10', '13')], 'not-a-folder'],
  ['the tree root as destination', [move('13', '1', '0')], 'root-destination'],
  ['a managed destination', [move('13', '1', '9')], 'managed-destination'],
  ['local to account', [move('13', '1', '5')], 'cross-storage'],
  ['account to local', [move('50', '5', '2')], 'cross-storage'],
  ['a folder into itself', [move('10', '1', '10')], 'into-itself'],
  ['the same folder', [move('13', '1', '1')], 'same-folder'],
  ['a move without an origin index', [{ id: '13', from: { parentId: '1' }, to: { parentId: '2' } }], 'malformed'],
  ['a move that is not an object', [null], 'malformed'],
]))
  test(`validatePlan rejects ${name}`, () => {
    const problems = validatePlan(plan, TREE);
    assert.equal(problems[0].reason, reason);
    assert.equal(problems[0].position, 0);
  });

test('validatePlan rejects a folder moved into a descendant of itself', () => {
  const tree = structuredClone(TREE);
  const folder = tree[0].children[0].children[0];
  folder.children.push(node({ id: '14', parentId: '10', index: 2, children: [] }));
  assert.deepEqual(validatePlan([move('10', '1', '14')], tree), [{ position: 0, id: '10', reason: 'into-itself' }]);
});

test('validatePlan rejects a node that appears twice, and keeps the first', () => {
  assert.deepEqual(validatePlan([move('13', '1', '2', 1), move('13', '1', '2', 1)], TREE), [{ position: 1, id: '13', reason: 'duplicate' }]);
});

test('checkMove takes the nodes as they are now', () => {
  const now = { id: '13', parentId: '2', index: 0, title: 'c', url: 'https://c.test/', syncing: false };
  assert.equal(checkMove(move('13', '1', '2'), now, { id: '2', parentId: '0', title: 'Other', syncing: false }), 'moved');
  assert.equal(checkMove(move('13', '2', '1'), now, { id: '1', parentId: '0', title: 'Bar', syncing: false }), null);
  // syncing can change on an existing node (Chrome 134+); the check uses the value read now.
  assert.equal(checkMove(move('13', '2', '1'), now, { id: '1', parentId: '0', title: 'Bar', syncing: true }), 'cross-storage');
  assert.equal(checkMove(move('13', '2', '1'), undefined, { id: '1', parentId: '0', title: 'Bar', syncing: false }), 'missing');
});

test('captureOrigins records each origin folder once, in its current order', () => {
  assert.deepEqual(captureOrigins(TREE, [move('11', '10', '2'), move('12', '10', '2', 1), move('13', '1', '2', 1)]), {
    10: ['11', '12'],
    1: ['10', '13'],
  });
});

test('invertJournal undoes the last move first, anchored on the former predecessors', () => {
  const journal = {
    moves: [
      { id: 'b', from: { parentId: 'F', index: 1 }, to: { parentId: 'G', index: 3 } },
      { id: 'd', from: { parentId: 'F', index: 2 }, to: { parentId: 'G', index: 4 } },
      { id: 'x', from: { parentId: 'H', index: 0 }, to: { parentId: 'F', index: 2 } },
    ],
    origins: { F: ['a', 'b', 'c', 'd', 'e'], H: ['x'] },
  };
  assert.deepEqual(invertJournal(journal), [
    { id: 'x', from: { parentId: 'F', index: 2 }, to: { parentId: 'H', index: 0 }, after: [] },
    { id: 'd', from: { parentId: 'G', index: 4 }, to: { parentId: 'F', index: 2 }, after: ['c', 'b', 'a'] },
    { id: 'b', from: { parentId: 'G', index: 3 }, to: { parentId: 'F', index: 1 }, after: ['a'] },
  ]);
  assert.equal(journal.moves[0].id, 'b', 'the journal itself is not reordered');
});

test('restoreIndex goes after the nearest predecessor still present, or first', () => {
  assert.equal(restoreIndex(['c', 'b', 'a'], ['a', 'c', 'e']), 2);
  assert.equal(restoreIndex(['c', 'b', 'a'], ['new', 'a', 'e']), 2, 'c and b are gone: after a');
  assert.equal(restoreIndex(['c', 'b', 'a'], ['e']), 0, 'no predecessor left: first');
  assert.equal(restoreIndex([], ['a', 'b']), 0);
});
