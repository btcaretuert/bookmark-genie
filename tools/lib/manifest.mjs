import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeAtomic } from './output.mjs';

/**
 * The record that makes a run auditable. A model's answers cannot be reproduced, so this file
 * has to say which input, sample, prompts, code and prices produced them. `report.md` is a view
 * for people and carries no contract; anything that analyzes a run reads this.
 *
 * Adding a field keeps the schema version. Renaming or removing one changes it.
 */

export const MANIFEST_SCHEMA = 'bookmark-genie/run-manifest@1';
export const MANIFEST_FILE = 'manifest.json';

/** What the tool itself depends on. `node_modules` is covered through the lockfile. */
const CODE_ENTRIES = ['extension', 'package-lock.json', 'tools'];
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const KEY_SUFFIX_LENGTH = 4;
const MIN_KEY_LENGTH = 8;

/** What M0 tolerates of refusals and truncations; `missing` indices are never tolerated. */
export const MAX_UNCLASSIFIED_SHARE = 0.02;

/**
 * The single rule for "did the model finish the sample", shared by the console, the report and
 * `score`. Only `missing` blocks M0; refusals and truncations are reported as a share that
 * `score` weighs against `MAX_UNCLASSIFIED_SHARE`.
 *
 * @param {{classified: number, unclassified: number, unclassified_reasons?: Record<string, number>}} entry from `summarizeModel`
 * @param {number} expected size of the classification sample
 */
export function assessCompleteness({ classified, unclassified, unclassified_reasons: reasons }, expected) {
  const missing = reasons?.missing ?? 0;
  const notAttempted = Math.max(0, expected - classified - unclassified);
  const total = classified + unclassified;
  return { missing, notAttempted, unclassifiedShare: total === 0 ? 0 : unclassified / total, complete: missing === 0 && notAttempted === 0 };
}

/**
 * @typedef {'running' | 'complete' | 'stopped'} RunStatus
 * @typedef {'pending' | 'running' | 'complete' | 'stopped'} ModelStatus
 * @typedef {{code_sha256: string, node: string, anthropic_sdk: string | null}} ToolInfo
 * @typedef {{
 *   seed: number,
 *   sample: number,
 *   review: number,
 *   language: string,
 *   max_usd: number,
 *   effort?: string,
 *   fallback?: boolean,
 *   dry_run?: boolean,
 *   max_folders?: number,
 *   exclude_folder?: string | null,
 *   taxonomy_file_sha256?: string | null,
 * }} RunParams as asked for on the command line; `models[]` records what each model really used
 * @typedef {{
 *   ref: string,
 *   endpoint?: string | null,
 *   keySuffix?: string | null,
 *   dataPolicy?: unknown,
 *   effort?: string | null,
 *   fallback?: boolean,
 *   prompts: {classify: object | null, taxonomy: object | null},
 * }} ModelInput `prompts` holds requests built with empty data, as `promptHash` expects
 * @typedef {{
 *   requested: string,
 *   provider: string,
 *   status: ModelStatus,
 *   endpoint: string | null,
 *   key_suffix: string | null,
 *   data_policy: unknown,
 *   effort: string | null,
 *   fallback: boolean,
 *   prompts: {classify_sha256: string | null, taxonomy_sha256: string | null},
 *   served: Record<string, number>,
 *   answered_by: Record<string, number>,
 *   taxonomy_sha256: string | null,
 *   dropped: Record<string, number>,
 *   classified: number,
 *   unclassified: number,
 *   unclassified_reasons: Record<string, number>,
 *   input_tokens: number,
 *   output_tokens: number,
 *   thinking_tokens: number,
 *   spent_usd: number,
 *   lost_usd: number,
 *   stopped_by: string | null,
 * }} ModelEntry
 * @typedef {{
 *   schema: string,
 *   run_id: string,
 *   status: RunStatus,
 *   started_at: string,
 *   finished_at: string | null,
 *   exit_code: number | null,
 *   stopped_by: string | null,
 *   tool: ToolInfo,
 *   input: {sha256: string, bytes: number, bookmarks: number, sendable: number, excluded: Record<string, number>},
 *   params: RunParams & {models: string[]},
 *   sample_size: number,
 *   sample_sha256: string,
 *   review_size: number,
 *   review_sha256: string,
 *   taxonomy_sample_size: number,
 *   taxonomy_sample_sha256: string,
 *   quality: unknown,
 *   prices_usd_per_mtok: Record<string, object>,
 *   spent_usd: number,
 *   lost_usd: number,
 *   cap_broken_by: {model: string, max_tokens: number, output_tokens: number} | null,
 *   models: ModelEntry[],
 * }} Manifest
 */

/** @param {string | Uint8Array} data */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Fingerprint of a set of bookmarks. Sorting makes it independent of row order, because a person
 * may sort the review in a spreadsheet; a missing or repeated row still changes it. `score` uses
 * this to compare a judged CSV against `review_sha256`.
 *
 * @param {Iterable<string>} ids
 */
export function hashIds(ids) {
  return sha256([...ids].sort().join('\n'));
}

/**
 * Build the request with empty data: that leaves the system prompt, the template of the user
 * message, the schema and the token allowance, which is everything that defines the prompt.
 *
 * @param {object} request
 */
export function promptHash(request) {
  return sha256(JSON.stringify(request));
}

/**
 * Identifies the contents of a taxonomy, so runs with the same folders can be told apart from
 * runs with other ones. Order counts: it sets the numbers the model answers with.
 *
 * @param {{name: string, description?: string}[]} folders
 */
export function hashTaxonomy(folders) {
  return sha256(JSON.stringify(folders.map(({ name, description }) => [name, description ?? ''])));
}

/**
 * Says which credential a run used without storing it. A value too short to be a real key gives
 * nothing, so the suffix can never be the whole secret.
 *
 * @param {string | null | undefined} apiKey
 * @returns {string | null}
 */
export function keySuffix(apiKey) {
  return typeof apiKey === 'string' && apiKey.length >= MIN_KEY_LENGTH ? apiKey.slice(-KEY_SUFFIX_LENGTH) : null;
}

/**
 * A `provider/model` reference as part of a file name, where `/` cannot go:
 * `review-anthropic__claude-haiku-5-5.csv`. `score` and `blind` match these names to `requested`
 * by comparing letters and digits, so the replacement can change without breaking them.
 *
 * @param {string} ref
 */
export function modelFileStem(ref) {
  return ref.replace(/[^A-Za-z0-9._-]+/g, '__');
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} keyOf
 * @returns {Record<string, number>}
 */
function countBy(items, keyOf) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  // fromEntries defines own properties, so a folder called __proto__ stays plain data.
  return Object.fromEntries(counts);
}

/**
 * @param {ModelInput} model
 * @returns {ModelEntry}
 */
function newModelEntry({ ref, endpoint, keySuffix: suffix, dataPolicy, effort, fallback, prompts }) {
  return {
    requested: ref,
    provider: ref.slice(0, ref.indexOf('/')),
    status: 'pending',
    // The origin alone: a base URL can carry credentials or a key in its query.
    endpoint: endpoint ? new URL(endpoint).origin : null,
    key_suffix: suffix ?? null,
    data_policy: dataPolicy ?? null,
    effort: effort ?? null,
    fallback: fallback ?? false,
    prompts: {
      classify_sha256: prompts.classify ? promptHash(prompts.classify) : null,
      taxonomy_sha256: prompts.taxonomy ? promptHash(prompts.taxonomy) : null,
    },
    served: {},
    answered_by: {},
    taxonomy_sha256: null,
    dropped: {},
    classified: 0,
    unclassified: 0,
    unclassified_reasons: {},
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    spent_usd: 0,
    lost_usd: 0,
    stopped_by: null,
  };
}

/**
 * Builds the manifest of a run about to start. Pure: the caller owns the clock and the files.
 *
 * @param {{
 *   startedAt: string,
 *   tool: ToolInfo,
 *   inputBytes: string | Uint8Array,
 *   bookmarks: number,
 *   sendable: number,
 *   excluded: Record<string, number>,
 *   params: RunParams,
 *   models: ModelInput[],
 *   prices: Record<string, object>,
 *   taxonomySampleIds: string[],
 *   sampleIds: string[],
 *   reviewIds: string[],
 *   quality?: unknown,
 * }} input `inputBytes` is the export as read from disk, so `input.sha256` matches sha256sum;
 *   `prices` is keyed by `provider/model`
 * @returns {Manifest}
 */
export function createManifest({ startedAt, tool, inputBytes, bookmarks, sendable, excluded, params, models, prices, taxonomySampleIds, sampleIds, reviewIds, quality }) {
  const refs = models.map((model) => model.ref);
  if (new Set(refs).size !== refs.length) throw new Error(`A run cannot repeat a model: ${refs.join(', ')}`);

  return {
    schema: MANIFEST_SCHEMA,
    run_id: startedAt.replaceAll(':', '-'),
    status: 'running',
    started_at: startedAt,
    finished_at: null,
    exit_code: null,
    stopped_by: null,
    tool,
    input: { sha256: sha256(inputBytes), bytes: Buffer.byteLength(inputBytes), bookmarks, sendable, excluded },
    params: { ...params, models: refs },
    sample_size: sampleIds.length,
    sample_sha256: hashIds(sampleIds),
    review_size: reviewIds.length,
    review_sha256: hashIds(reviewIds),
    taxonomy_sample_size: taxonomySampleIds.length,
    taxonomy_sample_sha256: hashIds(taxonomySampleIds),
    quality: quality ?? null,
    prices_usd_per_mtok: prices,
    spent_usd: 0,
    lost_usd: 0,
    cap_broken_by: null,
    models: models.map(newModelEntry),
  };
}

/**
 * @param {ModelEntry[]} entries
 * @param {Partial<ModelEntry> & {requested: string}} patch
 * @returns {ModelEntry[]}
 */
function patchModel(entries, { requested, ...fields }) {
  if (!entries.some((entry) => entry.requested === requested)) throw new Error(`Model not in this manifest: ${requested}`);
  return entries.map((entry) => (entry.requested === requested ? { ...entry, ...fields } : entry));
}

/**
 * Returns the next state of a manifest; the one passed in does not change. A finished run accepts
 * no more updates, and `complete` means every model completed, so `score` can rely on it.
 * `stoppedBy` has to be redacted already: this file outlives the run.
 *
 * @param {Manifest} manifest
 * @param {{
 *   status?: RunStatus,
 *   finishedAt?: string,
 *   exitCode?: number,
 *   stoppedBy?: string | null,
 *   spentUsd?: number,
 *   lostUsd?: number,
 *   capBrokenBy?: Manifest['cap_broken_by'],
 *   model?: Partial<ModelEntry> & {requested: string},
 * }} update
 * @returns {Manifest}
 */
export function updateManifest(manifest, { status, finishedAt, exitCode, stoppedBy, spentUsd, lostUsd, capBrokenBy, model }) {
  if (manifest.status !== 'running') throw new Error(`Run ${manifest.run_id} already finished as ${manifest.status}`);

  /** @type {Manifest} */
  const next = {
    ...manifest,
    status: status ?? manifest.status,
    finished_at: finishedAt ?? manifest.finished_at,
    exit_code: exitCode ?? manifest.exit_code,
    stopped_by: stoppedBy ?? manifest.stopped_by,
    spent_usd: spentUsd ?? manifest.spent_usd,
    lost_usd: lostUsd ?? manifest.lost_usd,
    cap_broken_by: capBrokenBy ?? manifest.cap_broken_by,
    models: model ? patchModel(manifest.models, model) : manifest.models,
  };

  if (next.status !== 'running') {
    if (next.finished_at === null || next.exit_code === null) throw new Error(`A ${next.status} run needs finishedAt and exitCode`);
    if (next.status === 'stopped' && !next.stopped_by) throw new Error('A stopped run needs the reason in stoppedBy');
    if (next.status === 'complete' && !next.params.dry_run && next.models.some((entry) => entry.status !== 'complete')) {
      throw new Error('A complete run needs every model complete');
    }
  }
  return next;
}

/**
 * Turns the outcome of a model, finished or not, into the update for its manifest entry.
 *
 * @param {{
 *   model: string,
 *   status: ModelStatus,
 *   folders: {name: string, description?: string}[],
 *   dropped: {reason: string}[],
 *   assignments: {servedModel: string}[],
 *   unclassified: {reason: string}[],
 *   metrics: {inputTokens: number, outputTokens: number, thinkingTokens: number, spentUsd: number, lostUsd?: number, servedModels?: Record<string, number>},
 * }} result a ModelResult
 * @returns {Partial<ModelEntry> & {requested: string}}
 */
export function summarizeModel({ model, status, folders, dropped, assignments, unclassified, metrics }) {
  return {
    requested: model,
    status,
    served: countBy(assignments, (assignment) => assignment.servedModel),
    // Per call, the taxonomy included: the only record of a different model answering the folders.
    answered_by: Object.fromEntries(Object.entries(metrics.servedModels ?? {})),
    taxonomy_sha256: folders.length > 0 ? hashTaxonomy(folders) : null,
    dropped: countBy(dropped, (entry) => entry.reason),
    classified: assignments.length,
    unclassified: unclassified.length,
    unclassified_reasons: countBy(unclassified, (entry) => entry.reason),
    input_tokens: metrics.inputTokens,
    output_tokens: metrics.outputTokens,
    thinking_tokens: metrics.thinkingTokens,
    spent_usd: metrics.spentUsd,
    lost_usd: metrics.lostUsd ?? 0,
  };
}

/**
 * Stands in for a commit, since the project is not a git repository. The lines hashed are what
 * sha256sum prints, so this can be checked from a shell:
 *   find extension package-lock.json tools -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum
 * Only regular files count: a symbolic link is neither followed nor hashed.
 *
 * @param {string} [root]
 */
export async function hashCodeTree(root = PROJECT_ROOT) {
  /** @type {string[]} */
  const files = [];
  for (const entry of CODE_ENTRIES) {
    const stats = await stat(join(root, entry)).catch(() => null);
    if (stats?.isFile()) files.push(entry);
    if (stats?.isDirectory()) {
      for (const child of await readdir(join(root, entry), { recursive: true, withFileTypes: true })) {
        if (child.isFile()) files.push(relative(root, join(child.parentPath, child.name)));
      }
    }
  }
  files.sort();
  const lines = await Promise.all(files.map(async (file) => `${sha256(await readFile(join(root, file)))}  ${file}\n`));
  return sha256(lines.join(''));
}

/**
 * Reads the SDK version from its package instead of trusting the import.
 *
 * @param {string} [root]
 * @returns {Promise<ToolInfo>}
 */
export async function describeTool(root = PROJECT_ROOT) {
  const sdkPackage = await readFile(join(root, 'node_modules/@anthropic-ai/sdk/package.json'), 'utf8').catch(() => null);
  return {
    code_sha256: await hashCodeTree(root),
    node: process.versions.node,
    anthropic_sdk: sdkPackage === null ? null : JSON.parse(sdkPackage).version,
  };
}

/**
 * Atomic, because the run rewrites it as it progresses and it must stay readable after a crash.
 *
 * @param {string} dir the run directory
 * @param {Manifest} manifest
 */
export function writeManifest(dir, manifest) {
  return writeAtomic(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * @param {string} path of a manifest file
 * @returns {Promise<Manifest>}
 */
export async function readManifest(path) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (manifest?.schema !== MANIFEST_SCHEMA) {
    throw new Error(`${path} is not a ${MANIFEST_SCHEMA} file (schema: ${JSON.stringify(manifest?.schema)})`);
  }
  return manifest;
}
