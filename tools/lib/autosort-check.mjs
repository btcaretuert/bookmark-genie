/**
 * IA-12: measures the Ctrl+D prompt of the extension on a real export, before trusting it to move
 * bookmarks without asking (docs/decisiones.md, "Medir M3 antes de M3").
 *
 * Every request is built by the extension's own core (`candidateFolders`, `looseSiblings`,
 * `buildAutoSortRequest`) and every answer is read by `readAutoSortAnswer`, so what is measured
 * is the prompt that ships. The context is assembled in the same order as `platform/autosort.js`:
 * exclusions, duplicate URL, `sanitizeForLlm`, folders, loose siblings. Three kinds of case:
 *
 * - loo: a bookmark inside a folder is taken out and saved again in the bar, as Ctrl+D would.
 *   The right answer is that folder.
 * - ablation: a whole folder is removed and its bookmarks left loose in the bar; one of them is
 *   saved again. The right answer is a new folder that gathers the others; an existing folder
 *   with high confidence is the "forced" error the owner complained about.
 * - loose: bookmarks already loose in a root. There is no right answer to score; they go to the
 *   review file for the person to judge.
 *
 * Each case runs `repeat` times: Gemini 3 ignores temperature, so stability is measured, not set.
 * Repeats of one case are not independent, so every interval uses the number of distinct cases,
 * not of calls. With few cases the check can only reject a prompt, never certify 95 %.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  DEADLINE_MS,
  SUGGEST_AUTOMATIC,
  buildAutoSortRequest,
  candidateFolders,
  excludedSet,
  folderKey,
  looseSiblings,
  readAutoSortAnswer,
} from '../../extension/core/autosort.js';
import { estimateTokens } from '../../extension/core/batching.js';
import { BudgetExceededError, costOf, createBudget, formatUsd } from '../../extension/core/budget.js';
import { budgetPrices } from '../../extension/core/models.js';
import { cleanText, cleanTitle } from '../../extension/core/prompt.js';
import { seededShuffle } from '../../extension/core/sampling.js';
import { indexTree, isFolder, rootsOf } from '../../extension/core/tree.js';
import { sanitizeForLlm } from '../../extension/core/url.js';
import { createComplete } from '../../extension/platform/complete-factory.js';
import { describeDataPolicy, requiresTrainingConsent } from '../../extension/platform/providers.js';
import { UsageError } from './args.mjs';
import { toCsv } from './csv.mjs';
import { describeTool, keySuffix, modelFileStem, promptHash, sha256 } from './manifest.mjs';
import { parseNetscapeTree } from './netscape.mjs';
import { appendLine, createRunDir, writeAtomic, writeNew } from './output.mjs';
import { InterruptedError, assertKeyShape, instrument, listenForSignals, resolveModel } from './runner.mjs';
import { redact, safeInline } from './safe-text.mjs';

/**
 * @typedef {import('../../extension/core/tree.js').TreeNode} TreeNode
 * @typedef {import('../../extension/core/autosort.js').CandidateFolder} CandidateFolder
 * @typedef {import('../../extension/core/autosort.js').LooseBookmark} LooseBookmark
 * @typedef {'loo' | 'ablation' | 'loose'} CaseType
 * @typedef {{
 *   id: string,
 *   type: CaseType,
 *   bookmark: {id: string, title: string, url: string},
 *   folders: CandidateFolder[],
 *   loose: LooseBookmark[],
 *   parentId: string,
 *   expected: {folderId: string, folderName: string} | {removedFolder: string, members: string[]} | null,
 * }} CheckCase `bookmark.url` reduced by `sanitizeForLlm`, as sent; `members`: the other bookmarks
 *   of the removed folder that are in `loose`
 * @typedef {'existing-high' | 'existing-low' | 'new' | 'none' | 'invalid' | 'error'} Label
 * @typedef {{
 *   case: string, type: CaseType, repeat: number, label: Label,
 *   folderId?: string, folder?: string, name?: string, together?: string[], reason?: string,
 *   correct: boolean | null, latencyMs: number | null,
 * }} CallRecord
 */

/** The extension sends this effort on every Ctrl+D (platform/autosort.js). */
export const EXTENSION_EFFORT = 'low';
/** IA-12: the lower bound of `existing high` precision that allows moving without asking. */
export const TARGET_PRECISION = 0.95;
const Z = 1.96;
/** Ablation and loose cases each take at most this share of `--max-cases`; leave-one-out the rest. */
const SIDE_SHARE = 0.25;
/** A call is given more than the extension's deadline, so slow answers are measured, not lost. */
const CALL_TIMEOUT_MS = 60_000;
/** Answer size without reasoning, for the estimate only: M0 saw no reasoning at `low`. */
const ESTIMATED_OUTPUT_TOKENS = 60;
const ESTIMATED_LATENCY_MS = 3000;
/** Consecutive failed calls that stop a model: a bad key or a missing model fails every call. */
const MAX_CONSECUTIVE_ERRORS = 3;
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LABELS = /** @type {const} */ (['existing-high', 'existing-low', 'new', 'none']);

/**
 * Wilson score interval for a proportion.
 *
 * @param {number} successes may be fractional: a share of `n`
 * @param {number} n
 * @returns {{low: number, high: number}}
 */
export function wilson(successes, n) {
  if (!(n > 0)) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = Z * Z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/**
 * Folder path below its root, as `--exclude-folder` sees it in `run`.
 *
 * @param {Map<string, TreeNode>} byId
 * @param {TreeNode} folder
 */
function pathBelowRoot(byId, folder) {
  /** @type {string[]} */
  const titles = [];
  for (let node = folder; node.parentId !== undefined && node.folderType === undefined; node = /** @type {TreeNode} */ (byId.get(node.parentId))) {
    titles.unshift(node.title);
  }
  return cleanText(titles.join('/')).normalize('NFC');
}

/**
 * The folders whose path matches, as ids, and which patterns matched nothing.
 *
 * @param {TreeNode[]} tree
 * @param {RegExp[]} patterns
 */
export function excludedFolderIds(tree, patterns) {
  const byId = indexTree(tree);
  const folders = [...byId.values()].filter((node) => isFolder(node) && node.parentId !== undefined && node.folderType === undefined);
  const paths = folders.map((folder) => ({ id: folder.id, path: pathBelowRoot(byId, folder) }));
  return {
    ids: paths.filter(({ path }) => patterns.some((pattern) => pattern.test(path))).map(({ id }) => id),
    unmatched: patterns.filter((pattern) => !paths.some(({ path }) => pattern.test(path))),
  };
}

/**
 * Moves the given bookmarks to the end of `rootId`, the last one being the one "saved" now, and
 * removes `removeFolderId` if given. Works on a copy.
 *
 * @param {TreeNode[]} tree
 * @param {{moveIds: string[], rootId: string, removeFolderId?: string}} change
 */
function rearranged(tree, { moveIds, rootId, removeFolderId }) {
  const copy = /** @type {TreeNode[]} */ (structuredClone(tree));
  const byId = indexTree(copy);
  const moving = moveIds.map((id) => /** @type {TreeNode} */ (byId.get(id)));
  for (const node of moving) {
    const parent = /** @type {TreeNode} */ (byId.get(/** @type {string} */ (node.parentId)));
    parent.children = (parent.children ?? []).filter((child) => child.id !== node.id);
  }
  if (removeFolderId !== undefined) {
    const folder = /** @type {TreeNode} */ (byId.get(removeFolderId));
    const parent = /** @type {TreeNode} */ (byId.get(/** @type {string} */ (folder.parentId)));
    parent.children = (parent.children ?? []).filter((child) => child.id !== removeFolderId);
  }
  const root = /** @type {TreeNode} */ (byId.get(rootId));
  const newest = Math.max(0, ...[...byId.values()].map((node) => node.dateAdded ?? 0));
  for (const node of moving) {
    node.parentId = rootId;
    (root.children ??= []).push(node);
  }
  // The one saved now is the newest of the collection, as a Ctrl+D would make it.
  const saved = moving.at(-1);
  if (saved) saved.dateAdded = newest + 1000;
  /** @param {TreeNode} node */
  const renumber = (node) =>
    node.children?.forEach((child, index) => {
      child.index = index;
      renumber(child);
    });
  copy.forEach(renumber);
  return copy;
}

/**
 * What the extension would send for `bookmarkId` sitting in `parentId` of `tree`, or why it
 * would send nothing. Same order and same calls as `platform/autosort.js`.
 *
 * @param {TreeNode[]} tree
 * @param {string} bookmarkId
 * @param {{excludedIds: string[], context: 'full' | 'bookmark-only'}} options
 * @returns {{skip: string} | {bookmark: CheckCase['bookmark'], folders: CandidateFolder[], loose: LooseBookmark[], parentId: string}}
 */
export function contextFor(tree, bookmarkId, { excludedIds, context }) {
  const byId = indexTree(tree);
  const node = /** @type {TreeNode} */ (byId.get(bookmarkId));
  const excluded = excludedSet(tree, excludedIds);
  if (excluded.has(node.id)) return { skip: 'excluded-folder' };
  if ([...byId.values()].some((other) => other.id !== node.id && other.url !== undefined && other.url === node.url)) return { skip: 'duplicate-url' };
  const sanitized = sanitizeForLlm(node.url ?? '');
  if (!sanitized.sendable) return { skip: sanitized.reason };
  const full = context === 'full';
  const parentId = /** @type {string} */ (node.parentId);
  const { folders } = candidateFolders(tree, Boolean(node.syncing), { excluded, examples: full });
  const loose = full ? looseSiblings(tree, parentId, node.id, { excluded }) : [];
  return { bookmark: { id: node.id, title: node.title, url: sanitized.url }, folders, loose, parentId };
}

/**
 * Every case the export allows, then a seeded selection of at most `maxCases`.
 *
 * @param {{tree: TreeNode[], hasBar: boolean}} parsed
 * @param {{excludedIds: string[], context: 'full' | 'bookmark-only', seed: number, maxCases: number}} options
 * @returns {{cases: CheckCase[], available: Record<CaseType, number>, skipped: Record<string, number>}}
 */
export function buildCases({ tree, hasBar }, { excludedIds, context, seed, maxCases }) {
  const roots = rootsOf(tree);
  const saveRoot = /** @type {TreeNode} */ (roots.find((root) => root.folderType === (hasBar ? 'bookmarks-bar' : 'other')));
  const byId = indexTree(tree);
  const excluded = excludedSet(tree, excludedIds);
  const offered = new Set(candidateFolders(tree, false, { excluded }).folders.map((folder) => folder.id));
  /** @type {Record<string, number>} */
  const skipped = {};
  const skip = (/** @type {string} */ reason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  /** @type {Record<CaseType, CheckCase[]>} */
  const all = { loo: [], ablation: [], loose: [] };
  const options = { excludedIds, context };

  const bookmarks = [...byId.values()].filter((node) => !isFolder(node)).sort((a, b) => Number(a.id) - Number(b.id));
  for (const node of bookmarks) {
    const parent = /** @type {TreeNode} */ (byId.get(/** @type {string} */ (node.parentId)));
    if (parent.folderType !== undefined) {
      const found = contextFor(tree, node.id, options);
      if ('skip' in found) skip(`loose: ${found.skip}`);
      else all.loose.push({ id: `loose:${all.loose.length + 1}`, type: 'loose', ...found, expected: null });
      continue;
    }
    if (excluded.has(node.id)) {
      skip('loo: excluded-folder');
      continue;
    }
    const moved = rearranged(tree, { moveIds: [node.id], rootId: saveRoot.id });
    const found = contextFor(moved, node.id, options);
    if ('skip' in found) {
      skip(`loo: ${found.skip}`);
      continue;
    }
    const target = found.folders.find((folder) => folder.id === parent.id);
    if (!target) {
      // Deeper than two levels, masked or cut: the extension cannot answer it either.
      skip('loo: folder-not-offered');
      continue;
    }
    all.loo.push({ id: `loo:${all.loo.length + 1}`, type: 'loo', ...found, expected: { folderId: target.id, folderName: target.name } });
  }

  const folders = [...byId.values()].filter((node) => isFolder(node) && offered.has(node.id)).sort((a, b) => Number(a.id) - Number(b.id));
  for (const folder of folders) {
    /** @type {TreeNode[]} */
    const members = [];
    const pending = [...(folder.children ?? [])];
    while (pending.length > 0) {
      const node = /** @type {TreeNode} */ (pending.shift());
      if (isFolder(node)) pending.push(...(node.children ?? []));
      else members.push(node);
    }
    const usable = members.filter((member) => !excluded.has(member.id) && sanitizeForLlm(member.url ?? '').sendable);
    if (usable.length < 2) {
      skip('ablation: fewer than 2 sendable');
      continue;
    }
    const saved = seededShuffle(usable, seed + Number(folder.id))[0];
    // An excluded subfolder goes away with the folder: moved loose, its bookmarks would be sent.
    const order = [...members.filter((member) => member.id !== saved.id && !excluded.has(member.id)), saved].map((member) => member.id);
    const moved = rearranged(tree, { moveIds: order, rootId: saveRoot.id, removeFolderId: folder.id });
    const found = contextFor(moved, saved.id, options);
    if ('skip' in found) {
      skip(`ablation: ${found.skip}`);
      continue;
    }
    const inLoose = new Set(found.loose.map((item) => item.id));
    all.ablation.push({
      id: `ablation:${all.ablation.length + 1}`,
      type: 'ablation',
      ...found,
      expected: { removedFolder: cleanText(folder.title), members: members.filter((member) => member.id !== saved.id && inLoose.has(member.id)).map((member) => member.id) },
    });
  }

  const available = { loo: all.loo.length, ablation: all.ablation.length, loose: all.loose.length };
  const shuffled = {
    loo: seededShuffle(all.loo, seed),
    ablation: seededShuffle(all.ablation, seed + 1),
    loose: seededShuffle(all.loose, seed + 2),
  };
  const side = Math.ceil(maxCases * SIDE_SHARE);
  const take = { ablation: Math.min(side, available.ablation), loose: Math.min(side, available.loose), loo: 0 };
  take.loo = Math.min(available.loo, maxCases - take.ablation - take.loose);
  // Room the leave-one-out cases could not use goes back to the other two.
  for (const type of /** @type {const} */ (['ablation', 'loose'])) {
    take[type] = Math.min(available[type], take[type] + Math.max(0, maxCases - take.loo - take.ablation - take.loose));
  }
  const cases = /** @type {CaseType[]} */ (['loo', 'ablation', 'loose']).flatMap((type) => shuffled[type].slice(0, take[type]));
  return { cases, available, skipped };
}

/**
 * The answer as the extension reads it, and whether it is right for this case.
 *
 * @param {CheckCase} item
 * @param {import('../../extension/core/autosort.js').AutoSortAnswer} answer
 * @returns {Omit<CallRecord, 'case' | 'type' | 'repeat' | 'latencyMs'>}
 */
export function judge(item, answer) {
  /** @type {Omit<CallRecord, 'case' | 'type' | 'repeat' | 'latencyMs' | 'correct'>} */
  let read;
  if (answer.kind === 'existing') read = { label: answer.confidence === 'high' ? 'existing-high' : 'existing-low', folderId: answer.folder.id, folder: answer.folder.name };
  else if (answer.kind === 'new') read = { label: 'new', name: answer.name, together: answer.together.map((member) => member.id) };
  else read = { label: answer.reason === 'no-topic' ? 'none' : 'invalid', reason: answer.reason };

  if (item.type === 'loose' || item.expected === null) return { ...read, correct: null };
  if (item.type === 'loo') {
    const expected = /** @type {{folderId: string}} */ (item.expected);
    return { ...read, correct: read.folderId === expected.folderId };
  }
  return { ...read, correct: read.label === 'new' };
}

/** @param {Omit<CallRecord, 'case' | 'type' | 'repeat' | 'latencyMs' | 'correct'>} record */
const outcomeKey = (record) => `${record.label}:${record.folderId ?? (record.name === undefined ? '' : folderKey(record.name))}`;

/**
 * @param {number[]} values
 * @param {number} p
 */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/**
 * Every figure the report shows, from the calls of one model.
 *
 * @param {CheckCase[]} cases
 * @param {CallRecord[]} records
 */
export function summarize(cases, records) {
  const byCase = new Map(cases.map((item) => [item.id, item]));
  const scored = records.filter((record) => record.correct !== null);
  const answered = records.filter((record) => record.label !== 'error');

  const byLabel = Object.fromEntries(
    LABELS.map((label) => {
      const calls = scored.filter((record) => record.label === label);
      const correct = calls.filter((record) => record.correct).length;
      const distinct = new Set(calls.map((record) => record.case)).size;
      const precision = calls.length === 0 ? null : correct / calls.length;
      return [label, { calls: calls.length, correct, cases: distinct, precision, interval: precision === null ? null : wilson(precision * distinct, distinct) }];
    }),
  );

  /** @param {CaseType} type @param {(record: CallRecord) => boolean} test */
  const share = (type, test) => {
    const calls = records.filter((record) => record.type === type && record.label !== 'error');
    const hits = calls.filter(test).length;
    const distinct = new Set(calls.map((record) => record.case)).size;
    return { hits, calls: calls.length, cases: distinct, rate: calls.length === 0 ? null : hits / calls.length, interval: calls.length === 0 ? null : wilson((hits / calls.length) * distinct, distinct) };
  };

  // New folders, where one was removed: right kind, name, and which loose ones it gathers.
  const ablationNew = records.filter((record) => record.type === 'ablation' && record.label === 'new');
  let gathered = 0;
  let proposed = 0;
  let expectedMembers = 0;
  let sameName = 0;
  for (const record of ablationNew) {
    const expected = /** @type {{removedFolder: string, members: string[]}} */ (byCase.get(record.case)?.expected);
    const members = new Set(expected.members);
    const together = record.together ?? [];
    gathered += together.filter((id) => members.has(id)).length;
    proposed += together.length;
    expectedMembers += members.size;
    // By whole words, so that "IA" does not match inside "Inteligencia".
    const said = new Set(folderKey(record.name ?? '').split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const removed = new Set(folderKey(expected.removedFolder).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const within = (/** @type {Set<string>} */ a, /** @type {Set<string>} */ b) => a.size > 0 && [...a].every((word) => b.has(word));
    if (within(removed, said) || within(said, removed)) sameName += 1;
  }

  /** @type {Map<string, CallRecord[]>} */
  const perCase = new Map();
  for (const record of answered) perCase.set(record.case, [...(perCase.get(record.case) ?? []), record]);
  const repeated = [...perCase.values()].filter((calls) => calls.length > 1);
  const stable = repeated.filter((calls) => new Set(calls.map(outcomeKey)).size === 1).length;
  const unstableHigh = repeated.filter((calls) => calls.some((call) => call.label === 'existing-high') && new Set(calls.map(outcomeKey)).size > 1).map((calls) => calls[0].case);

  const latencies = records.flatMap((record) => (record.latencyMs === null ? [] : [record.latencyMs]));
  const high = byLabel['existing-high'];
  const low = byLabel['existing-low'];
  return {
    calls: records.length,
    errors: records.filter((record) => record.label === 'error').length,
    invalid: records.filter((record) => record.label === 'invalid').length,
    byLabel,
    calibration: { high: high.precision, low: low.precision, separated: high.interval !== null && low.interval !== null && high.interval.low > low.interval.high },
    forced: share('ablation', (record) => record.label === 'existing-high'),
    newWhenRemoved: share('ablation', (record) => record.label === 'new'),
    newWhenExisting: share('loo', (record) => record.label === 'new'),
    sameName: { hits: sameName, of: ablationNew.length },
    together: { precision: proposed === 0 ? null : gathered / proposed, recall: expectedMembers === 0 ? null : gathered / expectedMembers, proposed, expected: expectedMembers },
    stability: { stable, repeated: repeated.length, unstableHigh },
    latency: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.length === 0 ? 0 : Math.max(...latencies), overDeadline: latencies.filter((ms) => ms > DEADLINE_MS).length },
    loose: Object.fromEntries(['existing-high', 'existing-low', 'new', 'none', 'invalid'].map((label) => [label, records.filter((record) => record.type === 'loose' && record.label === label).length])),
    wrongHigh: scored.filter((record) => record.label === 'existing-high' && !record.correct).map((record) => record.case),
  };
}

/** @typedef {ReturnType<typeof summarize>} Summary */

export const RULE =
  `Activar el modo automático solo si (1) ninguna respuesta «existing high» fue incorrecta, ` +
  `(2) cada caso con «high» dio la misma respuesta en todas las repeticiones y (3) el límite inferior ` +
  `de Wilson al 95 % de la precisión de «high», con n = casos distintos, es de al menos ${Math.round(TARGET_PRECISION * 100)} % (IA-12). ` +
  `Si se cumplen (1) y (2) pero no (3), seguir confirmando y dejar que la extensión sugiera el automático ` +
  `con su regla (${SUGGEST_AUTOMATIC.accepted} aceptadas, como máximo ${SUGGEST_AUTOMATIC.corrected} corregida). Si falla (1) o (2), seguir confirmando.`;

/**
 * @param {Summary} summary
 * @returns {{decision: 'activate' | 'keep-confirming', line: string}}
 */
export function recommend(summary) {
  const high = summary.byLabel['existing-high'];
  const pct = (/** @type {number} */ ratio) => `${Math.round(ratio * 100)} %`;
  if (high.calls === 0) return { decision: 'keep-confirming', line: 'Seguir confirmando: ninguna respuesta fue «existing high», así que no hay nada que medir para el modo automático.' };
  if (summary.wrongHigh.length > 0) {
    return { decision: 'keep-confirming', line: `Seguir confirmando: ${summary.wrongHigh.length} de ${high.calls} respuestas «existing high» fueron incorrectas, y en modo automático cada una sería un movimiento equivocado sin aviso.` };
  }
  if (summary.stability.unstableHigh.length > 0) {
    const count = summary.stability.unstableHigh.length;
    return { decision: 'keep-confirming', line: `Seguir confirmando: ${count === 1 ? '1 caso con «high» cambió' : `${count} casos con «high» cambiaron`} de respuesta entre repeticiones, así que esa confianza no es estable.` };
  }
  const lower = /** @type {{low: number}} */ (high.interval).low;
  if (lower >= TARGET_PRECISION) return { decision: 'activate', line: `Activar el modo automático: ${high.correct} de ${high.calls} «high» correctos en ${high.cases} casos, con un límite inferior de ${pct(lower)}.` };
  const needed = Math.ceil((Z * Z * TARGET_PRECISION) / (1 - TARGET_PRECISION));
  return {
    decision: 'keep-confirming',
    line:
      `Seguir confirmando: ningún «high» falló (${high.correct} de ${high.calls}), pero con ${high.cases} casos el límite inferior es ${pct(lower)}, menor que ${pct(TARGET_PRECISION)}; ` +
      `harían falta al menos ${needed} casos «high» sin error. Deja que la extensión sugiera el automático con su regla.`,
  };
}

/** One decimal with a comma, as Spanish writes it. @param {number} value */
const decimal = (value) => value.toFixed(1).replace('.', ',');

/**
 * @param {number | null} ratio
 * @param {{low: number, high: number} | null} [interval]
 */
function percent(ratio, interval) {
  if (ratio === null) return '—';
  const text = `${decimal(ratio * 100)} %`;
  return interval ? `${text} [${decimal(interval.low * 100)}; ${decimal(interval.high * 100)}]` : text;
}

/**
 * @param {{model: string, summary: Summary, recommendation: ReturnType<typeof recommend>, status: string, stoppedBy: string | null}} result
 */
function modelLines({ model, summary, recommendation, status, stoppedBy }) {
  const { byLabel, calibration, forced, newWhenRemoved, newWhenExisting, sameName, together, stability, latency, loose } = summary;
  const names = { 'existing-high': '`existing high`', 'existing-low': '`existing low`', new: '`new`', none: '`none`' };
  const lines = [
    `## ${safeInline(model, 80)}`,
    '',
    `Estado: ${status}${stoppedBy ? ` (${safeInline(stoppedBy, 200)})` : ''}. Llamadas: ${summary.calls}; errores del proveedor: ${summary.errors}; respuestas inválidas, rechazadas o truncadas: ${summary.invalid}.`,
    '',
    '| Respuesta | Llamadas | Aciertos | Casos | Precisión [Wilson 95 %] |',
    '|---|---|---|---|---|',
    ...LABELS.map((label) => {
      const row = byLabel[label];
      return `| ${names[label]} | ${row.calls} | ${row.correct} | ${row.cases} | ${label === 'none' ? '— (nunca es lo esperado)' : percent(row.precision, row.interval)} |`;
    }),
    '',
    'Aciertos: en «dejar uno fuera», la carpeta de la que salió; en «quitar carpeta», proponer una nueva. El intervalo usa n = casos distintos, porque las repeticiones de un caso no son independientes.',
    '',
    `- **Calibración:** \`high\` acierta ${percent(calibration.high)} y \`low\` ${percent(calibration.low)}. ${
      calibration.high === null || calibration.low === null
        ? 'No hay datos de los dos niveles para compararlos.'
        : calibration.high > calibration.low
          ? calibration.separated
            ? '`high` acierta más que `low`, con intervalos separados.'
            : '`high` acierta más que `low`, pero los intervalos se solapan: no es concluyente.'
          : '`high` no acierta más que `low`: la confianza no informa.'
    }`,
    `- **Carpetas nuevas bien propuestas** (al quitar una carpeta): ${newWhenRemoved.hits} de ${newWhenRemoved.calls}, ${percent(newWhenRemoved.rate, newWhenRemoved.interval)}. Con las palabras del nombre de la carpeta quitada: ${sameName.hits} de ${sameName.of}. Sueltos reunidos: precisión ${percent(together.precision)}, exhaustividad ${percent(together.recall)} (${together.proposed} propuestos, ${together.expected} esperados).`,
    `- **Forzadas** (\`existing high\` cuando la carpeta se quitó): ${forced.hits} de ${forced.calls}, ${percent(forced.rate, forced.interval)}.`,
    `- **Carpetas de más** (\`new\` cuando la carpeta existía): ${newWhenExisting.hits} de ${newWhenExisting.calls}, ${percent(newWhenExisting.rate, newWhenExisting.interval)}.`,
    `- **Estabilidad:** ${stability.stable} de ${stability.repeated} casos repetidos dieron siempre la misma respuesta.${stability.unstableHigh.length > 0 ? ` Casos con \`high\` inestable: ${stability.unstableHigh.join(', ')}.` : ''}`,
    `- **Latencia:** p50 ${decimal(latency.p50 / 1000)} s, p95 ${decimal(latency.p95 / 1000)} s, máximo ${decimal(latency.max / 1000)} s. Por encima del plazo de la extensión (${DEADLINE_MS / 1000} s): ${latency.overDeadline}.`,
    `- **Sueltos reales** (sin respuesta esperada, para juzgar en la revisión): existing high ${loose['existing-high']}, existing low ${loose['existing-low']}, new ${loose.new}, none ${loose.none}, inválidas ${loose.invalid}.`,
    ...(summary.wrongHigh.length > 0 ? [`- **«high» incorrectos:** ${[...new Set(summary.wrongHigh)].join(', ')}.`] : []),
    '',
    `**Recomendación:** ${recommendation.line}`,
    '',
  ];
  return lines;
}

/**
 * @param {{
 *   startedAt: string, inputSha256: string, params: Record<string, unknown>, promptSha256: string,
 *   available: Record<CaseType, number>, selected: Record<CaseType, number>, skipped: Record<string, number>,
 *   results: {model: string, summary: Summary, recommendation: ReturnType<typeof recommend>, status: string, stoppedBy: string | null, spentUsd: number}[],
 * }} input
 */
export function renderCheckReport({ startedAt, inputSha256, params, promptSha256, available, selected, skipped, results }) {
  const skippedText = Object.entries(skipped).map(([reason, count]) => `${safeInline(reason, 60)}: ${count}`).join(', ') || 'ninguno';
  return [
    '# Medición IA-12 del orden con Ctrl+D',
    '',
    `Inicio: ${startedAt}. Export: \`${inputSha256.slice(0, 16)}…\`. Prompt y esquema de la extensión: \`${promptSha256.slice(0, 16)}…\`.`,
    `Parámetros: ${Object.entries(params).map(([key, value]) => `${key}=${safeInline(String(value), 80)}`).join(', ')}.`,
    '',
    `Casos disponibles: dejar uno fuera ${available.loo}, quitar carpeta ${available.ablation}, sueltos ${available.loose}. Elegidos: ${selected.loo}, ${selected.ablation} y ${selected.loose}. Omitidos: ${skippedText}.`,
    '',
    ...results.flatMap((result) => modelLines(result)),
    `**Regla:** ${RULE}`,
    '',
    'Límites: el export no distingue marcadores locales de los de la cuenta ni guarda «último uso», y Chrome junta «Otros» y «Celular». Cada caso guarda el marcador en la barra, como un Ctrl+D sin cambiar de carpeta.',
    '',
  ].join('\n');
}

/**
 * @param {{folders: CandidateFolder[], loose: LooseBookmark[], bookmark: CheckCase['bookmark']}} item
 * @param {number | undefined} reasoningAllowance
 */
const requestOf = (item, reasoningAllowance) =>
  buildAutoSortRequest({ bookmark: { title: item.bookmark.title, url: item.bookmark.url }, folders: item.folders, loose: item.loose, ...(reasoningAllowance === undefined ? {} : { reasoningAllowance }) });

/**
 * @param {import('./args.mjs').CheckOptions} options
 * @param {{env?: NodeJS.ProcessEnv}} [context]
 * @returns {Promise<number>} exit code: 0 done, 1 a model failed, 2 spending cap, 130 interrupted
 */
export async function runAutosortCheck(options, { env = process.env } = {}) {
  const startedAt = new Date().toISOString();
  const inputBytes = await readFile(options.input);
  const parsed = parseNetscapeTree(inputBytes.toString('utf8'));
  const { ids: excludedIds, unmatched } = excludedFolderIds(parsed.tree, options.excludePatterns);
  for (const pattern of unmatched) {
    const message = `--exclude-folder ${JSON.stringify(pattern.source)} matches no folder, so it excludes nothing. Check it for a typo.`;
    if (!options.dryRun) throw new UsageError(`${message} Nothing was sent.`);
    console.log(`Aviso: ${message}`);
  }
  const { cases, available, skipped } = buildCases(parsed, { excludedIds, context: options.context, seed: options.seed, maxCases: options.maxCases });
  if (cases.length === 0) throw new Error(`No case can be built from ${options.input}: it needs sendable bookmarks inside folders or loose in a root.`);
  const selected = { loo: 0, ablation: 0, loose: 0 };
  for (const item of cases) selected[item.type] += 1;

  const models = options.models.map((ref) => resolveModel(ref, options, env));
  const secrets = models.map((model) => model.apiKey);
  const log = (/** @type {string} */ line) => console.error(redact(line, secrets));
  if (!options.dryRun) for (const model of models) assertKeyShape(model);

  const providers = [...new Map(models.map((model) => [model.provider.id, model.provider])).values()];
  for (const provider of providers) for (const line of describeDataPolicy(provider)) console.log(line);
  const needConsent = providers.filter((provider) => requiresTrainingConsent(provider) && !options.acceptedPolicies.includes(provider.id));
  if (needConsent.length > 0) {
    const message = `The data policy of ${needConsent.map((provider) => provider.id).join(', ')} needs your explicit consent: add ${needConsent.map((provider) => `--accept-data-policy ${provider.id}`).join(' ')}.`;
    if (!options.dryRun) throw new Error(message);
    console.log(`Dry run: ${message}`);
  }
  if (options.effort !== EXTENSION_EFFORT) console.log(`Nota: la extensión envía el esfuerzo «${EXTENSION_EFFORT}»; esta medición usa «${options.effort}» y mide otra cosa.`);
  if (options.context !== 'full') console.log('Nota: contexto «solo el marcador», como el ajuste de la extensión: sin ejemplos ni sueltos, así que no hay carpetas nuevas con compañeros.');

  const { dir } = await createRunDir(options.out ?? join(PROJECT_ROOT, 'eval-out', `autosort-${startedAt.replaceAll(':', '-')}`));
  // What would leave, request by request; the system prompt and the schema are the same for all.
  await writeNew(join(dir, 'requests-preview.jsonl'), `${cases.map((item) => JSON.stringify({ case: item.id, type: item.type, user: requestOf(item, undefined).user })).join('\n')}\n`);

  const sample = requestOf(cases[0], undefined);
  const promptSha256 = promptHash({ system: sample.system, schema: sample.schema });
  const calls = cases.length * options.repeat;
  const inputTokens = cases.reduce((sum, item) => {
    const request = requestOf(item, undefined);
    return sum + estimateTokens(request.system + request.user + JSON.stringify(request.schema));
  }, 0) * options.repeat;
  const outputTokens = calls * ESTIMATED_OUTPUT_TOKENS;
  const minutes = (calls * (options.pauseMs + ESTIMATED_LATENCY_MS)) / 60_000;

  const params = { models: options.models.join(','), repeat: options.repeat, max_cases: options.maxCases, seed: options.seed, effort: options.effort, context: options.context, pause_ms: options.pauseMs, max_usd: options.maxUsd, exclude_folder: options.excludeFolder?.source ?? null, dry_run: options.dryRun };
  const manifest = {
    schema: 'bookmark-genie/autosort-check@1',
    started_at: startedAt,
    tool: await describeTool(),
    input_sha256: sha256(inputBytes),
    prompt_sha256: promptSha256,
    params,
    cases: { available, selected, skipped },
    models: models.map((model) => ({ ref: model.ref, endpoint: model.baseURL, key_suffix: keySuffix(model.apiKey), effort: model.effort, data_policy: model.provider.dataPolicy })),
    status: 'running',
    results: /** @type {any[]} */ ([]),
  };
  await writeAtomic(join(dir, 'check-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Casos: dejar uno fuera ${selected.loo} de ${available.loo}, quitar carpeta ${selected.ablation} de ${available.ablation}, sueltos ${selected.loose} de ${available.loose}. Repeticiones: ${options.repeat}. Llamadas: ${calls} por modelo.`);
  console.log(`Tokens estimados, sin razonamiento: ${inputTokens} de entrada y ${outputTokens} de salida por modelo.`);
  for (const model of models) console.log(`  ${model.ref}: unos ${formatUsd(costOf(model.entry.id, inputTokens, outputTokens, budgetPrices()))} a tarifa de pago (gratis en un plan gratuito); unos ${Math.ceil(minutes)} min con pausas de ${options.pauseMs / 1000} s.`);
  console.log(`Tope de gasto: ${formatUsd(options.maxUsd)}. Lo que saldría, petición por petición: ${join(dir, 'requests-preview.jsonl')}`);
  for (const model of models) console.log(`Destino: ${model.ref} -> ${model.baseURL}${keySuffix(model.apiKey) ? ` (clave terminada en ${keySuffix(model.apiKey)})` : ''}`);

  if (options.dryRun) {
    manifest.status = 'complete';
    await writeAtomic(join(dir, 'check-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log('Dry run: nothing was sent.');
    return 0;
  }

  const budget = createBudget(options.maxUsd);
  const controller = new AbortController();
  const received = { name: /** @type {string | null} */ (null) };
  const stopListening = listenForSignals(controller, received);
  /** @type {Promise<never>} */
  const interruption = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new InterruptedError('interrupted')), { once: true });
  });
  interruption.catch(() => {});

  /** @type {{model: string, summary: Summary, recommendation: ReturnType<typeof recommend>, status: string, stoppedBy: string | null, spentUsd: number}[]} */
  const results = [];
  let exitCode = 0;
  try {
    for (const model of models) {
      if (exitCode === 2 || exitCode === 130) break;
      const stem = modelFileStem(model.ref);
      const answersPath = join(dir, `answers-${stem}.jsonl`);
      const raw = createComplete({ ref: model.ref, apiKey: model.apiKey, baseURL: model.baseOverride, effort: options.effort, timeoutMs: CALL_TIMEOUT_MS });
      const { complete } = instrument(raw, { ref: model.ref, model: model.entry.id, budget, mayFallback: false, signal: controller.signal, interruption, log });
      // Only a different effort changes the room for reasoning; at `low` the request is the extension's own.
      const allowance = options.effort === EXTENSION_EFFORT ? undefined : model.reasoningAllowance;
      const spentBefore = budget.spentUsd;
      /** @type {CallRecord[]} */
      const records = [];
      let status = 'complete';
      /** @type {string | null} */
      let stoppedBy = null;
      let consecutiveErrors = 0;
      console.error(`Midiendo ${model.ref}`);

      try {
        outer: for (const item of cases) {
          for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
            if (records.length > 0 && options.pauseMs > 0) {
              try {
                await sleep(options.pauseMs, undefined, { signal: controller.signal });
              } catch {
                throw new InterruptedError('interrupted');
              }
            }
            /** @type {CallRecord} */
            let record;
            try {
              const result = await complete(requestOf(item, allowance));
              const answer = readAutoSortAnswer(result, { folders: item.folders, loose: item.loose, parentId: item.parentId });
              record = { case: item.id, type: item.type, repeat, ...judge(item, answer), latencyMs: result.latencyMs };
              consecutiveErrors = 0;
            } catch (error) {
              if (error instanceof InterruptedError || error instanceof BudgetExceededError) throw error;
              consecutiveErrors += 1;
              record = { case: item.id, type: item.type, repeat, label: 'error', reason: redact(/** @type {Error} */ (error).message, secrets).slice(0, 200), correct: null, latencyMs: null };
            }
            records.push(record);
            await appendLine(answersPath, JSON.stringify(record));
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              status = 'stopped';
              stoppedBy = `${MAX_CONSECUTIVE_ERRORS} failed calls in a row; the last: ${record.reason}`;
              exitCode = Math.max(exitCode, 1);
              break outer;
            }
          }
          log(`  ${model.ref}: ${records.length}/${calls} (${formatUsd(budget.spentUsd)} spent)`);
        }
      } catch (error) {
        // What was paid for is still reported; only the rest of the run stops.
        if (error instanceof InterruptedError) {
          exitCode = 130;
          stoppedBy = `interrupted by ${received.name ?? 'a signal'}; a call in flight may still be billed`;
        } else if (error instanceof BudgetExceededError) {
          exitCode = 2;
          stoppedBy = redact(error.message, secrets);
        } else {
          throw error;
        }
        status = 'stopped';
        console.error(stoppedBy);
      }

      const summary = summarize(cases, records);
      const recommendation = recommend(summary);
      results.push({ model: model.ref, summary, recommendation, status, stoppedBy, spentUsd: budget.spentUsd - spentBefore });
      await writeReview(dir, stem, cases, records);
    }
  } finally {
    stopListening();
    console.log(`Gasto total: ${formatUsd(budget.spentUsd)} a tarifa de pago${budget.lostUsd > 0 ? ` (${formatUsd(budget.lostUsd)} en llamadas sin respuesta útil)` : ''}.`);
  }

  const reportPath = join(dir, 'report.md');
  await writeNew(reportPath, renderCheckReport({ startedAt, inputSha256: manifest.input_sha256, params, promptSha256, available, selected, skipped, results }));
  manifest.status = exitCode === 0 ? 'complete' : 'stopped';
  manifest.results = results.map(({ model, recommendation, status, stoppedBy, spentUsd, summary }) => ({ model, status, stopped_by: stoppedBy, spent_usd: spentUsd, decision: recommendation.decision, calls: summary.calls, errors: summary.errors }));
  await writeAtomic(join(dir, 'check-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const result of results) {
    for (const line of modelLines(result)) if (line !== '') console.log(line);
  }
  console.log(`Regla: ${RULE}`);
  console.log(`Informe: ${reportPath}`);
  return exitCode;
}

/**
 * One row per case for the person to judge: the name of a new folder, and the loose ones.
 *
 * @param {string} dir
 * @param {string} stem
 * @param {CheckCase[]} cases
 * @param {CallRecord[]} records
 */
async function writeReview(dir, stem, cases, records) {
  const rows = cases.map((item) => {
    const answers = records
      .filter((record) => record.case === item.id)
      .map((record) => `${record.label}${record.folder ? ` → ${record.folder}` : ''}${record.name ? ` «${record.name}» +${record.together?.length ?? 0}` : ''}${record.correct === false ? ' ✗' : record.correct ? ' ✓' : ''}`)
      .join(' | ');
    const expected = item.expected === null ? '' : 'folderName' in item.expected ? `existing → ${item.expected.folderName}` : `new (se quitó «${item.expected.removedFolder}», compañeros: ${item.expected.members.length})`;
    return ['', item.id, item.type, cleanTitle(item.bookmark.title), item.bookmark.url, expected, answers];
  });
  await writeNew(join(dir, `review-${stem}.csv`), toCsv(['judgment', 'case', 'type', 'title', 'url', 'expected', 'answers'], rows));
}
