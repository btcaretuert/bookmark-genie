import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderReport } from '../../tools/lib/report.mjs';

const manifest = {
  input: { bookmarks: 400, sendable: 380, excluded: { 'private-host': 20 } },
  params: { seed: 1, sample: 4, max_usd: 1 },
  spent_usd: 0.05,
  stopped_by: null,
};

const metrics = (/** @type {object} */ extra = {}) => ({
  inputTokens: 4100,
  outputTokens: 2050,
  thinkingTokens: 900,
  maxThinkingTokens: 400,
  latencies: [10, 20, 30, 40],
  fallbacks: 0,
  waits: 1,
  failedCalls: 3,
  spentUsd: 0.04,
  servedModels: { 'claude-haiku-5-5': 4 },
  ...extra,
});

const totals = { calls: 4, retries: 1, splits: 0, refusals: 0, truncations: 0, invalidEntries: 2 };

/** @param {object} [extra] */
const result = (extra = {}) => ({
  model: 'claude-haiku-5-5',
  status: 'complete',
  effort: 'low',
  folders: [
    { name: 'Dev', description: 'Code.' },
    { name: 'Food', description: 'Recipes.' },
    { name: 'Unused', description: 'Nothing lands here.' },
  ],
  dropped: [{ name: 'A/B/C', reason: 'too_deep' }],
  taxonomyAttempts: 1,
  taxonomyBuiltFrom: 150,
  taxonomyRefusals: 0,
  taxonomyTruncations: 0,
  assignments: [
    { id: 'a', folder: 'Dev', confidence: 'high' },
    { id: 'b', folder: 'Dev', confidence: 'low' },
    { id: 'c', folder: 'Food', confidence: 'high' },
    { id: 'd', folder: '__unsorted__', confidence: 'high' },
  ],
  unclassified: [],
  totals,
  metrics: metrics(),
  ...extra,
});

/** @param {string} report @param {string} label */
const row = (report, label) => report.split('\n').find((line) => line.startsWith(`| ${label}`)) ?? '';

test('every figure of a complete run is the one that was measured', () => {
  const report = renderReport({ manifest, results: [result()] });
  assert.match(report, /M0 completeness: PASS\*\* \(missing=0, not attempted=0\)/);
  assert.match(row(report, 'Placed in a folder'), /\| 3 of 4 \|/);
  assert.match(row(report, 'Sent to unsorted'), /\| 1 \|/);
  assert.match(row(report, 'Low confidence'), /1 \(25\.0 % of answered\)/);
  assert.match(row(report, 'Folders used'), /\| 2 \/ 3 \|/);
  assert.match(row(report, 'Largest folder share'), /50\.0 %/);
  assert.match(row(report, 'Proposals discarded'), /1 \(too\\?_deep: 1\)/);
  assert.match(row(report, 'Taxonomy built from'), /150 bookmarks, 1 attempt/);
  assert.match(row(report, 'API calls'), /\| 4 \/ 3 \/ 1 \|/);
  assert.match(row(report, 'Reasoning tokens'), /900 \/ 400/);
  assert.match(row(report, 'Models that answered'), /claude-haiku-5-5: 4/);
  assert.match(row(report, 'Cost of this run'), /US\$0\.0400/);
  assert.match(row(report, 'Projected cost'), /US\$20\.0000|US\$0\.0200/);
  assert.doesNotMatch(report, /__unsorted__/);
});

test('percentiles use the nearest rank', () => {
  const report = renderReport({ manifest, results: [result({ metrics: metrics({ latencies: [100, 10] }) })] });
  assert.match(row(report, 'Latency'), /10 ms \/ 100 ms/);
});

test('a single concentrated folder shows as 100 percent', () => {
  const assignments = ['a', 'b', 'c', 'd'].map((id) => ({ id, folder: 'Dev', confidence: 'high' }));
  assert.match(row(renderReport({ manifest, results: [result({ assignments })] }), 'Largest folder share'), /100\.0 %/);
});

test('a missing index fails completeness; a refusal does not, but it is counted and capped', () => {
  const four = result().assignments;
  const missing = renderReport({ manifest, results: [result({ assignments: four.slice(0, 3), unclassified: [{ id: 'd', reason: 'missing' }] })] });
  assert.match(missing, /M0 completeness: FAIL\*\* \(missing=1, not attempted=0\)/);
  assert.match(row(missing, 'Missing after retries'), /\| 1 \|/);

  const refused = renderReport({ manifest, results: [result({ assignments: four.slice(0, 3), unclassified: [{ id: 'd', reason: 'refusal' }] })] });
  assert.match(refused, /M0 completeness: PASS\*\* \(missing=0, not attempted=0\)/);
  assert.match(row(refused, 'Refused or truncated'), /1 \(25\.0 % of the sample; refusal: 1\)/);
  assert.match(refused, /Over the limit.*25\.0 %.*2\.0 %/);
});

test('a partial model is marked incomplete and fails completeness', () => {
  const report = renderReport({
    manifest: { ...manifest, stopped_by: 'claude-haiku-5-5: Next call could exceed the cap' },
    results: [result({ status: 'stopped', assignments: result().assignments.slice(0, 2) })],
  });
  assert.match(report, /## claude-haiku-5-5 \(INCOMPLETE/);
  assert.match(report, /M0 completeness: FAIL\*\* \(missing=0, not attempted=2\)/);
  assert.match(report, /\*\*Stopped early\.\*\*/);
});

test('model-written text cannot inject Markdown or extra lines', () => {
  const report = renderReport({
    manifest,
    results: [result({ folders: [{ name: 'Evil\n# Heading', description: '[x](http://evil.example)\n<script>' }] })],
  });
  assert.doesNotMatch(report, /^# Heading/m);
  assert.doesNotMatch(report, /<script>/);
});

test('data quality counts appear when the manifest has them', () => {
  const quality = { exactDuplicates: 5, duplicatesAfterReduction: 9, emptyTitles: 2, titleIsUrl: 3, hostOnlyUrls: 7 };
  assert.match(renderReport({ manifest: { ...manifest, quality }, results: [] }), /exact duplicates 5, duplicates after URL reduction 9, empty titles 2, title equal to URL 3, URL reduced to the host alone 7/);
});

test('the projection scales the per-bookmark cost and keeps the taxonomy call as a fixed cost', () => {
  const report = renderReport({ manifest, results: [result({ taxonomySpentUsd: 0.01, metrics: metrics({ spentUsd: 0.04 }) })] });
  // 0.01 + (0.04 - 0.01) / 4 * 2000 = 15.01
  assert.match(row(report, 'Projected cost'), /US\$15\.0100/);
});

test('what was charged for calls without an usable answer is named, and is not projected', () => {
  const lossy = { ...manifest, spent_usd: 0.14, lost_usd: 0.1 };
  const report = renderReport({ manifest: lossy, results: [result({ taxonomySpentUsd: 0, metrics: metrics({ spentUsd: 0.14, lostUsd: 0.1 }) })] });
  assert.match(report, /Total spent: US\$0\.1400 of a US\$1\.0000 cap \(US\$0\.1000 of it charged for calls that gave no usable answer\)\./);
  assert.match(row(report, 'Cost of this run'), /US\$0\.1400 \(US\$0\.1000 of it charged for calls that gave no usable answer\)/);
  // (0.14 - 0.1) / 4 * 2000, not 0.14 / 4 * 2000
  assert.match(row(report, 'Projected cost'), /US\$20\.0000/);
});

test('refusals are a share of their own, and a partial model measures it against what was attempted', () => {
  const missing = { id: 'b9', reason: 'missing', refusalCategory: null };
  const refused = { id: 'b8', reason: 'refusal', refusalCategory: null };
  const base = result();
  const withBoth = (extra = {}) => result({ unclassified: [missing, refused], assignments: base.assignments.slice(0, 2), ...extra });
  assert.match(row(renderReport({ manifest, results: [withBoth()] }), 'Refused or truncated'), /\| 1 \(25\.0 % of the sample;/);
  const partial = renderReport({ manifest, results: [withBoth({ status: 'stopped' })] });
  assert.match(row(partial, 'Refused or truncated'), /of what was attempted/);
  assert.match(partial, /of what was attempted stayed unclassified/);
});

test('a taxonomy read from a file says so instead of describing a proposal', () => {
  const report = renderReport({ manifest: { ...manifest, taxonomy_sha256: 'abcdef0123456789' }, results: [result({ fixedTaxonomy: true })] });
  assert.match(report, /Taxonomy: from file abcdef012345/);
  assert.doesNotMatch(report, /Proposed folders|Taxonomy built from|Proposals discarded/);
});

test('a spending cap that was crossed, or a provider that broke max tokens, is stated', () => {
  const crossed = renderReport({ manifest: { ...manifest, spent_usd: 1.5 }, results: [] });
  assert.match(crossed, /The spending cap was crossed/);
  const broken = renderReport({
    manifest: { ...manifest, cap_broken_by: { model: 'x/y', max_tokens: 100, output_tokens: 5000 } },
    results: [],
  });
  assert.match(broken, /cap cannot be trusted with x\/y.*5000 output tokens for a maximum of 100/);
  assert.doesNotMatch(renderReport({ manifest, results: [] }), /cap was crossed|cannot be trusted/);
});

test('an interrupted run keeps the warning that the total may be low', () => {
  const report = renderReport({ manifest: { ...manifest, stopped_by: 'interrupted by SIGINT; a call in flight may still be billed' }, results: [] });
  assert.match(report, /Total spent: US\$0\.0500 of a US\$1\.0000 cap\. This total may be low/);
});

test('a different model answering is flagged, and a dated version of the same one is not', () => {
  const ref = 'openai/gpt-6-luna';
  const withServed = (/** @type {Record<string, number>} */ servedModels) =>
    renderReport({ manifest, results: [result({ model: ref, metrics: metrics({ servedModels }) })] });
  assert.match(withServed({ 'gpt-4o-mini-otro': 4 }), /Unexpected model answered:\*\* gpt-4o-mini-otro/);
  assert.doesNotMatch(withServed({ 'gpt-6-luna': 2, 'gpt-6-luna-2026-10-01': 2 }), /Unexpected model/);
});

test('the catalog note travels with the cost, and the plus or minus claim is dropped for that model', () => {
  const report = renderReport({ manifest, results: [result({ model: 'deepseek/deepseek-flash' })] });
  assert.match(row(report, 'Cost of this run'), /Note on this model: .*[Pp]eak/);
  assert.doesNotMatch(row(report, 'Projected cost'), /15 %/);
});
