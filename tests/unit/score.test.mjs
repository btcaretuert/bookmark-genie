import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { toCsv } from '../../tools/lib/csv.mjs';
import { CATALOG } from '../../extension/core/models.js';
import { createManifest, updateManifest, writeManifest } from '../../tools/lib/manifest.mjs';
import {
  chooseArm,
  compareArms,
  decide,
  isAbstention,
  modelEntryOf,
  parseJudgment,
  runScore,
  summarizeArm,
  wilsonInterval,
} from '../../tools/lib/score.mjs';

const MODEL = 'anthropic/claude-haiku-5-5';
const COLUMNS = ['judgment', 'id', 'title', 'url', 'original_folder', 'assigned_folder', 'confidence'];
const NO_FACTS = { missing: 0, notAttempted: 0, unclassifiedShare: 0, complete: true, servedAs: [], unexpectedServed: [] };

let workDir;
let runCount = 0;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'bookmark-genie-score-'));
});
after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const idsOf = (count) => Array.from({ length: count }, (_, i) => `b${i}`);

/** Writes the manifest of a finished run and gives back its directory. */
async function makeRun({ models = [MODEL], reviewIds = idsOf(100), inputBytes = 'export', modelFields = {} } = {}) {
  runCount += 1;
  const dir = join(workDir, `run-${runCount}`);
  await mkdir(dir);
  let manifest = createManifest({
    startedAt: '2026-11-05T10:00:00.000Z',
    tool: { code_sha256: 'x', node: '26.13.0', anthropic_sdk: '1.5.0' },
    inputBytes,
    bookmarks: 500,
    sendable: 500,
    excluded: {},
    params: { seed: 1, sample: 300, review: reviewIds.length, language: 'Spanish', max_usd: 1 },
    models: models.map((ref) => ({ ref, prompts: { classify: null, taxonomy: null } })),
    prices: Object.fromEntries(models.map((ref) => [ref, { input: 1, output: 1 }])),
    taxonomySampleIds: [],
    sampleIds: reviewIds,
    reviewIds,
  });
  for (const requested of models) {
    manifest = updateManifest(manifest, { model: { requested, status: 'complete', classified: 300, unclassified: 0, unclassified_reasons: {}, spent_usd: 0.01 } });
  }
  manifest = { ...manifest, models: manifest.models.map((entry) => ({ ...entry, ...modelFields[entry.requested] })) };
  await writeManifest(dir, manifest);
  return dir;
}

/** `judge(i)` gives the judgment of row i; `folder(i)` and `confidence(i)` its other cells. */
function reviewCsv(ids, { judge = () => 'y', folder = (i) => `Folder ${i % 10}`, confidence = () => 'high', original = () => 'Old' } = {}) {
  return toCsv(COLUMNS, ids.map((id, i) => [judge(i), id, `Title ${i}`, `example.com/${i}`, original(i), folder(i), confidence(i)]));
}

async function writeReview(dir, csv, name = 'review-anthropic__claude-haiku-5-5.csv') {
  const path = join(dir, name);
  await writeFile(path, csv);
  return path;
}

/** Runs `runScore` and gives back its exit code and what it printed. */
async function scored(paths) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const code = await runScore(paths);
    return { code, output: lines.join('\n') };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

const accepted = (count) => (i) => (i < count ? 'y' : 'n');

test('the Wilson interval matches the published values', () => {
  const close = ([low, high], [expectedLow, expectedHigh]) => {
    assert.ok(Math.abs(low - expectedLow) < 0.0006, `${low}`);
    assert.ok(Math.abs(high - expectedHigh) < 0.0006, `${high}`);
  };
  close(wilsonInterval(85, 100), [0.767, 0.907]);
  close(wilsonInterval(90, 100), [0.826, 0.945]);
  close(wilsonInterval(80, 100), [0.711, 0.867]);
  close(wilsonInterval(170, 200), [0.794, 0.893]);
});

test('the Wilson interval stays between 0 and 1, also with nothing to go on', () => {
  assert.deepEqual(wilsonInterval(0, 0), [0, 1]);
  const [lowAll, highAll] = wilsonInterval(100, 100);
  assert.ok(lowAll > 0.96 && lowAll < 1);
  assert.ok(highAll > 0.999999 && highAll <= 1);
  const [lowNone, highNone] = wilsonInterval(0, 100);
  assert.ok(lowNone >= 0 && lowNone < 1e-9);
  assert.ok(highNone > 0 && highNone < 0.04);
});

test('judgments are read in either language, ignoring case and spacing', () => {
  for (const value of ['y', 'Y', 'yes', ' s ', 'si', 'SÍ', 'si\u0301']) assert.equal(parseJudgment(value), true, value);
  for (const value of ['n', 'No', ' NO ']) assert.equal(parseJudgment(value), false, value);
  for (const value of ['', '?', 'maybe', 'nope', undefined]) assert.equal(parseJudgment(value), null, String(value));
});

test('only the two reserved names count as abstentions', () => {
  assert.equal(isAbstention('__unsorted__'), true);
  assert.equal(isAbstention('(unclassified)'), true);
  assert.equal(isAbstention('Cocina'), false);
  assert.equal(isAbstention(''), false);
});

const summaryOf = (acceptedCount, total) => ({
  total,
  accepted: acceptedCount,
  rejected: total - acceptedCount,
  pending: 0,
  abstained: 0,
  largestFolderShare: 0.1,
});

test('the rule has a gray zone: 85 or more passes, 77 or less fails', () => {
  const verdict = (acceptedCount) => decide(summaryOf(acceptedCount, 100), NO_FACTS).verdict;
  assert.equal(verdict(100), 'PASS');
  assert.equal(verdict(85), 'PASS');
  assert.equal(verdict(84), 'GRAY');
  assert.equal(verdict(78), 'GRAY');
  assert.equal(verdict(77), 'FAIL');
  assert.equal(verdict(0), 'FAIL');
  assert.deepEqual(decide(summaryOf(85, 100), NO_FACTS).reasons, []);
});

test('the gray zone ends where the interval no longer reaches the target', () => {
  assert.ok(Math.abs(wilsonInterval(78, 100)[1] - 0.85) < 0.0001);
  assert.ok(wilsonInterval(77, 100)[1] < 0.843);
});

test('the rule works in proportion above 100 rows', () => {
  assert.equal(decide(summaryOf(170, 200), NO_FACTS).verdict, 'PASS');
  assert.equal(decide(summaryOf(169, 200), NO_FACTS).verdict, 'GRAY');
  assert.equal(decide(summaryOf(155, 200), NO_FACTS).verdict, 'FAIL');
});

test('fewer than 100 rows never decide, either way', () => {
  for (const summary of [summaryOf(99, 99), summaryOf(1, 1), summaryOf(0, 99), summaryOf(0, 0)]) {
    const { verdict, reasons } = decide(summary, NO_FACTS);
    assert.equal(verdict, 'GRAY');
    assert.match(reasons[0], /too few/);
  }
});

test('a bookmark still missing after retrying fails M0, whatever the acceptance', () => {
  const { verdict, reasons } = decide(summaryOf(95, 100), { ...NO_FACTS, missing: 1, unclassifiedShare: 0.003 });
  assert.equal(verdict, 'FAIL');
  assert.match(reasons.at(-1), /1 bookmarks stayed missing/);
  assert.equal(decide(summaryOf(5, 50), { ...NO_FACTS, missing: 1 }).verdict, 'FAIL');
});

test('too much unclassified keeps a run out of a pass, at more than 2 percent', () => {
  assert.equal(decide(summaryOf(90, 100), { ...NO_FACTS, unclassifiedShare: 0.02 }).verdict, 'PASS');
  const { verdict, reasons } = decide(summaryOf(90, 100), { ...NO_FACTS, unclassifiedShare: 0.021 });
  assert.equal(verdict, 'GRAY');
  assert.match(reasons[0], /unclassified/);
  assert.equal(decide(summaryOf(70, 100), { ...NO_FACTS, unclassifiedShare: 0.5 }).verdict, 'FAIL');
});

test('one folder that takes almost everything cannot pass, at more than 35 percent', () => {
  const summary = (largestFolderShare) => ({ ...summaryOf(95, 100), largestFolderShare });
  assert.equal(decide(summary(0.35), NO_FACTS).verdict, 'PASS');
  const { verdict, reasons } = decide(summary(0.36), NO_FACTS);
  assert.equal(verdict, 'GRAY');
  assert.match(reasons[0], /one folder holds 36\.0 %/);
});

test('the summary separates precision, coverage, confidence and origin', () => {
  const answer = (folder, confidence, inFolder, isAccepted) => ({ id: 'x', folder, confidence, inFolder, accepted: isAccepted });
  const summary = summarizeArm([
    answer('A', 'high', true, true),
    answer('A', 'high', false, false),
    answer('B', 'low', true, true),
    answer('B', 'low', false, null),
    answer('A', 'high', false, true),
    answer('__unsorted__', 'high', true, false),
    answer('(unclassified)', '', false, true),
  ]);
  assert.deepEqual(summary, {
    total: 7,
    accepted: 3,
    rejected: 1,
    pending: 1,
    abstained: 2,
    high: { accepted: 2, total: 3 },
    low: { accepted: 1, total: 2 },
    inFolder: { accepted: 2, total: 2 },
    loose: { accepted: 1, total: 3 },
    largestFolderShare: 3 / 5,
  });
});

test('an arm with no folders at all has no largest folder', () => {
  const summary = summarizeArm([{ id: 'x', folder: '__unsorted__', confidence: 'high', inFolder: true, accepted: false }]);
  assert.equal(summary.largestFolderShare, 0);
  assert.equal(summary.accepted, 0);
});

test('comparing arms counts only the rows they disagree on, also with abstentions', () => {
  const arm = (values, folder) => values.map((value, i) => ({ id: `b${i}`, accepted: value, folder: folder(i) }));
  const first = arm([true, true, false, false, null], () => 'A');
  const second = arm([true, false, true, false, false], (i) => (i < 3 ? 'A' : 'B'));
  assert.deepEqual(compareArms(first, second), { onlyFirst: 1, onlySecond: 1, net: 0, sameFolder: 3 });
  assert.deepEqual(compareArms(first, []), { onlyFirst: 2, onlySecond: 0, net: 2, sameFolder: 0 });
});

const armWith = (label, costUsd, verdict, acceptedRows) => ({
  label,
  costUsd,
  verdict,
  facts: NO_FACTS,
  answers: idsOf(100).map((id, i) => ({ id, folder: 'A', confidence: 'high', inFolder: true, accepted: i < acceptedRows })),
});

test('the cheapest passing arm wins, unless a dearer one beats it by 10 net rows', () => {
  const cheap = armWith('cheap', 0.01, 'PASS', 85);
  assert.equal(chooseArm([armWith('dear', 1, 'PASS', 94), cheap]).label, 'cheap');
  assert.equal(chooseArm([armWith('dear', 1, 'PASS', 95), cheap]).label, 'dear');
  assert.equal(chooseArm([armWith('dear', 1, 'PASS', 95), armWith('gray', 0, 'GRAY', 84)]).label, 'dear');
  assert.equal(chooseArm([armWith('a', 0, 'GRAY', 84), armWith('b', 0, 'FAIL', 50)]), null);
  assert.equal(chooseArm([]), null);
});

test('a full review at the target passes, and says how far the result can be trusted', async () => {
  const dir = await makeRun();
  const { code, output } = await scored([await writeReview(dir, reviewCsv(idsOf(100), { judge: accepted(85) }))]);
  assert.equal(code, 0);
  assert.match(output, /Accepted: 85 {2}Rejected: 15 {2}Abstained: 0 {2}Pending: 0/);
  assert.match(output, /Acceptance: 85\.0 % \[76\.7 %, 90\.7 %\] of 100 rows/);
  assert.match(output, /Verdict: PASS/);
  assert.match(output, new RegExp(`Decision: go on with ${MODEL}`));
});

test('just under the target is gray and exits 1; far under it fails', async () => {
  const dir = await makeRun();
  let result = await scored([await writeReview(dir, reviewCsv(idsOf(100), { judge: accepted(84) }))]);
  assert.equal(result.code, 1);
  assert.match(result.output, /Verdict: GRAY/);
  assert.match(result.output, /Decision: not yet/);

  const other = await makeRun();
  result = await scored([await writeReview(other, reviewCsv(idsOf(100), { judge: accepted(77) }))]);
  assert.equal(result.code, 1);
  assert.match(result.output, /Verdict: FAIL/);
  assert.match(result.output, /Decision: do not go on/);
});

test('the output has precision, coverage, confidence and origin', async () => {
  const dir = await makeRun();
  const path = await writeReview(
    dir,
    reviewCsv(idsOf(100), {
      judge: accepted(80),
      folder: (i) => (i >= 90 ? '__unsorted__' : `Folder ${i % 10}`),
      confidence: (i) => (i < 60 ? 'high' : 'low'),
      original: (i) => (i < 50 ? 'Old' : ''),
    }),
  );
  const { output } = await scored([path]);
  assert.match(output, /Accepted: 80 {2}Rejected: 10 {2}Abstained: 10/);
  assert.match(output, /Precision: 80\/90 \(88\.9 %\) of the rows with a folder\. Coverage: 90\.0 %/);
  assert.match(output, /By confidence: high 60\/60 \(100\.0 %\), low 20\/30 \(66\.7 %\)/);
  assert.match(output, /By origin: already in a folder 50\/50 \(100\.0 %\), loose 30\/40 \(75\.0 %\)/);
});

test('rows without a folder need no judgment and never count as accepted', async () => {
  const dir = await makeRun();
  const path = await writeReview(
    dir,
    reviewCsv(idsOf(100), {
      // A hundred y, but ten of them on rows with no folder to accept.
      judge: (i) => (i < 5 ? 'y' : i < 10 ? '' : 'y'),
      folder: (i) => (i < 5 ? '(unclassified)' : i < 10 ? '__unsorted__' : `Folder ${i % 10}`),
    }),
  );
  const { code, output } = await scored([path]);
  assert.equal(code, 0);
  assert.match(output, /Accepted: 90 {2}Rejected: 0 {2}Abstained: 10 {2}Pending: 0/);
  assert.match(output, /Acceptance: 90\.0 %/);
  assert.match(output, /5 rows without a folder were marked as accepted/);
});

test('a model that leaves too many rows without a folder cannot reach the target', async () => {
  const dir = await makeRun();
  const path = await writeReview(
    dir,
    reviewCsv(idsOf(100), { folder: (i) => (i < 16 ? '__unsorted__' : `Folder ${i % 10}`) }),
  );
  const { code, output } = await scored([path]);
  assert.equal(code, 1);
  assert.match(output, /Acceptance: 84\.0 %/);
  assert.match(output, /Precision: 84\/84/);
});

test('a taxonomy that puts everything in one folder does not pass', async () => {
  const dir = await makeRun();
  const { code, output } = await scored([await writeReview(dir, reviewCsv(idsOf(100), { folder: () => 'Programación' }))]);
  assert.equal(code, 1);
  assert.match(output, /Acceptance: 100\.0 %/);
  assert.match(output, /Largest folder: 100\.0 %/);
  assert.match(output, /Verdict: GRAY/);
  assert.match(output, /one folder holds 100\.0 %/);
});

test('a model with missing bookmarks fails, as the manifest says', async () => {
  const dir = await makeRun({ modelFields: { [MODEL]: { classified: 299, unclassified: 1, unclassified_reasons: { missing: 1 } } } });
  const { code, output } = await scored([await writeReview(dir, reviewCsv(idsOf(100)))]);
  assert.equal(code, 1);
  assert.match(output, /Verdict: FAIL/);
  assert.match(output, /1 bookmarks stayed missing after retrying/);
});

test('a few refusals are not a failure of completeness', async () => {
  const dir = await makeRun({ reviewIds: idsOf(100), modelFields: { [MODEL]: { classified: 98, unclassified: 2, unclassified_reasons: { refusal: 2 } } } });
  const { code, output } = await scored([await writeReview(dir, reviewCsv(idsOf(100)))]);
  assert.equal(code, 0);
  assert.match(output, /M0 completeness: PASS \(missing=0, not attempted=0\)/);
  assert.match(output, /Verdict: PASS/);
});

test('bookmarks never attempted fail M0, as the report says', async () => {
  const dir = await makeRun({ reviewIds: idsOf(100), modelFields: { [MODEL]: { classified: 90, unclassified: 0, unclassified_reasons: {} } } });
  const { code, output } = await scored([await writeReview(dir, reviewCsv(idsOf(100)))]);
  assert.equal(code, 1);
  assert.match(output, /M0 completeness: FAIL \(missing=0, not attempted=10\)/);
  assert.match(output, /10 bookmarks were never attempted/);
  assert.match(output, /Verdict: FAIL/);
});

test('answers from another model do not pass as the model asked for', async () => {
  const LUNA_ID = 'openai/gpt-6-luna';
  const dir = await makeRun({ models: [LUNA_ID], modelFields: { [LUNA_ID]: { served: { 'gpt-4o-mini-otro-modelo': 300 } } } });
  const { code, output } = await scored([await writeReview(dir, reviewCsv(idsOf(100)))]);
  assert.equal(code, 1);
  assert.match(output, /Served as: gpt-4o-mini-otro-modelo/);
  assert.match(output, /the answers came from gpt-4o-mini-otro-modelo, not from the model asked for/);
  assert.match(output, /Verdict: GRAY/);
  assert.doesNotMatch(output, /Decision: go on/);
});

test('one answer from another model is enough to say so', async () => {
  const LUNA_ID = 'openai/gpt-6-luna';
  const dir = await makeRun({ models: [LUNA_ID], modelFields: { [LUNA_ID]: { served: { 'gpt-6-luna': 299, otro: 1 } } } });
  const { output } = await scored([await writeReview(dir, reviewCsv(idsOf(100)))]);
  assert.match(output, /Served as: otro\n/);
  assert.match(output, /Verdict: GRAY/);
});

test('a different model that only answered the folders also lowers the verdict', async () => {
  const LUNA_ID = 'openai/gpt-6-luna';
  const dir = await makeRun({
    models: [LUNA_ID],
    modelFields: { [LUNA_ID]: { served: { 'gpt-6-luna': 300 }, answered_by: { 'gpt-6-luna': 6, 'claude-fable-5-1': 1 } } },
  });
  const { output } = await scored([await writeReview(dir, reviewCsv(idsOf(100)))]);
  assert.match(output, /Served as: claude-fable-5-1\n/);
  assert.match(output, /Verdict: GRAY/);
});

test('a review is labelled with its effort and its run, like a blind list', async () => {
  const LUNA_ID = 'openai/gpt-6-luna';
  const dir = await makeRun({ models: [LUNA_ID], modelFields: { [LUNA_ID]: { effort: 'high' } } });
  const { output } = await scored([await writeReview(dir, reviewCsv(idsOf(100)))]);
  assert.match(output, new RegExp(`Decision: go on with ${LUNA_ID} high \\[[^\\]]+\\]`));
});

test('the id asked for, with or without a date, passes', async () => {
  const LUNA_ID = 'openai/gpt-6-luna';
  for (const [served, shown] of [['gpt-6-luna', false], ['gpt-6-luna-2026-10-01', true], ['gpt-6-luna-20261001', true]]) {
    const dir = await makeRun({ models: [LUNA_ID], modelFields: { [LUNA_ID]: { served: { [served]: 300 } } } });
    const { code, output } = await scored([await writeReview(dir, reviewCsv(idsOf(100)))]);
    assert.equal(code, 0, served);
    assert.equal(output.includes('Served as:'), shown, served);
    if (shown) assert.ok(output.includes(`Served as: ${served}`));
  }
});

test('a moving alias shows what it served, without lowering the verdict', async () => {
  const ALIAS = CATALOG.find((entry) => entry.idStability === 'moving-alias').ref;
  const dir = await makeRun({ models: [ALIAS], modelFields: { [ALIAS]: { served: { 'a-version-of-today': 300 } } } });
  const { code, output } = await scored([await writeReview(dir, reviewCsv(idsOf(100)))]);
  assert.equal(code, 0);
  assert.match(output, /Served as: a-version-of-today/);
  assert.match(output, /Verdict: PASS/);
});

test('a served id is made safe before it reaches the terminal', async () => {
  const LUNA_ID = 'openai/gpt-6-luna';
  const dir = await makeRun({ models: [LUNA_ID], modelFields: { [LUNA_ID]: { served: { 'x\u001b]0;pwned\u0007': 300 } } } });
  const { output } = await scored([await writeReview(dir, reviewCsv(idsOf(100)))]);
  assert.ok(!output.includes('\u001b'));
});

test('a review saved in Windows-1252 keeps its accents', async () => {
  const dir = await makeRun();
  const csv = reviewCsv(idsOf(100), { judge: () => 's\u00ed' });
  const path = await writeReview(dir, Buffer.from(csv, 'latin1'));
  const { code, output } = await scored([path]);
  assert.equal(code, 0);
  assert.match(output, /Accepted: 100 {2}Rejected: 0 {2}Abstained: 0 {2}Pending: 0/);
});

test('an incomplete review is not decided', async () => {
  const dir = await makeRun();
  const { code, output } = await scored([await writeReview(dir, reviewCsv(idsOf(100), { judge: (i) => (i < 50 ? 'y' : '') }))]);
  assert.equal(code, 1);
  assert.match(output, /Pending: 50/);
  assert.match(output, /Incomplete/);
  assert.doesNotMatch(output, /Verdict|Decision/);
});

test('an unrecognized judgment counts as pending', async () => {
  const dir = await makeRun();
  const { code, output } = await scored([await writeReview(dir, reviewCsv(idsOf(100), { judge: (i) => (i === 0 ? 'quizás' : 'y') }))]);
  assert.equal(code, 1);
  assert.match(output, /Pending: 1/);
});

test('an empty review says that nothing was judged', async () => {
  const dir = await makeRun();
  const { code, output } = await scored([await writeReview(dir, reviewCsv(idsOf(100), { judge: () => '' }))]);
  assert.equal(code, 1);
  assert.match(output, /Nothing judged yet/);
  assert.doesNotMatch(output, /Acceptance/);
});

test('sorting the rows in a spreadsheet changes nothing', async () => {
  const dir = await makeRun();
  const ids = idsOf(100).toReversed();
  const { code, output } = await scored([await writeReview(dir, reviewCsv(ids, { judge: accepted(90) }))]);
  assert.equal(code, 0);
  assert.match(output, /Accepted: 90/);
});

test('a CSV saved by a spreadsheet, with BOM and semicolons, is read', async () => {
  const dir = await makeRun();
  const csv = reviewCsv(idsOf(100), { judge: accepted(90) }).replaceAll('","', '";"');
  const { code, output } = await scored([await writeReview(dir, `\uFEFF${csv.replaceAll('\n', '\r\n')}`)]);
  assert.equal(code, 0);
  assert.match(output, /Accepted: 90/);
});

test('deleting the rejected rows does not raise the score: the review no longer matches its run', async () => {
  const dir = await makeRun();
  const path = await writeReview(dir, reviewCsv(idsOf(80)));
  await assert.rejects(runScore([path]), /does not hold the bookmarks of its run: it has 80 rows and the run reviewed 100/);
});

test('one judged row is not a review', async () => {
  const dir = await makeRun();
  await assert.rejects(runScore([await writeReview(dir, reviewCsv(['b0']))]), /does not hold the bookmarks/);
});

test('a repeated row does not fit either', async () => {
  const dir = await makeRun();
  const ids = [...idsOf(99), 'b0'];
  await assert.rejects(runScore([await writeReview(dir, reviewCsv(ids))]), /does not hold the bookmarks/);
});

test('a review from another run does not fit', async () => {
  const dir = await makeRun({ reviewIds: idsOf(100).map((id) => `${id}0`) });
  await assert.rejects(runScore([await writeReview(dir, reviewCsv(idsOf(100)))]), /does not hold the bookmarks/);
});

test('a foreign file with only a judgment column is rejected', async () => {
  const dir = await makeRun();
  const path = await writeReview(dir, 'judgment\ny\ny\n');
  await assert.rejects(runScore([path]), /has no column id, original_folder, assigned_folder, confidence/);
});

test('without a manifest next to it there is no score', async () => {
  const dir = join(workDir, 'no-manifest');
  await mkdir(dir);
  const path = await writeReview(dir, reviewCsv(idsOf(100)));
  await assert.rejects(runScore([path]), /No manifest\.json next to .*: a review can only be scored/);
});

test('a manifest of another kind is rejected', async () => {
  const dir = join(workDir, 'bad-manifest');
  await mkdir(dir);
  await writeFile(join(dir, 'manifest.json'), '{"schema": "other"}');
  await assert.rejects(runScore([await writeReview(dir, reviewCsv(idsOf(100)))]), /is not a bookmark-genie\/run-manifest@1 file/);
});

test('a model that did not finish cannot be scored', async () => {
  const dir = await makeRun({ modelFields: { [MODEL]: { status: 'stopped' } } });
  await assert.rejects(runScore([await writeReview(dir, reviewCsv(idsOf(100)))]), /did not finish in this run \(status: stopped\)/);
});

test('with several models, the file name says which one, whatever separator it uses', async () => {
  const OPUS = 'anthropic/claude-opus-5-5';
  const dir = await makeRun({
    models: [MODEL, OPUS],
    modelFields: { [OPUS]: { classified: 299, unclassified: 1, unclassified_reasons: { missing: 1 } } },
  });
  for (const name of ['review-anthropic__claude-opus-5-5.csv', 'review-anthropic-claude-opus-5-5.csv', 'review-claude-opus-5-5.csv']) {
    const { output } = await scored([await writeReview(dir, reviewCsv(idsOf(100)), name)]);
    assert.match(output, new RegExp(OPUS));
    assert.match(output, /Verdict: FAIL/);
  }
  const { output } = await scored([await writeReview(dir, reviewCsv(idsOf(100)), 'review-anthropic__claude-haiku-5-5.csv')]);
  assert.match(output, new RegExp(MODEL));
  assert.match(output, /Verdict: PASS/);

  await assert.rejects(runScore([await writeReview(dir, reviewCsv(idsOf(100)), 'review-otro.csv')]), /does not name a model of its run/);
});

test('with one model, the file can have any name, so it can hide the model', async () => {
  const dir = await makeRun();
  const { code } = await scored([await writeReview(dir, reviewCsv(idsOf(100)), 'lista-a.csv')]);
  assert.equal(code, 0);
});

test('two reviews are compared on the same bookmarks and the rule picks one', async () => {
  const OPUS = 'anthropic/claude-opus-5-5';
  const dirA = await makeRun({ modelFields: { [MODEL]: { spent_usd: 0.01 } } });
  const dirB = await makeRun({ models: [OPUS], modelFields: { [OPUS]: { spent_usd: 0.5 } } });
  const a = await writeReview(dirA, reviewCsv(idsOf(100), { judge: accepted(85) }));
  const b = await writeReview(dirB, reviewCsv(idsOf(100), { judge: accepted(96) }));
  const { code, output } = await scored([a, b]);
  assert.equal(code, 0);
  assert.match(output, new RegExp(`${MODEL}[^\\n]* vs ${OPUS}[^\\n]*: only the first 0, only the second 11, net -11 rows, same folder in 100 of 100`));
  assert.match(output, new RegExp(`Decision: go on with ${OPUS}`));
});

test('a row with no folder marked as accepted does not change a comparison either', async () => {
  const OPUS = 'anthropic/claude-opus-5-5';
  const a = await writeReview(await makeRun(), reviewCsv(idsOf(100), { judge: accepted(85), folder: (i) => (i === 0 ? '__unsorted__' : `Folder ${i % 10}`) }));
  const b = await writeReview(await makeRun({ models: [OPUS] }), reviewCsv(idsOf(100), { judge: (i) => (i === 0 ? 'n' : accepted(85)(i)) }));
  const { output } = await scored([a, b]);
  assert.match(output, /only the first 0, only the second 0, net 0 rows/);
});

test('reviews of other bookmarks, or of another export, are not compared', async () => {
  const a = await writeReview(await makeRun(), reviewCsv(idsOf(100)));
  const shifted = idsOf(101).slice(1);
  const b = await writeReview(await makeRun({ reviewIds: shifted }), reviewCsv(shifted));
  await assert.rejects(runScore([a, b]), /not about the same bookmarks/);

  const c = await writeReview(await makeRun({ inputBytes: 'another export' }), reviewCsv(idsOf(100)));
  await assert.rejects(runScore([a, c]), /not about the same bookmarks/);
});

const LUNA = 'openai/gpt-6-luna';
const LUNA_ELSEWHERE = 'perplexity/openai/gpt-6-luna';

test('the name the run gave a review decides its model, even when another model reads alike', () => {
  for (const models of [[LUNA_ELSEWHERE, LUNA], [LUNA, LUNA_ELSEWHERE]]) {
    const manifest = { models: models.map((requested) => ({ requested })) };
    assert.equal(modelEntryOf('/run/review-openai__gpt-6-luna.csv', manifest).requested, LUNA);
    assert.equal(modelEntryOf('/run/review-perplexity__openai__gpt-6-luna.csv', manifest).requested, LUNA_ELSEWHERE);
  }
});

test('a renamed review only resolves if it can be one model', () => {
  const manifest = { models: [{ requested: LUNA_ELSEWHERE }, { requested: LUNA }] };
  assert.equal(modelEntryOf('/run/review-perplexity-openai-gpt-6-luna.csv', manifest).requested, LUNA_ELSEWHERE);
  assert.throws(() => modelEntryOf('/run/review-openai-gpt-6-luna.csv', manifest), /could be any of perplexity\/openai\/gpt-6-luna, openai\/gpt-6-luna/);
  assert.throws(() => modelEntryOf('/run/review-otro.csv', manifest), /does not name a model of its run/);
});

test('each review counts for its own model: the rejected one is not recommended', async () => {
  const dir = await makeRun({
    models: [LUNA_ELSEWHERE, LUNA],
    modelFields: { [LUNA_ELSEWHERE]: { spent_usd: 0.021 }, [LUNA]: { spent_usd: 0.0002 } },
  });
  const accepted = await writeReview(dir, reviewCsv(idsOf(100)), 'review-openai__gpt-6-luna.csv');
  const rejected = await writeReview(dir, reviewCsv(idsOf(100), { judge: () => 'n' }), 'review-perplexity__openai__gpt-6-luna.csv');
  const { code, output } = await scored([accepted, rejected]);
  assert.equal(code, 0);
  assert.match(output, new RegExp(`${LUNA}[^\\n]* vs ${LUNA_ELSEWHERE}[^\\n]*: only the first 100, only the second 0`));
  assert.match(output, new RegExp(`Decision: go on with ${LUNA} `));
});

test('two files for one model of one run are not two arms', async () => {
  const dir = await makeRun();
  const review = await writeReview(dir, reviewCsv(idsOf(100)));
  await assert.rejects(runScore([review, review]), /are both reviews of anthropic\/claude-haiku-5-5 in the same run/);
  const renamed = await writeReview(dir, reviewCsv(idsOf(100), { judge: () => 'n' }), 'lista-a.csv');
  await assert.rejects(runScore([review, renamed]), /are both reviews of anthropic\/claude-haiku-5-5 in the same run/);
});

test('the same model in two runs is two arms: another taxonomy or effort is another result', async () => {
  const first = await writeReview(await makeRun(), reviewCsv(idsOf(100), { judge: accepted(90) }));
  const second = await writeReview(await makeRun(), reviewCsv(idsOf(100), { judge: accepted(95) }));
  const { code } = await scored([first, second]);
  assert.equal(code, 0);
});

test('a charge for a call without reported usage does not make a model look dearer', async () => {
  const CHEAP = 'mistral/ministral-3b-2512';
  const DEAR = 'mistral/ministral-8b-2512';
  const dir = await makeRun({
    models: [CHEAP, DEAR],
    modelFields: { [CHEAP]: { spent_usd: 0.0016, lost_usd: 0.0006 }, [DEAR]: { spent_usd: 0.0015, lost_usd: 0 } },
  });
  const cheap = await writeReview(dir, reviewCsv(idsOf(100)), 'review-mistral__ministral-3b-2512.csv');
  const dear = await writeReview(dir, reviewCsv(idsOf(100)), 'review-mistral__ministral-8b-2512.csv');
  const { output } = await scored([dear, cheap]);
  assert.match(output, new RegExp(`Decision: go on with ${CHEAP} `));
});

test('a run written before lost_usd existed still has a cost', async () => {
  const CHEAP = 'mistral/ministral-3b-2512';
  const DEAR = 'mistral/ministral-8b-2512';
  const dir = await makeRun({ models: [CHEAP, DEAR], modelFields: { [CHEAP]: { spent_usd: 0.001, lost_usd: undefined }, [DEAR]: { spent_usd: 0.002, lost_usd: undefined } } });
  const cheap = await writeReview(dir, reviewCsv(idsOf(100)), 'review-mistral__ministral-3b-2512.csv');
  const dear = await writeReview(dir, reviewCsv(idsOf(100)), 'review-mistral__ministral-8b-2512.csv');
  const { output } = await scored([dear, cheap]);
  assert.match(output, new RegExp(`Decision: go on with ${CHEAP} `));
});
