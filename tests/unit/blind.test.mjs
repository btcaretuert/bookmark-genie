import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { orderRows, runBlind } from '../../tools/lib/blind.mjs';
import { parseCsv, toCsv } from '../../tools/lib/csv.mjs';
import { createManifest, modelFileStem, updateManifest, writeManifest } from '../../tools/lib/manifest.mjs';
import { runScore } from '../../tools/lib/score.mjs';

const HAIKU = 'anthropic/claude-haiku-5-5';
const OPUS = 'anthropic/claude-opus-5-5';
const COLUMNS = ['judgment', 'id', 'title', 'url', 'original_folder', 'assigned_folder', 'confidence'];
const IDS = Array.from({ length: 100 }, (_, i) => `b${i}`);

let workDir;
let count = 0;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'bookmark-genie-blind-'));
});
after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function newPath(name) {
  count += 1;
  return join(workDir, `${count}-${name}`);
}

/** A finished run with one review per model; `folderOf(model, i)` gives the answer for row i. */
async function makeRun({ models = [HAIKU], folderOf = (_, i) => `F${i % 10}`, inputBytes = 'export', reviewIds = IDS, spent = {}, lost = {} } = {}) {
  const dir = newPath('run');
  await mkdir(dir);
  let manifest = createManifest({
    startedAt: '2026-11-05T10:00:00.000Z',
    tool: { code_sha256: 'x', node: '26.13.0', anthropic_sdk: '1.5.0' },
    inputBytes,
    bookmarks: 500,
    sendable: 500,
    excluded: {},
    params: { seed: 1, sample: 300, review: reviewIds.length, language: 'Spanish', max_usd: 1 },
    models: models.map((ref) => ({ ref, effort: 'low', prompts: { classify: null, taxonomy: null } })),
    prices: Object.fromEntries(models.map((ref) => [ref, { input: 1, output: 1 }])),
    taxonomySampleIds: [],
    sampleIds: reviewIds,
    reviewIds,
  });
  for (const model of models) {
    manifest = updateManifest(manifest, {
      model: { requested: model, status: 'complete', classified: 300, unclassified: 0, unclassified_reasons: {}, spent_usd: spent[model] ?? 0.01 },
    });
    const rows = reviewIds.map((id, i) => ['', id, `Title ${id}`, `example.com/${id}`, i % 2 ? 'Old' : '', folderOf(model, i), i % 3 ? 'high' : 'low']);
    await writeFile(join(dir, `review-${modelFileStem(model)}.csv`), toCsv(COLUMNS, rows));
  }
  manifest = { ...manifest, models: manifest.models.map((entry) => ({ ...entry, lost_usd: lost[entry.requested] ?? 0 })) };
  await writeManifest(dir, manifest);
  return dir;
}

async function quietly(action) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const code = await action();
    return { code, output: lines.join('\n') };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

async function makeList(runDirs, options = {}) {
  const out = options.out ?? `${newPath('blind')}.csv`;
  const result = await quietly(() => runBlind(runDirs, { ...options, out }));
  return { ...result, out, key: out.replace(/\.csv$/, '.key.json') };
}

/** Fills the list as `decide({id, folder, repeat, position})` says. */
async function judge(out, key, decideRow) {
  const { rows: keyRows } = JSON.parse(await readFile(key, 'utf8'));
  const byRow = new Map(keyRows.map((row, position) => [row.row, { ...row, position }]));
  const rows = parseCsv(await readFile(out, 'utf8'));
  await writeFile(
    out,
    toCsv(
      Object.keys(rows[0]),
      rows.map((row) => [decideRow(byRow.get(row.row)), row.row, row.title, row.url, row.folder]),
    ),
  );
}

test('the list hides the model, the confidence and the original folder', async () => {
  const { code, out, output } = await makeList([await makeRun()]);
  assert.equal(code, 0);
  const text = await readFile(out, 'utf8');
  assert.equal(text.split('\n')[0], '"judgment","row","title","url","folder"');
  for (const hidden of ['claude', 'haiku', 'anthropic', 'confidence', 'high', 'low', 'Old', 'original_folder']) {
    assert.ok(!text.includes(hidden), `${hidden} shows in the list`);
  }
  assert.ok(!/claude|haiku/i.test(output.replace(/\n.*(List|Key|score).*/g, '')), 'the summary names no model');
});

test('list and key are private, and the run directory stays the default place', async () => {
  const dir = await makeRun();
  const { code } = await quietly(() => runBlind([dir]));
  assert.equal(code, 0);
  for (const name of ['blind.csv', 'blind.key.json']) {
    assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600, name);
  }
});

test('each bookmark and folder goes once, abstentions are left out, and one pair in ten repeats', async () => {
  const dir = await makeRun({ folderOf: (_, i) => (i < 5 ? '__unsorted__' : i < 8 ? '(unclassified)' : `F${i % 10}`) });
  const { out, key } = await makeList([dir]);
  const rows = parseCsv(await readFile(out, 'utf8'));
  assert.equal(rows.length, 92 + 9);
  assert.ok(rows.every((row) => !row.folder.startsWith('__') && !row.folder.startsWith('(')));
  assert.equal(new Set(rows.map((row) => row.row)).size, rows.length);

  const { rows: keyRows } = JSON.parse(await readFile(key, 'utf8'));
  assert.equal(keyRows.filter((row) => row.repeat).length, 9);
  assert.equal(new Set(keyRows.filter((row) => !row.repeat).map((row) => JSON.stringify([row.id, row.folder]))).size, 92);
});

test('arms that agree share rows: the same pair is judged once', async () => {
  const dir = await makeRun({
    models: [HAIKU, OPUS],
    folderOf: (model, i) => (model === OPUS && i < 20 ? `Other ${i}` : `F${i % 10}`),
  });
  const { out, output } = await makeList([dir]);
  const rows = parseCsv(await readFile(out, 'utf8'));
  assert.equal(rows.length, 120 + 10);
  assert.match(output, /Arms: 2\. Rows to judge: 130 \(120 pairs and 10 repeated\)/);
});

test('repeated rows come from the first half and land in the second', () => {
  const pairs = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, title: 't', url: 'u', folder: 'F' }));
  const ordered = orderRows(pairs, 1);
  assert.equal(ordered.length, 110);
  ordered.forEach((row, position) => {
    if (row.repeat) {
      assert.ok(position >= 50, `repeat at ${position}`);
      const firstSeen = ordered.findIndex((other) => other.id === row.id);
      assert.ok(firstSeen < 50 && firstSeen !== position);
    }
  });
});

test('a long list repeats 10 rows at most, and a short one stays short', () => {
  const pairsOf = (length) => Array.from({ length }, (_, i) => ({ id: `b${i}`, title: 't', url: 'u', folder: 'F' }));
  const repeatsIn = (length) => orderRows(pairsOf(length), 1).filter((row) => row.repeat).length;
  assert.equal(repeatsIn(300), 10);
  assert.equal(repeatsIn(100), 10);
  assert.equal(repeatsIn(99), 9);
  assert.equal(repeatsIn(20), 2);
  assert.equal(repeatsIn(9), 0);
  assert.deepEqual(orderRows([], 1), []);
});

test('the first half is shuffled, and repeated rows mix with the second', () => {
  const pairs = Array.from({ length: 100 }, (_, i) => ({ id: `b${String(i).padStart(3, '0')}`, title: 't', url: 'u', folder: 'F' }));
  const ordered = orderRows(pairs, 1);
  const ids = ordered.map((row) => row.id);
  assert.notDeepEqual(ids.slice(0, 50), [...ids.slice(0, 50)].sort());
  const positions = ordered.flatMap((row, position) => (row.repeat ? [position] : []));
  assert.ok(positions.at(-1) - positions[0] > 10, `repeats are together: ${positions}`);
  assert.ok(positions[0] < 100, 'repeats are not all at the end');
  assert.notDeepEqual(positions, Array.from({ length: 10 }, (_, i) => 100 + i));
});

test('the seed fixes the order, and another seed changes it', async () => {
  const dir = await makeRun();
  const first = await makeList([dir], { seed: 7 });
  const again = await makeList([dir], { seed: 7 });
  const other = await makeList([dir], { seed: 8 });
  const titles = async (path) => parseCsv(await readFile(path, 'utf8')).map((row) => row.title);
  assert.deepEqual(await titles(first.out), await titles(again.out));
  assert.notDeepEqual(await titles(first.out), await titles(other.out));
});

test('the order does not depend on which run was named first', async () => {
  const a = await makeRun({ folderOf: (_, i) => `A${i % 5}` });
  const b = await makeRun({ folderOf: (_, i) => `B${i % 5}` });
  const titles = async (path) => parseCsv(await readFile(path, 'utf8')).map((row) => row.folder + row.title);
  const first = await makeList([a, b]);
  const second = await makeList([b, a]);
  assert.deepEqual(await titles(first.out), await titles(second.out));
});

test('the order is not the order of the review', async () => {
  const { out } = await makeList([await makeRun()]);
  const ids = parseCsv(await readFile(out, 'utf8')).map((row) => Number(row.title.slice(7)));
  assert.notDeepEqual(ids.slice(0, 20), [...ids.slice(0, 20)].sort((a, b) => a - b));
});

test('other CSV files in a run directory are not reviews', async () => {
  const dir = await makeRun();
  await writeFile(join(dir, 'notes.csv'), 'a,b\n1,2\n');
  const { code } = await makeList([dir]);
  assert.equal(code, 0);
});

test('the default list, next to the reviews, is not read as one', async () => {
  const dir = await makeRun();
  await quietly(() => runBlind([dir]));
  const { code } = await makeList([dir]);
  assert.equal(code, 0);
});

test('a list is never overwritten, since it may hold judgments', async () => {
  const dir = await makeRun();
  const { out, key } = await makeList([dir]);
  await writeFile(out, 'my judgments');
  await assert.rejects(runBlind([dir], { out }), /Refusing to overwrite/);
  assert.equal(await readFile(out, 'utf8'), 'my judgments');

  const orphanKeyOut = `${newPath('orphan')}.csv`;
  await writeFile(orphanKeyOut.replace(/\.csv$/, '.key.json'), '{}');
  await assert.rejects(runBlind([dir], { out: orphanKeyOut }), /Refusing to overwrite/);
  await assert.rejects(access(orphanKeyOut));
  assert.ok(await readFile(key, 'utf8'));
});

test('runs from another export are refused, since ids are positions in it', async () => {
  const a = await makeRun();
  const b = await makeRun({ inputBytes: 'another export' });
  const out = `${newPath('blind')}.csv`;
  await assert.rejects(runBlind([a, b], { out }), /comes from another export/);
  await assert.rejects(access(out));
});

test('runs that reviewed other bookmarks are refused', async () => {
  const a = await makeRun();
  const b = await makeRun({ reviewIds: IDS.map((id) => `${id}x`) });
  await assert.rejects(runBlind([a, b], { out: `${newPath('blind')}.csv` }), /reviewed other bookmarks/);
});

test('it needs runs, with reviews that belong to them', async () => {
  await assert.rejects(runBlind([]), /Usage/);
  const empty = newPath('empty');
  await mkdir(empty);
  await assert.rejects(runBlind([empty], { out: `${newPath('blind')}.csv` }), /no review-\*\.csv/);

  const dir = await makeRun();
  await writeFile(join(dir, 'review-anthropic__claude-haiku-5-5.csv'), toCsv(COLUMNS, [['', 'b0', 't', 'u', '', 'F', 'high']]));
  await assert.rejects(runBlind([dir], { out: `${newPath('blind')}.csv` }), /does not hold the bookmarks/);
});

test('a judged list gives each arm its own result, on the same judgments', async () => {
  // Haiku has 16 unique folders it gets wrong; the rest are shared and right.
  const dir = await makeRun({
    models: [HAIKU, OPUS],
    folderOf: (model, i) => (model === HAIKU && i < 16 ? `Wrong ${i}` : `F${i % 10}`),
    spent: { [HAIKU]: 0.01, [OPUS]: 0.5 },
  });
  const { out, key } = await makeList([dir]);
  await judge(out, key, ({ folder }) => (folder.startsWith('Wrong') ? 'n' : 'y'));

  const { code, output } = await quietly(() => runScore([out]));
  assert.equal(code, 0);
  assert.match(output, /Accepted: 84 {2}Rejected: 16/);
  assert.match(output, /Accepted: 100 {2}Rejected: 0/);
  assert.match(output, /Verdict: GRAY/);
  assert.match(output, /Verdict: PASS/);
  assert.match(output, /only the first 0, only the second 16, net -16 rows/);
  assert.match(output, /Decision: go on with anthropic\/claude-opus-5-5/);
  assert.match(output, /Repeated rows: 0 of 10 changed\./);
});

test('a later list only asks what is new, and carries over the rest', async () => {
  const first = await makeRun({ folderOf: (_, i) => `F${i % 10}`, spent: { [HAIKU]: 0.01 } });
  const list = await makeList([first]);
  await judge(list.out, list.key, ({ folder }) => (folder === 'F0' ? 'n' : 'y'));

  // A new arm that only differs on 10 rows, all of which the judge accepts.
  const second = await makeRun({ models: [OPUS], folderOf: (_, i) => (i % 10 === 0 ? `New ${i}` : `F${i % 10}`), spent: { [OPUS]: 0.5 } });
  const next = await makeList([first, second], { previous: [list.out] });
  assert.match(next.output, /Rows to judge: 11 \(10 pairs and 1 repeated\)\. Judgments carried over: 100\./);
  const rows = parseCsv(await readFile(next.out, 'utf8'));
  assert.ok(rows.every((row) => row.folder.startsWith('New')));

  await judge(next.out, next.key, () => 'y');
  const { code, output } = await quietly(() => runScore([next.out]));
  assert.match(output, /Accepted: 90 {2}Rejected: 10/);
  assert.match(output, /Accepted: 100 {2}Rejected: 0/);
  assert.equal(code, 0);
  assert.match(output, /only the first 0, only the second 10, net -10 rows/);
  assert.match(output, /Decision: go on with anthropic\/claude-opus-5-5/);
});

test('only what was judged carries over', async () => {
  const run = await makeRun();
  const list = await makeList([run]);
  await judge(list.out, list.key, ({ repeat, position }) => (!repeat && position < 20 ? 'y' : ''));
  const next = await makeList([run], { previous: [list.out] });
  assert.match(next.output, /Judgments carried over: 20\./);
  const rows = parseCsv(await readFile(next.out, 'utf8'));
  assert.equal(rows.length, 80 + 8);
});

test('when every pair was judged before, the new list is empty and still scores', async () => {
  const run = await makeRun();
  const list = await makeList([run]);
  await judge(list.out, list.key, () => 'y');
  const next = await makeList([run], { previous: [list.out] });
  assert.match(next.output, /Rows to judge: 0/);
  const { code, output } = await quietly(() => runScore([next.out]));
  assert.equal(code, 0);
  assert.match(output, /Accepted: 100/);
});

test('judgments of other bookmarks do not carry over', async () => {
  const run = await makeRun();
  const list = await makeList([run]);
  await judge(list.out, list.key, () => 'y');
  const otherExport = await makeRun({ inputBytes: 'another export' });
  await assert.rejects(runBlind([otherExport], { out: `${newPath('blind')}.csv`, previous: [list.out] }), /judged other bookmarks/);
  const otherRows = await makeRun({ reviewIds: IDS.map((id) => `${id}x`) });
  await assert.rejects(runBlind([otherRows], { out: `${newPath('blind')}.csv`, previous: [list.out] }), /judged other bookmarks/);
});

test('in the list, the abstentions of an arm count as not accepted', async () => {
  const dir = await makeRun({ folderOf: (_, i) => (i < 10 ? '__unsorted__' : `F${i % 10}`) });
  const { out, key } = await makeList([dir]);
  await judge(out, key, () => 'y');
  const { code, output } = await quietly(() => runScore([out]));
  assert.equal(code, 0);
  assert.match(output, /Accepted: 90 {2}Rejected: 0 {2}Abstained: 10/);
  assert.match(output, /Acceptance: 90\.0 %/);
  assert.match(output, /Coverage: 90\.0 %/);
});

test('the list keeps confidence and origin apart from the judge, not from the result', async () => {
  const dir = await makeRun();
  const { out, key } = await makeList([dir]);
  await judge(out, key, () => 'y');
  const { output } = await quietly(() => runScore([out]));
  assert.match(output, /By confidence: high 66\/66 \(100\.0 %\), low 34\/34 \(100\.0 %\)/);
  assert.match(output, /By origin: already in a folder 50\/50 \(100\.0 %\), loose 50\/50 \(100\.0 %\)/);
});

test('two repeated rows that change warn that the criterion is not stable', async () => {
  const dir = await makeRun();
  const { out, key } = await makeList([dir]);
  let flipped = 0;
  await judge(out, key, ({ repeat }) => {
    if (repeat && flipped < 2) {
      flipped += 1;
      return 'n';
    }
    return 'y';
  });
  const { output } = await quietly(() => runScore([out]));
  assert.match(output, /Repeated rows: 2 of 10 changed\. Your criterion is not stable/);
});

test('a single repeated row that changes is not called unstable', async () => {
  const dir = await makeRun();
  const { out, key } = await makeList([dir]);
  let flipped = 0;
  await judge(out, key, ({ repeat }) => {
    if (repeat && flipped < 1) {
      flipped += 1;
      return 'n';
    }
    return 'y';
  });
  const { output } = await quietly(() => runScore([out]));
  assert.match(output, /Repeated rows: 1 of 10 changed\.$/m);
});

test('a list sorted in a spreadsheet is still scored by its row numbers', async () => {
  const dir = await makeRun();
  const { out, key } = await makeList([dir]);
  await judge(out, key, ({ folder }) => (folder === 'F0' ? 'n' : 'y'));
  const rows = parseCsv(await readFile(out, 'utf8')).sort((a, b) => (a.title < b.title ? -1 : 1));
  await writeFile(out, toCsv(Object.keys(rows[0]), rows.map(Object.values)));
  const { output } = await quietly(() => runScore([out]));
  assert.match(output, /Accepted: 90 {2}Rejected: 10/);
});

test('an unfinished list is not decided', async () => {
  const dir = await makeRun();
  const { out, key } = await makeList([dir]);
  await judge(out, key, ({ position }) => (position < 20 ? 'y' : ''));
  const { code, output } = await quietly(() => runScore([out]));
  assert.equal(code, 1);
  assert.match(output, /Incomplete/);
  assert.doesNotMatch(output, /Decision/);
});

test('a repeated row left blank does not hold up the result', async () => {
  const dir = await makeRun();
  const { out, key } = await makeList([dir]);
  await judge(out, key, ({ repeat }) => (repeat ? '' : 'y'));
  const { code, output } = await quietly(() => runScore([out]));
  assert.equal(code, 0);
  assert.doesNotMatch(output, /Repeated rows/);
});

test('a list without some of its rows, or with others, is rejected', async () => {
  const dir = await makeRun();
  const { out, key } = await makeList([dir]);
  await judge(out, key, () => 'y');
  const rows = parseCsv(await readFile(out, 'utf8'));
  await writeFile(out, toCsv(Object.keys(rows[0]), rows.slice(1).map(Object.values)));
  await assert.rejects(runScore([out]), /does not hold the rows of its key/);

  await writeFile(out, toCsv(Object.keys(rows[0]), rows.map((row, i) => Object.values({ ...row, row: i === 0 ? 'r9999' : row.row }))));
  await assert.rejects(runScore([out]), /does not hold the rows of its key/);

  await writeFile(out, toCsv(Object.keys(rows[0]), rows.map((row, i) => Object.values({ ...row, row: i === 0 ? rows[1].row : row.row }))));
  await assert.rejects(runScore([out]), /does not hold the rows of its key/);
});

test('a list with a row twice is rejected, even with every row present', async () => {
  const dir = await makeRun();
  const { out, key } = await makeList([dir]);
  await judge(out, key, () => 'y');
  const rows = parseCsv(await readFile(out, 'utf8'));
  await writeFile(out, toCsv(Object.keys(rows[0]), [...rows, rows[0]].map(Object.values)));
  await assert.rejects(runScore([out]), /does not hold the rows of its key/);
});

test('a list that lost a column says so', async () => {
  const dir = await makeRun();
  const { out, key } = await makeList([dir]);
  await judge(out, key, () => 'y');
  const rows = parseCsv(await readFile(out, 'utf8'));
  await writeFile(out, toCsv(['judgment', 'row'], rows.map((row) => [row.judgment, row.row])));
  await assert.rejects(runScore([out]), /has no column title, url, folder/);
});

test('a list whose folders no longer match its key is rejected', async () => {
  const dir = await makeRun();
  const { out, key } = await makeList([dir]);
  await judge(out, key, () => 'y');
  const rows = parseCsv(await readFile(out, 'utf8'));
  await writeFile(out, toCsv(Object.keys(rows[0]), rows.map((row, i) => Object.values({ ...row, folder: i === 0 ? 'Otra' : row.folder }))));
  await assert.rejects(runScore([out]), /does not match its key/);
});

test('a key that is not one is rejected', async () => {
  const out = `${newPath('blind')}.csv`;
  await writeFile(out, 'judgment,row,title,url,folder\n');
  await writeFile(out.replace(/\.csv$/, '.key.json'), '{"schema": "other"}');
  await assert.rejects(runScore([out]), /is not a bookmark-genie\/blind-key@1 file/);
});

test('models that read alike keep their own reviews, costs and judgments', async () => {
  const LUNA = 'openai/gpt-6-luna';
  const LUNA_ELSEWHERE = 'perplexity/openai/gpt-6-luna';
  const dir = await makeRun({
    models: [LUNA_ELSEWHERE, LUNA],
    folderOf: (model, i) => `${model === LUNA ? 'Good' : 'Bad'} ${i % 10}`,
    spent: { [LUNA_ELSEWHERE]: 0.021, [LUNA]: 0.0002 },
  });
  const { out, key } = await makeList([dir]);
  const { arms } = JSON.parse(await readFile(key, 'utf8'));
  assert.deepEqual(arms.map(({ model, cost_usd: cost, answers }) => [model, cost, answers[0].folder]).sort(), [
    [LUNA, 0.0002, 'Good 0'],
    [LUNA_ELSEWHERE, 0.021, 'Bad 0'],
  ]);
  await judge(out, key, ({ folder }) => (folder.startsWith('Good') ? 'y' : 'n'));
  const { code, output } = await quietly(() => runScore([out]));
  assert.equal(code, 0);
  assert.match(output, /Decision: go on with openai\/gpt-6-luna/);
});

test('two files for one model of one run are refused, and so is naming a run twice', async () => {
  const dir = await makeRun();
  await assert.rejects(runBlind([dir, dir], { out: `${newPath('blind')}.csv` }), /are both reviews of anthropic\/claude-haiku-5-5 in the same run/);
  await writeFile(join(dir, 'review-copia.csv'), await readFile(join(dir, `review-${modelFileStem(HAIKU)}.csv`)));
  await assert.rejects(runBlind([dir], { out: `${newPath('blind')}.csv` }), /are both reviews of anthropic\/claude-haiku-5-5 in the same run/);
});

test('in the list, a charge for a call without reported usage does not decide the arm', async () => {
  const CHEAP = 'mistral/ministral-3b-2512';
  const DEAR = 'mistral/ministral-8b-2512';
  const dir = await makeRun({
    models: [DEAR, CHEAP],
    spent: { [CHEAP]: 0.0016, [DEAR]: 0.0015 },
    lost: { [CHEAP]: 0.0006 },
  });
  const { out, key } = await makeList([dir]);
  await judge(out, key, () => 'y');
  const { output } = await quietly(() => runScore([out]));
  assert.match(output, /Decision: go on with mistral\/ministral-3b-2512/);
});

test('in the list, answers from another model do not pass as the model asked for', async () => {
  const dir = await makeRun();
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.models[0].served = { 'otro-modelo': 300 };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const { out, key } = await makeList([dir]);
  await judge(out, key, () => 'y');
  const { code, output } = await quietly(() => runScore([out]));
  assert.equal(code, 1);
  assert.match(output, /Served as: otro-modelo/);
  assert.match(output, /Verdict: GRAY/);
});

test('in the list, bookmarks never attempted fail M0', async () => {
  const dir = await makeRun();
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.models[0].classified = 90;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const { out, key } = await makeList([dir]);
  await judge(out, key, () => 'y');
  const { code, output } = await quietly(() => runScore([out]));
  assert.equal(code, 1);
  assert.match(output, /not attempted=10/);
  assert.match(output, /Verdict: FAIL/);
});

test('a list saved in Windows-1252 still matches its key and keeps its accents', async () => {
  const dir = await makeRun({ folderOf: (_, i) => `C\u00f3digo ${i % 10}` });
  const { out, key } = await makeList([dir]);
  await judge(out, key, () => 's\u00ed');
  await writeFile(out, Buffer.from(await readFile(out, 'utf8'), 'latin1'));
  const { code, output } = await quietly(() => runScore([out]));
  assert.equal(code, 0);
  assert.match(output, /Accepted: 100 {2}Rejected: 0/);
});

test('a missing-bookmarks run still fails in the list', async () => {
  const dir = await makeRun();
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.models[0].unclassified = 1;
  manifest.models[0].unclassified_reasons = { missing: 1 };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const { out, key } = await makeList([dir]);
  await judge(out, key, () => 'y');
  const { code, output } = await quietly(() => runScore([out]));
  assert.equal(code, 1);
  assert.match(output, /Verdict: FAIL/);
});
