import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { planRun, seededShuffle, stratifiedSample } from '../../extension/core/sampling.js';
import { parseNetscapeBookmarks } from '../../tools/lib/netscape.mjs';

const GOLDEN_SEED_1 = [7, 8, 3, 2, 1, 5, 9, 4, 0, 6];
const GOLDEN_SEED_42 = [0, 7, 3, 5, 2, 1, 8, 9, 4, 6];

/** @param {string} folderPath @param {number} count @param {string} prefix */
const bookmarks = (folderPath, count, prefix) =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, title: `t${i}`, url: `example.com/${i}`, folderPath }));

/** 1,500 loose bookmarks and 50 folders of 10: the shape of a real, unordered collection. */
const heapCollection = () => [
  ...bookmarks('', 1500, 'heap'),
  ...Array.from({ length: 50 }, (_, f) => bookmarks(`Folder ${f}`, 10, `f${f}_`)).flat(),
];

test('shuffle is deterministic and keeps every item', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  assert.deepEqual(seededShuffle(items, 7), seededShuffle(items, 7));
  assert.notDeepEqual(seededShuffle(items, 7), seededShuffle(items, 8));
  assert.deepEqual([...seededShuffle(items, 7)].sort((a, b) => a - b), items);
  assert.equal(items[0], 0, 'input is not mutated');
});

test('seededShuffle is pinned by a golden array', () => {
  // A change here silently changes every sample of every past run: bump deliberately.
  const items = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(seededShuffle(items, 1), GOLDEN_SEED_1);
  assert.deepEqual(seededShuffle(items, 42), GOLDEN_SEED_42);
});

test('sample does not let a huge folder crowd out small ones', () => {
  const items = [
    ...Array.from({ length: 1000 }, (_, i) => ({ id: `big${i}`, group: 'big' })),
    { id: 'small1', group: 'small' },
    { id: 'small2', group: 'small' },
    { id: 'tiny', group: 'tiny' },
  ];
  const sample = stratifiedSample(items, 20, (item) => item.group, 1);
  assert.equal(sample.length, 20);
  assert.equal(new Set(sample.map((item) => item.id)).size, 20);
  for (const id of ['small1', 'small2', 'tiny']) {
    assert.ok(sample.some((item) => item.id === id), `${id} missing`);
  }
});

test('sample larger than the collection returns everything once', () => {
  const items = [{ id: 'a', group: 'x' }, { id: 'b', group: 'y' }];
  assert.equal(stratifiedSample(items, 10, (item) => item.group, 1).length, 2);
});

test('sampling stays linear when asked for more than exists', () => {
  const items = [
    ...Array.from({ length: 20000 }, (_, i) => ({ g: `s${i}` })),
    ...Array.from({ length: 20000 }, () => ({ g: 'big' })),
  ];
  const started = performance.now();
  assert.equal(stratifiedSample(items, 100000, (item) => item.g, 1).length, 40000);
  assert.ok(performance.now() - started < 1500);
});

test('no review row was seen by the taxonomy, and the three sets do not overlap', () => {
  const plan = planRun(heapCollection(), { seed: 1, sample: 300, review: 100 });
  const taxonomy = new Set(plan.taxonomySample.map((item) => item.id));
  assert.equal(plan.taxonomySample.length, 150);
  assert.equal(plan.classificationSample.length, 300);
  assert.equal(plan.reviewItems.length, 100);
  for (const item of plan.classificationSample) assert.ok(!taxonomy.has(item.id), `${item.id} leaked`);
  const classified = new Set(plan.classificationSample.map((item) => item.id));
  for (const item of plan.reviewItems) assert.ok(classified.has(item.id));
  assert.equal(new Set(plan.taxonomySample.map((item) => item.id)).size, 150);
});

test('review rows follow the collection: a heap of 75 percent supplies most of them', () => {
  const plan = planRun(heapCollection(), { seed: 1, sample: 300, review: 100 });
  const fromHeap = plan.reviewItems.filter((item) => item.folderPath === '').length;
  assert.ok(fromHeap >= 60 && fromHeap <= 90, `heap rows: ${fromHeap}`);
  const taxonomyHeap = plan.taxonomySample.filter((item) => item.folderPath === '').length;
  assert.ok(taxonomyHeap >= 0.3 * plan.taxonomySample.length, `taxonomy heap rows: ${taxonomyHeap}`);
});

test('the plan is derived from the whole collection, not from the sample', () => {
  const plan = planRun([...heapCollection(), ...bookmarks('Big', 400, 'big')], { seed: 1, sample: 300, review: 100 });
  assert.equal(plan.maxFolders, 30);
  assert.equal(plan.existingFolders[0], 'Big');
  assert.equal(plan.existingFolders.length, 51);
});

test('existing folders are cut to two levels, cleaned and bounded', () => {
  const items = [
    ...bookmarks('Dev/Python/Django/Models', 3, 'a'),
    ...bookmarks('Dev/Python', 2, 'b'),
    ...bookmarks('Control\u0007Char', 1, 'c'),
    ...bookmarks('x'.repeat(61), 5, 'd'),
    ...bookmarks('', 9, 'e'),
  ];
  const plan = planRun(items, { seed: 1, sample: 5, review: 5 });
  assert.deepEqual(plan.existingFolders, ['Dev/Python', 'Control Char']);
  assert.deepEqual(planRun(items, { seed: 1, sample: 5, review: 5, maxExistingFolders: 1 }).existingFolders, ['Dev/Python']);
});

test('a tiny collection still plans: the taxonomy takes at most a third', () => {
  const items = bookmarks('F', 3, 'x');
  const plan = planRun(items, { seed: 1, sample: 300, review: 100 });
  assert.equal(plan.taxonomySample.length, 1);
  assert.equal(plan.classificationSample.length, 2);
  assert.equal(plan.reviewItems.length, 2);
  assert.equal(plan.maxFolders, 5);
  const one = planRun(bookmarks('F', 1, 'y'), { seed: 1, sample: 10, review: 10 });
  assert.equal(one.taxonomySample.length, 1);
  assert.equal(one.classificationSample.length, 0);
});

test('the plan is deterministic, changes with the seed, and survives bad counts', () => {
  const items = heapCollection();
  const ids = (/** @type {any} */ plan) => plan.reviewItems.map((/** @type {any} */ item) => item.id).join();
  assert.equal(ids(planRun(items, { seed: 3, sample: 300, review: 100 })), ids(planRun(items, { seed: 3, sample: 300, review: 100 })));
  assert.notEqual(ids(planRun(items, { seed: 3, sample: 300, review: 100 })), ids(planRun(items, { seed: 4, sample: 300, review: 100 })));
  const odd = planRun(items, { seed: 1, sample: NaN, review: -5 });
  assert.equal(odd.classificationSample.length, 0);
  assert.equal(odd.reviewItems.length, 0);
});

test('the skewed fixture plans end to end', () => {
  const parsed = parseNetscapeBookmarks(readFileSync(new URL('../fixtures/skewed-collection.html', import.meta.url), 'utf8'));
  const plan = planRun(parsed, { seed: 1, sample: 300, review: 100 });
  assert.equal(parsed.length, 570);
  assert.equal(plan.taxonomySample.length, 150);
  assert.equal(plan.classificationSample.length, 300);
});

test('folder names that hold an email or a token are never offered to the model', () => {
  const items = [
    ...bookmarks('Clientes/juan.perez@acme.com', 4, 'a'),
    ...bookmarks('Otros/token-a1b2c3d4e5f6a7b8c9d0', 3, 'b'),
    ...bookmarks('Cocina', 2, 'c'),
  ];
  assert.deepEqual(planRun(items, { seed: 1, sample: 5, review: 5 }).existingFolders, ['Cocina']);
});
