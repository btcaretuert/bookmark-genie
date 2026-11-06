import { access, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { UNCLASSIFIED, UNSORTED } from '../../extension/core/classify.js';
import { isExpectedServedModel } from '../../extension/core/models.js';
import { parseCsv, readText } from './csv.mjs';
import { assessCompleteness, hashIds, MANIFEST_FILE, MAX_UNCLASSIFIED_SHARE, modelFileStem, readManifest } from './manifest.mjs';
import { formatPercent } from './report.mjs';
import { safeInline } from './safe-text.mjs';

const ACCEPTANCE_TARGET = 0.85;
/** Under this, even the top of the 95 % interval misses the target: 78 of 100 reaches 85.0 %, 77 only 84.2 %. */
const GRAY_ZONE_FLOOR = 0.78;
/** What milestone M0 decides on. With fewer rows, the interval is too wide to pass or fail anything. */
const MIN_ROWS_TO_DECIDE = 100;
/**
 * A dearer arm only wins by this many rows net. With 100 rows and a fifth of them discordant,
 * this needs about what an exact McNemar test needs, and two equal arms reach it 1.7 % of the time.
 */
const NET_ROWS_TO_PAY_MORE = 10;
/** Judging one row at a time does not penalize a huge folder, so this is checked apart. */
const MAX_LARGEST_FOLDER_SHARE = 0.35;
const WILSON_Z_95 = 1.96;

const ACCEPT_VALUES = new Set(['y', 'yes', 's', 'si', 'sí']);
const REJECT_VALUES = new Set(['n', 'no']);
const ABSTENTIONS = new Set([UNSORTED, UNCLASSIFIED]);

const REVIEW_COLUMNS = ['judgment', 'id', 'original_folder', 'assigned_folder', 'confidence'];
export const BLIND_COLUMNS = ['judgment', 'row', 'title', 'url', 'folder'];
export const BLIND_KEY_SCHEMA = 'bookmark-genie/blind-key@1';

/**
 * @typedef {import('./manifest.mjs').Manifest} Manifest
 * @typedef {import('./manifest.mjs').ModelEntry} ModelEntry
 * @typedef {'PASS' | 'GRAY' | 'FAIL'} Verdict
 * @typedef {{id: string, folder: string, confidence: string, inFolder: boolean, accepted: boolean | null}} Answer
 * @typedef {{accepted: number, total: number}} Slice
 * @typedef {{
 *   total: number,
 *   accepted: number,
 *   rejected: number,
 *   pending: number,
 *   abstained: number,
 *   high: Slice,
 *   low: Slice,
 *   inFolder: Slice,
 *   loose: Slice,
 *   largestFolderShare: number,
 * }} ArmSummary
 * @typedef {ReturnType<typeof assessCompleteness> & {servedAs: string[], unexpectedServed: string[]}} RunFacts
 * @typedef {{label: string, costUsd: number, facts: RunFacts, answers: Answer[]}} Arm
 */

/**
 * What can be said about a true rate from `successes` of `total`. Unlike the normal
 * approximation, it behaves near 100 % and with few rows.
 *
 * @param {number} successes
 * @param {number} total
 * @returns {[number, number]}
 */
export function wilsonInterval(successes, total) {
  if (total === 0) return [0, 1];
  const z = WILSON_Z_95;
  const rate = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (rate + (z * z) / (2 * total)) / denominator;
  const half = (z * Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * @param {string | undefined} value
 * @returns {boolean | null} null when it is not a judgment
 */
export function parseJudgment(value) {
  const text = (value ?? '').normalize('NFC').trim().toLowerCase();
  if (ACCEPT_VALUES.has(text)) return true;
  return REJECT_VALUES.has(text) ? false : null;
}

/**
 * The model left the bookmark without a folder. There is nothing to judge, and nothing got
 * sorted: it counts as not accepted, whatever the row says.
 *
 * @param {string} folder
 */
export function isAbstention(folder) {
  return ABSTENTIONS.has(folder);
}

/**
 * @param {Answer[]} answers
 * @returns {ArmSummary}
 */
export function summarizeArm(answers) {
  const assigned = answers.filter((answer) => !isAbstention(answer.folder));
  /** @param {(answer: Answer) => boolean} belongs */
  const slice = (belongs) => {
    const subset = assigned.filter(belongs);
    return { accepted: subset.filter((answer) => answer.accepted === true).length, total: subset.length };
  };
  /** @type {Map<string, number>} */
  const perFolder = new Map();
  for (const { folder } of assigned) perFolder.set(folder, (perFolder.get(folder) ?? 0) + 1);

  const accepted = slice(() => true).accepted;
  const pending = assigned.filter((answer) => answer.accepted === null).length;
  return {
    total: answers.length,
    accepted,
    rejected: assigned.length - accepted - pending,
    pending,
    abstained: answers.length - assigned.length,
    high: slice((answer) => answer.confidence === 'high'),
    low: slice((answer) => answer.confidence === 'low'),
    inFolder: slice((answer) => answer.inFolder),
    loose: slice((answer) => !answer.inFolder),
    largestFolderShare: assigned.length === 0 ? 0 : Math.max(...perFolder.values()) / assigned.length,
  };
}

/**
 * The decision rule of M0. A percentage from 100 rows has an interval of about 14 points, so
 * only a clear result passes or fails; the rest is a gray zone that asks for more evidence.
 *
 * @param {ArmSummary} summary
 * @param {RunFacts} facts what the run knows beyond the reviewed rows
 * @returns {{verdict: Verdict, reasons: string[]}}
 */
export function decide(summary, { missing, notAttempted, unclassifiedShare, unexpectedServed }) {
  const rate = summary.total === 0 ? 0 : summary.accepted / summary.total;
  /** @type {Verdict} */
  let verdict = rate >= ACCEPTANCE_TARGET ? 'PASS' : rate >= GRAY_ZONE_FLOOR ? 'GRAY' : 'FAIL';
  const reasons = [];

  if (unclassifiedShare > MAX_UNCLASSIFIED_SHARE) {
    reasons.push(`${formatPercent(unclassifiedShare)} of the run stayed unclassified, over the ${formatPercent(MAX_UNCLASSIFIED_SHARE)} allowed`);
    if (verdict === 'PASS') verdict = 'GRAY';
  }
  if (unexpectedServed.length > 0) {
    reasons.push(`the answers came from ${formatServed(unexpectedServed)}, not from the model asked for, so this does not measure it`);
    if (verdict === 'PASS') verdict = 'GRAY';
  }
  if (summary.largestFolderShare > MAX_LARGEST_FOLDER_SHARE) {
    reasons.push(`one folder holds ${formatPercent(summary.largestFolderShare)} of these rows, over the ${formatPercent(MAX_LARGEST_FOLDER_SHARE)} allowed: acceptance says little about a folder that takes everything`);
    if (verdict === 'PASS') verdict = 'GRAY';
  }
  if (summary.total < MIN_ROWS_TO_DECIDE) {
    reasons.push(`${summary.total} rows are too few: M0 decides on ${MIN_ROWS_TO_DECIDE}`);
    verdict = 'GRAY';
  }
  if (missing > 0) {
    reasons.push(`${missing} bookmarks stayed missing after retrying, and M0 allows none`);
    verdict = 'FAIL';
  }
  if (notAttempted > 0) {
    reasons.push(`${notAttempted} bookmarks were never attempted, and M0 allows none`);
    verdict = 'FAIL';
  }
  return { verdict, reasons };
}

/**
 * @param {Answer[]} first
 * @param {Answer[]} second
 * @returns {{onlyFirst: number, onlySecond: number, net: number, sameFolder: number}} over the bookmarks of `first`
 */
export function compareArms(first, second) {
  const secondById = new Map(second.map((answer) => [answer.id, answer]));
  let onlyFirst = 0;
  let onlySecond = 0;
  let sameFolder = 0;
  for (const { id, accepted, folder } of first) {
    const other = secondById.get(id);
    if (accepted === true && other?.accepted !== true) onlyFirst += 1;
    if (accepted !== true && other?.accepted === true) onlySecond += 1;
    if (other?.folder === folder) sameFolder += 1;
  }
  return { onlyFirst, onlySecond, net: onlyFirst - onlySecond, sameFolder };
}

/**
 * Takes the cheapest arm that passes. A dearer one has to beat it clearly: smaller gaps are not
 * distinguishable with this many rows.
 *
 * @param {(Arm & {verdict: Verdict})[]} arms
 * @returns {(Arm & {verdict: Verdict}) | null}
 */
export function chooseArm(arms) {
  const passing = arms.filter((arm) => arm.verdict === 'PASS').sort((a, b) => a.costUsd - b.costUsd);
  let chosen = passing[0] ?? null;
  for (const arm of passing.slice(1)) {
    if (compareArms(arm.answers, /** @type {Arm} */ (chosen).answers).net >= NET_ROWS_TO_PAY_MORE) chosen = arm;
  }
  return chosen;
}

/**
 * @param {Record<string, string>[]} rows
 * @param {string[]} columns
 * @param {string} path
 */
function requireColumns(rows, columns, path) {
  const absent = rows.length === 0 ? [] : columns.filter((column) => !Object.hasOwn(rows[0], column));
  if (absent.length > 0) throw new Error(`${path} has no column ${absent.join(', ')}: use the file that the run wrote`);
}

/**
 * A review can be sorted in a spreadsheet, but it has to hold the bookmarks of the run it claims
 * to come from. Otherwise a percentage could come from a partial or foreign file.
 *
 * @param {string} path of a `review-<model>.csv`
 * @returns {Promise<{path: string, rows: Record<string, string>[], manifest: Manifest, entry: ModelEntry, arm: Arm}>}
 */
export async function readReview(path) {
  const manifest = await readManifestNextTo(path);
  const rows = parseCsv(await readText(path));
  requireColumns(rows, REVIEW_COLUMNS, path);
  if (hashIds(rows.map((row) => row.id)) !== manifest.review_sha256) {
    throw new Error(`${path} does not hold the bookmarks of its run: it has ${rows.length} rows and the run reviewed ${manifest.review_size}. Use the original file, sorted any way you like.`);
  }
  const entry = modelEntryOf(path, manifest);
  if (entry.status !== 'complete') throw new Error(`${entry.requested} did not finish in this run (status: ${entry.status}), so ${path} cannot be scored`);
  return {
    path,
    rows,
    manifest,
    entry,
    arm: {
      label: `${entry.requested} ${entry.effort ?? ''} [${basename(dirname(resolve(path)))}]`.replace(/\s+/g, ' '),
      // Without what was charged for calls that gave no usable answer: that keeps the cap a
      // ceiling, but a passing failure says nothing about what the model costs to use.
      costUsd: entry.spent_usd - (entry.lost_usd ?? 0),
      facts: factsOf(entry, manifest.sample_size),
      answers: rows.map((row) => ({
        id: row.id,
        folder: row.assigned_folder,
        confidence: row.confidence,
        inFolder: row.original_folder !== '',
        accepted: isAbstention(row.assigned_folder) ? false : parseJudgment(row.judgment),
      })),
    },
  };
}

/** @param {string} path */
async function readManifestNextTo(path) {
  const manifestPath = join(dirname(path), MANIFEST_FILE);
  try {
    return await readManifest(manifestPath);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    throw new Error(`No ${MANIFEST_FILE} next to ${path}: a review can only be scored together with the run that produced it.`);
  }
}

/**
 * The name the run gave the file decides. Otherwise it compares without separators, for a file
 * someone renamed, and only if that points at one model: `perplexity/openai/gpt-6-luna` without
 * its provider reads like `openai/gpt-6-luna`. A run of one model needs no name at all, so a file
 * renamed to hide the model still works.
 *
 * @param {string} path
 * @param {Manifest} manifest
 * @returns {ModelEntry}
 */
export function modelEntryOf(path, manifest) {
  const file = basename(path);
  const exact = manifest.models.find(({ requested }) => file === `review-${modelFileStem(requested)}.csv`);
  if (exact) return exact;
  if (manifest.models.length === 1) return manifest.models[0];
  /** @param {string} text */
  const plain = (text) => text.replace(/[^\p{L}\p{N}.]+/gu, '').toLowerCase();
  const name = plain(file.replace(/^review-/, '').replace(/\.csv$/, ''));
  const matches = manifest.models.filter(({ requested }) => plain(requested) === name || plain(requested.slice(requested.indexOf('/') + 1)) === name);
  if (matches.length === 1) return matches[0];
  const names = (matches.length > 1 ? matches : manifest.models).map((model) => model.requested).join(', ');
  throw new Error(matches.length > 1 ? `${path} could be any of ${names}: use the name the run gave it` : `${path} does not name a model of its run: ${names}`);
}

/**
 * Two files for one model of one run would pass the same arm off as two, with the judgments of
 * one under the costs and facts of the other.
 *
 * @param {{path: string, entry: ModelEntry}[]} reviews
 */
export function rejectRepeatedArms(reviews) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const { path, entry } of reviews) {
    const arm = JSON.stringify([dirname(resolve(path)), entry.requested]);
    const other = seen.get(arm);
    if (other !== undefined) throw new Error(`${other} and ${path} are both reviews of ${entry.requested} in the same run: keep one.`);
    seen.set(arm, path);
  }
}

/**
 * A moving alias is expected to change what it serves, so that is shown and not held against it.
 * Any other model that answered is another model, whatever the review says about it.
 *
 * @param {ModelEntry} entry
 * @param {number} expected size of the classification sample
 * @returns {RunFacts}
 */
function factsOf(entry, expected) {
  // `answered_by` counts calls, taxonomy included; `served` counts only the answers kept.
  const served = Object.keys({ ...entry.served, ...entry.answered_by });
  const askedFor = entry.requested.slice(entry.requested.indexOf('/') + 1);
  return {
    ...assessCompleteness(entry, expected),
    servedAs: served.filter((id) => id !== askedFor),
    unexpectedServed: served.filter((id) => !isExpectedServedModel(entry.requested, id)),
  };
}

/**
 * The ids come from the provider's answer.
 *
 * @param {string[]} ids
 */
function formatServed(ids) {
  return ids.map((id) => safeInline(id, 80)).join(', ');
}

/**
 * The key sits next to the list, so that a list can be scored without saying that it is one.
 *
 * @param {string} csvPath
 */
export function keyPathOf(csvPath) {
  return `${csvPath.replace(/\.csv$/i, '')}.key.json`;
}

/** @param {Slice} slice */
const formatSlice = ({ accepted, total }) => `${accepted}/${total}${total > 0 ? ` (${formatPercent(accepted / total)})` : ''}`;

/**
 * Prints an arm and says whether every row is judged.
 *
 * @param {ArmSummary} summary
 * @returns {boolean}
 */
function printCounts(summary) {
  console.log(`Accepted: ${summary.accepted}  Rejected: ${summary.rejected}  Abstained: ${summary.abstained}  Pending: ${summary.pending}`);
  const judged = summary.total - summary.pending;
  if (judged === summary.abstained && summary.abstained < summary.total) {
    console.log('Nothing judged yet: fill the judgment column with y or n.');
    return false;
  }
  const [low, high] = wilsonInterval(summary.accepted, judged);
  console.log(`Acceptance: ${formatPercent(judged === 0 ? 0 : summary.accepted / judged)} [${formatPercent(low)}, ${formatPercent(high)}] of ${judged} rows (95 % Wilson interval; abstentions count as not accepted; target ${formatPercent(ACCEPTANCE_TARGET)})`);
  if (summary.pending > 0) {
    console.log('Incomplete: judge every row before using this result.');
    return false;
  }
  const assigned = summary.total - summary.abstained;
  console.log(`Precision: ${formatSlice({ accepted: summary.accepted, total: assigned })} of the rows with a folder. Coverage: ${formatPercent(summary.total === 0 ? 0 : assigned / summary.total)}`);
  console.log(`By confidence: high ${formatSlice(summary.high)}, low ${formatSlice(summary.low)}`);
  console.log(`By origin: already in a folder ${formatSlice(summary.inFolder)}, loose ${formatSlice(summary.loose)}`);
  console.log(`Largest folder: ${formatPercent(summary.largestFolderShare)} of the rows with a folder`);
  return true;
}

/**
 * @param {Arm} arm
 * @returns {(Arm & {verdict: Verdict}) | null} null when it is not fully judged
 */
function printArm(arm) {
  console.log(`\n${arm.label}`);
  if (arm.facts.servedAs.length > 0) console.log(`Served as: ${formatServed(arm.facts.servedAs)}`);
  console.log(`M0 completeness: ${arm.facts.complete ? 'PASS' : 'FAIL'} (missing=${arm.facts.missing}, not attempted=${arm.facts.notAttempted})`);
  const summary = summarizeArm(arm.answers);
  if (!printCounts(summary)) return null;
  const { verdict, reasons } = decide(summary, arm.facts);
  console.log(`Verdict: ${verdict}`);
  for (const reason of reasons) console.log(`  - ${reason}`);
  return { ...arm, verdict };
}

/**
 * Prints what the rule of M0 says for all the arms and returns the exit code: 0 only if one of
 * them is good enough to go on with.
 *
 * @param {Arm[]} arms
 * @returns {number}
 */
function printDecision(arms) {
  const judged = arms.map(printArm);
  if (judged.some((arm) => arm === null)) return 1;
  const complete = /** @type {(Arm & {verdict: Verdict})[]} */ (judged);

  if (complete.length > 1) console.log('\nPairs, on the same bookmarks:');
  for (let i = 0; i < complete.length; i += 1) {
    for (const other of complete.slice(i + 1)) {
      const { onlyFirst, onlySecond, net, sameFolder } = compareArms(complete[i].answers, other.answers);
      console.log(`  ${complete[i].label} vs ${other.label}: only the first ${onlyFirst}, only the second ${onlySecond}, net ${net} rows, same folder in ${sameFolder} of ${complete[i].answers.length}`);
    }
  }

  const chosen = chooseArm(complete);
  console.log('');
  if (chosen) {
    console.log(`Decision: go on with ${chosen.label}.`);
    return 0;
  }
  if (complete.some((arm) => arm.verdict === 'GRAY')) {
    console.log('Decision: not yet. The best result is in the gray zone: edit the taxonomy or raise the effort, and judge only what changes.');
  } else {
    console.log('Decision: do not go on. Low coverage points at the taxonomy; low precision in every arm means that the title and URL are not enough.');
  }
  return 1;
}

/**
 * What identifies a judgment: this bookmark in this folder, whichever arm proposed it.
 *
 * @param {{id: string, folder: string}} pair
 */
export function pairKey({ id, folder }) {
  return JSON.stringify([id, folder]);
}

/**
 * Reads a list written by `runBlind` and matches each row with its key. The rows go by their
 * number, so the list can be sorted in a spreadsheet.
 *
 * @param {string} path
 * @returns {Promise<{key: any, verdictOf: Map<string, boolean | null>, repeated: {pair: string, judgment: boolean | null}[]}>}
 */
export async function readBlindList(path) {
  const key = JSON.parse(await readFile(keyPathOf(path), 'utf8'));
  if (key?.schema !== BLIND_KEY_SCHEMA) throw new Error(`${keyPathOf(path)} is not a ${BLIND_KEY_SCHEMA} file`);
  const rows = parseCsv(await readText(path));
  requireColumns(rows, BLIND_COLUMNS, path);

  const expected = new Set(key.rows.map((/** @type {{row: string}} */ row) => row.row));
  const seen = new Set(rows.map((row) => row.row));
  if (rows.length !== expected.size || seen.size !== expected.size || rows.some((row) => !expected.has(row.row))) {
    throw new Error(`${path} does not hold the rows of its key: it has ${rows.length} and the key has ${expected.size}.`);
  }

  /** @type {Map<string, boolean | null>} */
  const verdictOf = new Map(key.carried.map((/** @type {{id: string, folder: string, accepted: boolean}} */ pair) => [pairKey(pair), pair.accepted]));
  const byRow = new Map(rows.map((row) => [row.row, row]));
  /** @type {{pair: string, judgment: boolean | null}[]} */
  const repeated = [];
  for (const { row, id, folder, repeat } of key.rows) {
    const cell = /** @type {Record<string, string>} */ (byRow.get(row));
    if (cell.folder !== folder) throw new Error(`Row ${row} of ${path} does not match its key: the folder changed.`);
    const judgment = parseJudgment(cell.judgment);
    if (repeat) repeated.push({ pair: pairKey({ id, folder }), judgment });
    else verdictOf.set(pairKey({ id, folder }), judgment);
  }
  return { key, verdictOf, repeated };
}

/**
 * @param {string} path of a list written by `runBlind`
 * @returns {Promise<number>}
 */
async function scoreBlind(path) {
  const { key, verdictOf, repeated } = await readBlindList(path);

  /** @type {Arm[]} */
  const arms = key.arms.map((/** @type {any} */ arm) => ({
    label: arm.label,
    costUsd: arm.cost_usd,
    facts: arm.facts,
    answers: arm.answers.map((/** @type {any} */ answer) => ({
      id: answer.id,
      folder: answer.folder,
      confidence: answer.confidence,
      inFolder: answer.in_folder,
      accepted: verdictOf.get(pairKey(answer)) ?? null,
    })),
  }));

  const code = printDecision(arms);
  const answered = repeated.filter(({ pair, judgment }) => judgment !== null && verdictOf.get(pair) !== null);
  if (answered.length > 0) {
    const changed = answered.filter(({ pair, judgment }) => verdictOf.get(pair) !== judgment).length;
    console.log(`Repeated rows: ${changed} of ${answered.length} changed.${changed >= 2 ? ' Your criterion is not stable: treat gaps under 10 rows as ties.' : ''}`);
  }
  return code;
}

/**
 * Prints the result of the given reviews, or of one blind list. `score` recomputes from the CSV
 * because it is the only record of the human judgment, and checks it against the run.
 *
 * @param {string[]} paths
 * @returns {Promise<number>} 0 passes; 1 does not pass, is in the gray zone or is incomplete
 */
export async function runScore(paths) {
  if (paths.length === 1 && (await exists(keyPathOf(paths[0])))) return scoreBlind(paths[0]);
  const reviews = await Promise.all(paths.map(readReview));
  rejectRepeatedArms(reviews);
  // Ids are positions in an export, so two exports can share them and mean other bookmarks.
  const fingerprints = new Set(reviews.map(({ manifest }) => `${manifest.input.sha256} ${manifest.review_sha256}`));
  if (fingerprints.size > 1) throw new Error('These reviews are not about the same bookmarks, so they cannot be compared.');
  for (const { entry, rows } of reviews) {
    const ignored = rows.filter((row) => isAbstention(row.assigned_folder) && parseJudgment(row.judgment) === true).length;
    if (ignored > 0) console.error(`${entry.requested}: ${ignored} rows without a folder were marked as accepted, and they count as not accepted.`);
  }
  return printDecision(reviews.map(({ arm }) => arm));
}

/** @param {string} path */
function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}
