import { access, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { seededShuffle } from '../../extension/core/sampling.js';
import { toCsv } from './csv.mjs';
import { writeNew } from './output.mjs';
import { BLIND_COLUMNS, BLIND_KEY_SCHEMA, isAbstention, keyPathOf, pairKey, readBlindList, readReview, rejectRepeatedArms } from './score.mjs';

/** Enough to notice an unstable criterion: 2 or more flips are unlikely below a 5 % flip rate. */
const MAX_REPEATED_ROWS = 10;

/**
 * @typedef {{row: string, id: string, folder: string, repeat: boolean}} KeyRow
 * @typedef {{id: string, title: string, url: string, folder: string}} Pair
 */

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function reviewFilesIn(dir) {
  const names = await readdir(dir);
  const reviews = names.filter((name) => /^review-.+\.csv$/.test(name)).sort();
  if (reviews.length === 0) throw new Error(`${dir} has no review-*.csv: only models that finished have one`);
  return reviews.map((name) => join(dir, name));
}

/**
 * Rows that repeat a pair come from the first half and land in the second, far enough apart to
 * be judged afresh. One pair in ten repeats, up to the maximum, so a short follow-up list stays short.
 *
 * @param {Pair[]} pairs
 * @param {number} seed
 * @returns {(Pair & {repeat: boolean})[]}
 */
export function orderRows(pairs, seed) {
  const shuffled = seededShuffle(pairs, seed + 1).map((pair) => ({ ...pair, repeat: false }));
  const middle = Math.ceil(shuffled.length / 2);
  const firstHalf = shuffled.slice(0, middle);
  const repeats = seededShuffle(firstHalf, seed + 2)
    .slice(0, Math.min(MAX_REPEATED_ROWS, Math.floor(pairs.length / 10)))
    .map((pair) => ({ ...pair, repeat: true }));
  return [...firstHalf, ...seededShuffle([...shuffled.slice(middle), ...repeats], seed + 3)];
}

/**
 * Writes one list to judge, with no model, confidence or original folder in sight, plus the key
 * that `score` needs to attribute each judgment. Each pair of bookmark and folder goes once,
 * whichever arms proposed it, so the same answer gets the same judgment in every arm. Abstentions
 * are left out: they count as not accepted, without judging.
 *
 * All the runs must have reviewed the same bookmarks of the same export. That is what makes the
 * comparison paired, on the same rows.
 *
 * `previous` names lists already judged: their judgments carry over and those pairs are not asked
 * again, so adding an arm after a gray result only costs the time of what it changes.
 *
 * @param {string[]} runDirs
 * @param {{out?: string, seed?: number, previous?: string[]}} [options]
 * @returns {Promise<number>} exit code
 */
export async function runBlind(runDirs, { out, seed = 1, previous = [] } = {}) {
  if (runDirs.length === 0) throw new Error('Usage: eval.mjs blind <run-dir>... [--out file] [--seed 1] [--previous judged.csv]');
  const csvPath = resolve(out ?? join(runDirs[0], 'blind.csv'));
  const keyPath = keyPathOf(csvPath);
  for (const path of [csvPath, keyPath]) {
    const taken = await access(path).then(
      () => true,
      () => false,
    );
    if (taken) throw new Error(`Refusing to overwrite ${path}: it may hold judgments. Choose another --out.`);
  }

  const reviews = [];
  for (const dir of runDirs) {
    for (const path of await reviewFilesIn(dir)) reviews.push({ dir, ...(await readReview(path)) });
  }
  rejectRepeatedArms(reviews);
  const { input, review_sha256: reviewFingerprint } = reviews[0].manifest;
  for (const { dir, manifest } of reviews) {
    if (manifest.input.sha256 !== input.sha256) throw new Error(`${dir} comes from another export, so its ids mean other bookmarks.`);
    if (manifest.review_sha256 !== reviewFingerprint) throw new Error(`${dir} reviewed other bookmarks: use the same export, seed, --sample and --review.`);
  }

  /** @type {Map<string, boolean>} */
  const carried = new Map();
  for (const path of previous) {
    const { key, verdictOf } = await readBlindList(path);
    if (key.input_sha256 !== input.sha256 || key.review_sha256 !== reviewFingerprint) throw new Error(`${path} judged other bookmarks, so its judgments cannot carry over.`);
    for (const [pair, accepted] of verdictOf) {
      if (accepted !== null) carried.set(pair, accepted);
    }
  }

  /** @type {Map<string, Pair>} */
  const pairs = new Map();
  for (const { rows } of reviews) {
    for (const { id, title, url, assigned_folder: folder } of rows) {
      const pair = pairKey({ id, folder });
      if (!isAbstention(folder) && !carried.has(pair)) pairs.set(pair, { id, title, url, folder });
    }
  }
  // Sorted first, so the order depends on the seed and not on which run was named first.
  const sortedPairs = [...pairs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, pair]) => pair);
  const ordered = orderRows(sortedPairs, seed);

  const arms = reviews.map(({ dir, entry, arm }) => ({
    label: `${entry.requested} ${entry.effort ?? ''} [${basename(resolve(dir))}]`.replace(/\s+/g, ' '),
    run_dir: resolve(dir),
    model: entry.requested,
    effort: entry.effort,
    taxonomy_sha256: entry.taxonomy_sha256,
    cost_usd: arm.costUsd,
    facts: arm.facts,
    answers: arm.answers.map(({ id, folder, confidence, inFolder }) => ({ id, folder, confidence, in_folder: inFolder })),
  }));
  /** @type {KeyRow[]} */
  const keyRows = ordered.map(({ id, folder, repeat }, index) => ({ row: `r${index + 1}`, id, folder, repeat }));
  const carriedPairs = [...carried].map(([pair, accepted]) => {
    const [id, folder] = JSON.parse(pair);
    return { id, folder, accepted };
  });

  // The key first: a list without its key would be judged for nothing.
  await writeNew(
    keyPath,
    `${JSON.stringify({ schema: BLIND_KEY_SCHEMA, seed, input_sha256: input.sha256, review_sha256: reviewFingerprint, rows: keyRows, carried: carriedPairs, arms }, null, 2)}\n`,
  );
  await writeNew(
    csvPath,
    toCsv(
      BLIND_COLUMNS,
      ordered.map(({ title, url, folder }, index) => ['', `r${index + 1}`, title, url, folder]),
    ),
  );

  console.log(`Arms: ${arms.length}. Rows to judge: ${ordered.length} (${pairs.size} pairs and ${ordered.length - pairs.size} repeated). Judgments carried over: ${carried.size}.`);
  console.log(`List: ${csvPath}`);
  console.log(`Key, do not open it until you finish: ${keyPath}`);
  console.log('Write y if you would expect to find the bookmark in that folder; n if you would move it or cannot decide in 15 seconds.');
  console.log(`Then run: eval.mjs score ${csvPath}`);
  return 0;
}
