import { cleanText, cleanTitle } from './prompt.js';
import { suggestFolderCount } from './taxonomy.js';

const MAX_FOLDER_NAME_LENGTH = 60;
const MAX_FOLDER_LEVELS = 2;
/** Below this many sendable bookmarks the taxonomy sample is capped so a remainder is left to judge. */
const SMALL_COLLECTION = 450;

/**
 * Small deterministic PRNG, so that two runs over the same export use the same sample.
 *
 * @param {number} seed
 */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} seed
 * @returns {T[]} shuffled copy
 */
export function seededShuffle(items, seed) {
  const random = createRandom(seed);
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Takes items round-robin across groups, so a huge folder cannot crowd out small ones.
 *
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @param {(item: T) => string} groupOf
 * @param {number} seed
 * @returns {T[]}
 */
export function stratifiedSample(items, size, groupOf, seed) {
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  for (const item of seededShuffle(items, seed)) {
    const key = groupOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  let queues = [...groups.values()];
  /** @type {T[]} */
  const sample = [];
  for (let round = 0; sample.length < size && queues.length > 0; round += 1) {
    for (const queue of queues) {
      if (sample.length < size) sample.push(queue[round]);
    }
    queues = queues.filter((queue) => queue.length > round + 1);
  }
  return sample;
}

/**
 * Each use of the seed gets its own stream, so the sample, the review and the taxonomy do
 * not walk the same permutation.
 *
 * @param {number} seed
 * @param {number} salt
 */
function deriveSeed(seed, salt) {
  return Math.imul((seed >>> 0) ^ salt, 0x9e3779b1) >>> 0;
}

/** @param {unknown} value */
const toCount = (value) => (Number.isFinite(value) ? Math.max(0, Math.floor(/** @type {number} */ (value))) : 0);

/**
 * The most populated folder paths of the whole collection, cut to two levels so that every
 * candidate is a name the taxonomy step accepts. Names that are still too long are skipped.
 *
 * @param {{folderPath: string}[]} items
 * @param {number} limit
 */
function existingFolderNames(items, limit) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const { folderPath } of items) {
    if (!folderPath) continue;
    const name = cleanText(folderPath.split('/').slice(0, MAX_FOLDER_LEVELS).join('/')).trim();
    // A name the title masking would alter holds an email or a token: skip it rather than send it.
    if (name === '' || name.length > MAX_FOLDER_NAME_LENGTH || cleanTitle(name) !== name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([name]) => name);
}

/**
 * Decides, from the whole sendable collection, what each step of a run sees.
 *
 * The taxonomy sample is half spread across folders (coverage) and half uniform (weight,
 * so a heap of 1,500 loose bookmarks is represented). Classification and review come from
 * what the taxonomy never saw, by simple random choice, so the acceptance rate estimates
 * the collection and not the folder structure.
 *
 * @template {{id: string, folderPath: string}} T
 * @param {T[]} sendable
 * @param {{seed: number, sample: number, review: number, taxonomySize?: number, maxExistingFolders?: number}} options
 */
export function planRun(sendable, { seed, sample, review, taxonomySize = 150, maxExistingFolders = 60 }) {
  const cap = sendable.length < SMALL_COLLECTION ? Math.max(1, Math.floor(sendable.length / 3)) : Infinity;
  const taxonomyTarget = Math.min(toCount(taxonomySize), cap, sendable.length);
  const byFolder = Math.ceil(taxonomyTarget / 2);

  const byTurns = stratifiedSample(sendable, byFolder, (item) => item.folderPath, deriveSeed(seed, 1));
  const chosen = new Set(byTurns);
  const uniform = seededShuffle(
    sendable.filter((item) => !chosen.has(item)),
    deriveSeed(seed, 2),
  ).slice(0, taxonomyTarget - byTurns.length);
  const taxonomySample = [...byTurns, ...uniform];

  const inTaxonomy = new Set(taxonomySample);
  const classificationSample = seededShuffle(
    sendable.filter((item) => !inTaxonomy.has(item)),
    deriveSeed(seed, 3),
  ).slice(0, toCount(sample));

  const reviewed = new Set(seededShuffle(classificationSample, deriveSeed(seed, 4)).slice(0, toCount(review)));
  const reviewItems = classificationSample.filter((item) => reviewed.has(item));

  return {
    taxonomySample,
    classificationSample,
    reviewItems,
    maxFolders: suggestFolderCount(sendable.length),
    existingFolders: existingFolderNames(sendable, toCount(maxExistingFolders)),
  };
}
