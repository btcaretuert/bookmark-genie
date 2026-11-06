import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateItemTokens, estimateTokens, makeBatches } from '../../extension/core/batching.js';
import { costOf, createBudget, withBudget } from '../../extension/core/budget.js';
import { budgetPrices } from '../../extension/core/models.js';
import { cleanTitle, cutText } from '../../extension/core/prompt.js';
import { summarizeQuality } from '../../extension/core/quality.js';
import { sanitizeForLlm } from '../../extension/core/url.js';
import { planRun } from '../../extension/core/sampling.js';

// Pins found by mutation testing: each one fails when the constant or comparison it names changes.

const PRICES = budgetPrices();

test('the Claude prices of the catalog are pinned, so a silent edit cannot move the spending cap', () => {
  for (const [id, price] of Object.entries({
    'claude-haiku-5-5': { input: 0.1, output: 0.5 },
    'claude-sonnet-5-5': { input: 2, output: 10 },
    'claude-opus-5-5': { input: 4, output: 20 },
  })) {
    assert.deepEqual(PRICES[id], price, id);
  }
  assert.equal(costOf('claude-sonnet-5-5', 1_000_000, 1_000_000, PRICES), 12);
});

test('withBudget hands back the result of the wrapped call and charges its usage', async () => {
  const attempt = { model: 'claude-haiku-5-5', inputTokens: 1_000_000, outputTokens: 0, thinkingTokens: 0, kind: 'message' };
  const answer = { data: { ok: true }, stopReason: 'end_turn', usage: { attempts: [attempt] } };
  const budget = createBudget(10);
  const wrapped = withBudget(async () => answer, { model: 'claude-haiku-5-5', budget, estimateTokens: () => 1, prices: PRICES });
  const got = await wrapped({ system: 's', user: 'u', schema: {}, maxTokens: 1 });
  assert.equal(got, answer);
  assert.equal(budget.spentUsd, 0.1);
});

const bookmark = (/** @type {string} */ title) => ({ title, url: 'example.com/a' });

test('a batch closes exactly at the token budget and at the item limit', () => {
  const one = estimateItemTokens(bookmark('t'));
  const items = [bookmark('t'), bookmark('t'), bookmark('t')];
  assert.deepEqual(makeBatches(items, { maxTokens: one * 3 }).map((b) => b.length), [3]);
  assert.deepEqual(makeBatches(items, { maxTokens: one * 3 - 1 }).map((b) => b.length), [2, 1]);
  assert.deepEqual(makeBatches(items, { maxItems: 3 }).map((b) => b.length), [3]);
  assert.deepEqual(makeBatches(items, { maxItems: 2 }).map((b) => b.length), [2, 1]);
  assert.deepEqual(makeBatches([]), []);
});

test('the default limits are 50 items and 4000 estimated tokens', () => {
  assert.deepEqual(makeBatches(Array.from({ length: 51 }, () => bookmark('t'))).map((b) => b.length), [50, 1]);
  const big = { title: 'x'.repeat(150), url: `example.com/${'y'.repeat(100)}` };
  const per = estimateItemTokens(big);
  const fits = Math.floor(4000 / per);
  assert.ok(fits > 1 && fits < 50, 'the token limit, not the item limit, must decide');
  assert.deepEqual(makeBatches(Array.from({ length: fits + 1 }, () => big)).map((b) => b.length), [fits, 1]);
  assert.equal(estimateItemTokens(bookmark('t')), estimateTokens(JSON.stringify({ i: 49, title: 't', url: 'example.com/a' })));
});

test('cutText keeps a text of exactly the limit and never splits a surrogate pair', () => {
  assert.equal(cutText('abcdef', 6), 'abcdef');
  assert.equal(cutText('abcdef', 5), 'abcde');
  assert.equal(cutText('ab ', 3), 'ab ', 'a text that already fits is not trimmed');
  assert.equal(cutText('ab\u{1F600}', 3), 'ab');
  assert.equal(cutText('ab\u{1F600}', 4), 'ab\u{1F600}');
});

test('titles: a one-letter top-level domain is not a URL, a two-letter one is', () => {
  assert.equal(cleanTitle('see docs.i/a/b/1'), 'see docs.i/a/b/1');
  assert.equal(cleanTitle('ref a.bb/x/1'), 'ref [url]');
  assert.equal(cleanTitle('mail a@b.c'), 'mail a@b.c');
  assert.equal(cleanTitle('mail a@b.co'), 'mail [email]');
});

test('titles: 14 digits are an identifier, 13 are not', () => {
  assert.equal(cleanTitle('n 12345678901234 x'), 'n [id] x');
  assert.equal(cleanTitle('n 1234567890123 x'), 'n 1234567890123 x');
});

test('quality counts a title that starts with a scheme even when it differs from the URL', () => {
  const sendable = [{ title: ' https://other.example/page ', url: 'example.com/a' }, { title: 'Plain title', url: 'example.com/b' }];
  const q = summarizeQuality({ bookmarks: sendable, sendable });
  assert.equal(q.titleIsUrl, 1);
});

const collection = (/** @type {number} */ n, /** @type {string} */ prefix) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, title: 't', url: `example.com/${i}`, folderPath: `F${i % 7}` }));

test('the taxonomy sample is capped to a third only below 450 bookmarks', () => {
  const options = { seed: 1, sample: 1000, review: 5, taxonomySize: 1000 };
  assert.equal(planRun(collection(449, 'a'), options).taxonomySample.length, 149);
  assert.equal(planRun(collection(450, 'a'), options).taxonomySample.length, 450);
});

test('a plan is reproducible across versions: the ids for a fixed seed are pinned', () => {
  const plan = planRun(collection(600, 'b'), { seed: 1, sample: 20, review: 5, taxonomySize: 10 });
  assert.deepEqual(plan.taxonomySample.map((x) => x.id), ['b100', 'b419', 'b494', 'b150', 'b112', 'b422', 'b362', 'b246', 'b518', 'b349']);
  assert.deepEqual(plan.reviewItems.map((x) => x.id), ['b514', 'b105', 'b174', 'b470', 'b434']);
  assert.equal(plan.classificationSample.length, 20);
});

test('zero sample, review and folder limits give empty lists, not one element', () => {
  const plan = planRun(collection(100, 'c'), { seed: 1, sample: 0, review: 0, taxonomySize: 10, maxExistingFolders: 0 });
  assert.equal(plan.classificationSample.length, 0);
  assert.equal(plan.reviewItems.length, 0);
  assert.equal(plan.existingFolders.length, 0);
});

test('existing folder names: 60 characters stay, 61 are skipped, and 60 names is the default limit', () => {
  const at = (/** @type {number} */ length, /** @type {string} */ id) => ({ id, title: 't', url: 'example.com/a', folderPath: 'x'.repeat(length) });
  const plan = planRun([at(60, 'a'), at(61, 'b')], { seed: 1, sample: 5, review: 1 });
  assert.deepEqual(plan.existingFolders, ['x'.repeat(60)]);
  const many = Array.from({ length: 70 }, (_, i) => ({ id: `m${i}`, title: 't', url: 'example.com/a', folderPath: `Folder ${String(i).padStart(2, '0')}` }));
  assert.equal(planRun(many, { seed: 1, sample: 5, review: 1 }).existingFolders.length, 60);
});

test('an IP written into a public host name is private whatever the octet width or separator', () => {
  for (const url of [
    'https://192.168.100.200.nip.io/x',
    'https://ip-192-168-100-200.example.com/x',
    'https://10.0.0.5.nip.io/x',
  ]) {
    assert.deepEqual(sanitizeForLlm(url), { sendable: false, reason: 'private-host' }, url);
  }
});

test('a date prefix in a path segment is readable only when it has one or two digit month and day', () => {
  assert.deepEqual(sanitizeForLlm('https://example.com/2026-1-5-post'), { sendable: true, url: 'example.com/2026-1-5-post' });
  assert.deepEqual(sanitizeForLlm('https://example.com/2026-123-5-post'), { sendable: true, url: 'example.com' });
});

// tools/lib/args.mjs: the validation that guards spending.
import { parseCli, parseRunOptions, UsageError } from '../../tools/lib/args.mjs';

const runOptions = (/** @type {string[]} */ ...extra) =>
  parseRunOptions(parseCli(['run', '--input', 'in.html', '--models', 'anthropic/claude-haiku-5-5', ...extra]).values);

test('run without --input is a usage error, not a read of undefined', () => {
  assert.throws(() => parseRunOptions(parseCli(['run', '--models', 'anthropic/claude-haiku-5-5']).values), (e) => e instanceof UsageError && /--input/.test(e.message));
});

test('--sample and --review need at least 1, --seed accepts 0, and the limits are exact', () => {
  assert.equal(runOptions('--sample', '1').sample, 1);
  assert.equal(runOptions('--review', '1').review, 1);
  assert.equal(runOptions('--seed', '0').seed, 0);
  for (const bad of ['--sample=0', '--review=0', '--seed=-1', '--seed=1.5', '--sample=abc']) {
    assert.throws(() => runOptions(bad), UsageError, bad);
  }
});

test('every boolean option is off unless given', () => {
  const { values } = parseCli(['run', '--input', 'in.html']);
  for (const flag of ['dry-run', 'fallback', 'check', 'candidates']) assert.equal(values[flag], false, flag);
});

// tools/lib/csv.mjs: what the person's spreadsheet hands back.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCsv, readText, toCsv } from '../../tools/lib/csv.mjs';

test('parseCsv reads a last row without a final newline, and a last row that is only a quoted empty cell', () => {
  assert.deepEqual(parseCsv('judgment,id\ny,b1\nn,b2'), [{ judgment: 'y', id: 'b1' }, { judgment: 'n', id: 'b2' }]);
  assert.deepEqual(parseCsv('judgment,id\ny,b1\n"",b2'), [{ judgment: 'y', id: 'b1' }, { judgment: '', id: 'b2' }]);
  assert.deepEqual(parseCsv('judgment,id\ny,b1\r\n'), [{ judgment: 'y', id: 'b1' }]);
  assert.deepEqual(parseCsv('judgment,id\ny,b1\r'), [{ judgment: 'y', id: 'b1' }], 'a lone final carriage return is a line ending');
  assert.deepEqual(parseCsv('judgment,id\r\ny,b1\r\nn,b2'), [{ judgment: 'y', id: 'b1' }, { judgment: 'n', id: 'b2' }]);
});

test('parseCsv drops a UTF-8 BOM, blank lines and trailing blank rows, and pads short rows', () => {
  assert.deepEqual(parseCsv('﻿judgment,id\ny,b1\n\n\n'), [{ judgment: 'y', id: 'b1' }]);
  assert.deepEqual(parseCsv('judgment,id,title\ny,b1\n'), [{ judgment: 'y', id: 'b1', title: '' }]);
});

test('parseCsv keeps quoted commas, quotes, newlines and carriage returns as data', () => {
  const [row] = parseCsv('judgment,title\ny,"a, ""b""\r\nc"\n');
  assert.equal(row.title, 'a, "b"\r\nc');
  assert.deepEqual(toCsv(['h'], [['x"y,z']]), '"h"\n"x""y,z"\n');
});

test('parseCsv takes the semicolon of a spreadsheet only when no comma delimits the header', () => {
  assert.deepEqual(parseCsv('judgment;id\ny;b1\n'), [{ judgment: 'y', id: 'b1' }]);
  assert.deepEqual(parseCsv('judgment,id\ny,"a;b"\n'), [{ judgment: 'y', id: 'a;b' }]);
  assert.deepEqual(parseCsv('"a;b",c\n1,2\n'), [{ 'a;b': '1', c: '2' }]);
});

test('readText falls back to Windows-1252 when the file is not valid UTF-8', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qa-csv-'));
  try {
    await writeFile(join(dir, 'a.csv'), Buffer.from('s\xed', 'latin1'));
    await writeFile(join(dir, 'b.csv'), 'sí', 'utf8');
    assert.equal(await readText(join(dir, 'a.csv')), 'sí');
    assert.equal(await readText(join(dir, 'b.csv')), 'sí');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// tools/eval.mjs: the Node guard runs before anything is read or sent.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EVAL_PATH = fileURLToPath(new URL('../../tools/eval.mjs', import.meta.url));
const OLD_NODE = fileURLToPath(new URL('../helpers/old-node.mjs', import.meta.url));

test('eval.mjs refuses Node older than 20.12 and names the fix, before reading anything', () => {
  for (const version of ['18.19.1', '19.9.0', '20.11.9']) {
    const result = spawnSync(process.execPath, ['--import', OLD_NODE, EVAL_PATH, 'run', '--input', '/nonexistent.html'], {
      encoding: 'utf8',
      env: { ...process.env, QA_FAKE_NODE: version },
    });
    assert.equal(result.status, 1, version);
    assert.match(result.stderr, new RegExp(`Node 20\\.12 or newer is required \\(this is ${version.replaceAll('.', '\\.')}\\)`));
    assert.match(result.stderr, /npm run eval --/);
  }
});

test('eval.mjs accepts Node 20.12 and any newer major whatever its minor', () => {
  for (const version of ['20.12.0', '22.0.0']) {
    const result = spawnSync(process.execPath, ['--import', OLD_NODE, EVAL_PATH, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, QA_FAKE_NODE: version },
    });
    assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
  }
});

// budget.js: charging after a call that failed, and the cap-breach record.
const CHEAP = { 'a/cheap': { input: 1, output: 2 } };
const attemptOf = (/** @type {string} */ model, /** @type {number} */ inputTokens, /** @type {number} */ outputTokens) => ({
  model,
  inputTokens,
  outputTokens,
  thinkingTokens: 0,
  kind: 'message',
});
const REQUEST_OF = (/** @type {number} */ maxTokens) => ({ system: 's', user: 'u', schema: {}, maxTokens });

test('a failure that still carries usage is charged at its real cost, and that cost is counted as lost', async () => {
  const budget = createBudget(100);
  budget.spentUsd = 1;
  const failing = withBudget(
    async () => {
      throw Object.assign(new Error('unusable'), { mayHaveBilled: true, usage: { attempts: [attemptOf('a/cheap', 1_000_000, 500_000)] } });
    },
    { model: 'a/cheap', budget, estimateTokens: () => 1, prices: CHEAP },
  );
  await assert.rejects(failing(REQUEST_OF(10)), /unusable/);
  assert.equal(budget.spentUsd, 1 + 2, 'real cost 1 + 1 = 2 USD on top of the 1 already spent');
  assert.equal(budget.lostUsd, 2);
});

test('the cap-breach record names the attempt model, or the requested one when the attempt names none', async () => {
  for (const [attemptModel, expected] of [['', 'a/cheap'], ['a/other', 'a/other']]) {
    const budget = createBudget(100);
    const wrapped = withBudget(
      async () => ({ data: {}, stopReason: 'end_turn', usage: { attempts: [attemptOf(attemptModel, 1, 11)] } }),
      { model: 'a/cheap', budget, estimateTokens: () => 1, prices: CHEAP },
    );
    await wrapped(REQUEST_OF(10));
    assert.deepEqual(budget.capBrokenBy, { model: expected, maxTokens: 10, outputTokens: 11 });
  }
});

test('an answer exactly at max_tokens is not a breach, and an empty price table costs nothing', async () => {
  const budget = createBudget(100);
  const wrapped = withBudget(
    async () => ({ data: {}, stopReason: 'end_turn', usage: { attempts: [attemptOf('a/cheap', 1, 10)] } }),
    { model: 'a/cheap', budget, estimateTokens: () => 1, prices: CHEAP },
  );
  await wrapped(REQUEST_OF(10));
  assert.equal(budget.capBrokenBy, null);
  assert.equal(costOf('x', 1_000_000, 1_000_000, {}), 0);
});

test('--help is off by default', () => {
  assert.equal(parseCli(['run']).values.help, false);
});
