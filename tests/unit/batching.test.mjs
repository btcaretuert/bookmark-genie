import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateItemTokens, estimateTokens, makeBatches, splitBatch } from '../../extension/core/batching.js';
import { buildClassifyRequest } from '../../extension/core/classify.js';

const item = (/** @type {number} */ i, title = `Title ${i}`) => ({
  id: `b${i}`,
  title,
  url: 'www.example.com/blog/some-article',
  folderPath: 'Other/Data/Engineering/Airflow',
});

test('batches keep order and respect maxItems', () => {
  const items = Array.from({ length: 120 }, (_, i) => item(i));
  const batches = makeBatches(items);
  assert.deepEqual(batches.map((batch) => batch.length), [50, 50, 20]);
  assert.deepEqual(batches.flat(), items);
});

test('an item above the budget travels alone, not truncated', () => {
  const huge = { ...item(0), url: 'x'.repeat(100000) };
  const batches = makeBatches([item(1), huge, item(2)], { maxTokens: 500 });
  assert.equal(batches.some((batch) => batch.includes(huge) && batch.length === 1), true);
  assert.equal(batches.flat().length, 3);
});

test('the estimate measures what is sent, not the id or the folder path', () => {
  const sent = JSON.stringify({ i: 49, title: 'Title 1', url: 'www.example.com/blog/some-article' });
  assert.equal(estimateItemTokens(item(1)), estimateTokens(sent));
  assert.ok(estimateItemTokens(item(1)) < estimateTokens(JSON.stringify(item(1))));
});

test('a title longer than the cap counts only up to the cap', () => {
  assert.equal(estimateItemTokens(item(1, 'x'.repeat(300))), estimateItemTokens(item(1, 'x'.repeat(150))));
  assert.equal(makeBatches(Array.from({ length: 50 }, (_, i) => item(i, 'x'.repeat(300)))).length, 1);
});

test('the estimate tracks the real request within 25 percent, in Latin, CJK and emoji', () => {
  for (const title of ['How to build a data pipeline with Airflow and dbt', 'データパイプラインの構築方法とAirflowの使い方', '🍕'.repeat(40)]) {
    const batch = makeBatches(Array.from({ length: 50 }, (_, i) => item(i, `${title} ${i}`)))[0];
    const estimated = batch.reduce((sum, entry) => sum + estimateItemTokens(entry), 0);
    const real = estimateTokens(buildClassifyRequest(batch, []).user);
    assert.ok(Math.abs(estimated - real) / real < 0.25, `${title}: estimated ${estimated}, real ${real}`);
  }
});

test('items that are not bookmarks are measured as they are', () => {
  assert.equal(estimateItemTokens({ n: 1 }), estimateTokens('{"n":1}'));
  assert.deepEqual(makeBatches([1, 2, 3], { maxItems: 2 }), [[1, 2], [3]]);
});

test('splitBatch halves, first half larger', () => {
  assert.deepEqual(splitBatch([1, 2, 3]), [[1, 2], [3]]);
});
