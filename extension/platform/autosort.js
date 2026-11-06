/**
 * Automatic sort of a bookmark saved with Ctrl+D. Off by default, and in «Confirmar antes de
 * mover» by default once on: then every answer becomes a proposal the person confirms. It acts on
 * `onCreated` only when the bookmark is a URL saved directly in a root (bar, other, mobile), no
 * import is running, and the URL is the active tab's: that leaves out bookmarks that arrive by
 * sync, by import, from other extensions, or saved into a folder the person chose (including a
 * Ctrl+Shift+D group). A folder the extension creates is a folder, so its `onCreated` is ignored.
 *
 * It then waits about 8 s, because the Ctrl+D dialog has already created the bookmark and the
 * person may still pick a folder there. A plain timer is enough: the worker stops "after 30
 * seconds of inactivity", and "events and calls to extension APIs reset these timers"
 * (https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
 * The event has just reset it, so 8 s fit. Alarms do not, since their minimum is 30 s. If the
 * worker stops anyway (the browser closes), the timer is lost and the bookmark stays put.
 *
 * The bookmark is classified within 20 s overall (the worker is stopped "when a fetch() response
 * takes more than 30 seconds to arrive"). A URL the person already has is not sent: it is logged
 * as a duplicate. A 429 is not retried: on a free plan it means a per-minute or per-day quota.
 * Only a 5xx, 408 or 409 gets one more call, if time is left. Errors are sorted into the
 * categories the pages explain, and flag the badge.
 *
 * @typedef {import('../core/tree.js').TreeNode} TreeNode
 * @typedef {import('../core/types.js').Complete} Complete
 * @typedef {import('../core/autosort.js').AutoSortSettings} AutoSortSettings
 * @typedef {import('./settings.js').LogEvent} LogEvent
 * @typedef {{kind: 'ignored', reason: string}} Ignored
 * @typedef {{
 *   bookmarks: import('./bookmarks.js').BookmarksApi,
 *   tabs: {query(query: {active: boolean, lastFocusedWindow: boolean}): Promise<{url?: string, pendingUrl?: string}[]>},
 *   permissions: {contains(permissions: {permissions: string[], origins: string[]}): Promise<boolean>},
 *   storage: chrome.storage.StorageArea,
 *   action?: {setBadgeText(details: {text: string}): Promise<void>, setBadgeBackgroundColor(details: {color: string}): Promise<void>},
 *   createComplete?: (options: {ref: string, apiKey: string, timeoutMs: number, effort: string}) => Complete,
 *   now?: () => Date,
 *   wait?: (ms: number) => Promise<void>,
 *   schedule?: (callback: () => void, ms: number) => void,
 *   delayMs?: number,
 *   deadlineMs?: number,
 *   locks?: LockManager | null,
 * }} Dependencies
 */

import {
  DAILY_USD_CAP,
  DEADLINE_MS,
  WAIT_MS,
  buildAutoSortRequest,
  candidateFolders,
  consentCovers,
  dayKey,
  describeForLog,
  errorCategory,
  errorText,
  excludedSet,
  reasonText,
  looseSiblings,
  readAutoSortAnswer,
  resolveExclusions,
} from '../core/autosort.js';
import { estimateTokens, makeBatches } from '../core/batching.js';
import { classifyBatch } from '../core/classify.js';
import { cleanText, cleanTitle, cutText } from '../core/prompt.js';
import { BATCH_SIZE, classificationFolders, estimatedCalls, groupAssignments, looseToSort, taxonomySample } from '../core/sort-loose.js';
import { proposeTaxonomy, suggestFolderCount } from '../core/taxonomy.js';
import { createBudget, withBudget, worstCaseUsd } from '../core/budget.js';
import { budgetPrices, findModel, parseModelRef } from '../core/models.js';
import { indexTree, isFolder, isRoot } from '../core/tree.js';
import { sanitizeForLlm } from '../core/url.js';
import { applyPlan } from './bookmarks.js';
import { createComplete as createProviderComplete } from './complete-factory.js';
import { RetryLaterError } from './llm.js';
import { createProposals } from './proposals.js';
import { getProvider, requiresTrainingConsent } from './providers.js';
import { createSettingsStore, hostPermissionFor, permissionsFor } from './settings.js';
import { createStore } from './store.js';

/** M0 measured Gemini at this level with 0 reasoning tokens; a model without levels gets none. */
const EFFORT = 'low';
const RETRY_PAUSE_MS = 1500;
/** A retry needs at least this much of the deadline left to be worth a call. */
const MIN_RETRY_WINDOW_MS = 5000;
const BADGE_MS = 15_000;
const MAX_MESSAGE_LENGTH = 200;
const MAX_PREVIEW_TITLES = 10;

/** Reasons that block every Ctrl+D until the person acts: they flag the badge like an error. */
const BLOCKING = /** @type {Record<string, import('../core/autosort.js').ErrorCategory>} */ ({
  'no-permission': 'permission',
  'no-key': 'no-key',
  'daily-calls': 'daily-cap',
  'daily-budget': 'daily-cap',
});

/**
 * Rejects with a timeout if `promise` takes longer than `ms`; the budget then charges the worst
 * case, because the request may have been billed.
 *
 * @param {Complete} complete
 * @param {number} ms
 * @returns {Complete}
 */
function withDeadline(complete, ms) {
  return (request) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RetryLaterError(`No answer within ${Math.round(ms / 1000)} s`, null, { timedOut: true })), ms);
      complete(request).then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

/**
 * Only a server failure or a conflict is worth a second call; a 429 is a quota, and a timeout
 * may have been billed already.
 *
 * @param {unknown} error
 */
function isRetryable(error) {
  if (!(error instanceof RetryLaterError) || error.timedOut) return false;
  const status = error.status;
  return status === null || status === 408 || status === 409 || (status >= 500 && status !== 501);
}

/** @param {Dependencies} dependencies */
export function createAutoSorter({
  bookmarks,
  tabs,
  permissions,
  storage,
  action,
  createComplete = createProviderComplete,
  now = () => new Date(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule = (callback, ms) => void setTimeout(callback, ms),
  delayMs = WAIT_MS,
  deadlineMs = DEADLINE_MS,
  locks,
}) {
  const lockOptions = locks === undefined ? {} : { locks };
  const settingsStore = createSettingsStore(storage, lockOptions);
  const store = createStore(storage, lockOptions);
  const proposals = createProposals({ storage, bookmarks, action, now, locks });
  let importing = false;
  let sequence = 0;

  /** @param {string} id */
  const lookUp = async (id) => {
    try {
      return (await bookmarks.get(id))[0];
    } catch {
      return undefined;
    }
  };

  /**
   * @param {LogEvent['kind']} kind
   * @param {{id?: string, title: string, url?: string}} node
   * @param {Partial<Omit<LogEvent, 'id' | 'at' | 'kind' | 'title' | 'host'>>} details
   * @returns {Promise<LogEvent>}
   */
  const record = async (kind, node, details) => {
    const at = now().toISOString();
    /** @type {LogEvent} */
    const event = { id: `log:${at}:${(sequence += 1)}`, at, kind, ...describeForLog(node) };
    if (node.id) event.bookmarkId = node.id;
    for (const [key, value] of Object.entries(details)) if (value !== undefined && value !== '' && value !== false) /** @type {any} */ (event)[key] = value;
    await settingsStore.appendLog(event);
    const category = event.category ?? (event.reason ? BLOCKING[event.reason] : undefined);
    if (kind === 'error' || category) {
      if (category && !event.category) event.category = category;
      await settingsStore.noteError(event.category ?? 'server', at);
      await proposals.showCount();
    }
    return event;
  };

  const flashBadge = async () => {
    await proposals.flashMoved();
    schedule(() => void proposals.showCount().catch(() => {}), BADGE_MS);
  };

  /**
   * One call, and one more for a server failure while time is left. Each call is reserved against
   * the daily cap before it is sent, and given back if it could not have been billed: a 4xx, a
   * 429, or a failure before sending. `onSend` runs once, right before the first call leaves.
   *
   * @param {import('../core/types.js').CompletionRequest} request
   * @param {{ref: string, model: string, apiKey: string, maxCalls: number, onSend?: () => Promise<void>}} options
   * @returns {Promise<{result: import('../core/types.js').CompletionResult, ms: number} | {kind: 'left' | 'error', reason: string, category?: import('../core/autosort.js').ErrorCategory, detail?: string, ms?: number}>}
   */
  async function classify(request, { ref, model, apiKey, maxCalls, onSend }) {
    const started = Date.now();
    const deadline = started + deadlineMs;
    const prices = budgetPrices();
    for (let attempt = 1; ; attempt += 1) {
      const day = dayKey(now());
      const reserved = await settingsStore.updateUsage(day, (usage) => {
        if (usage.calls >= maxCalls) return { usage: null, result: 'daily-calls' };
        if (usage.spentUsd + worstCaseUsd(request, { model, estimateTokens, prices }) > DAILY_USD_CAP) return { usage: null, result: 'daily-budget' };
        return { usage: { ...usage, calls: usage.calls + 1 }, result: null };
      });
      if (reserved) return { kind: 'left', reason: reserved, category: 'daily-cap' };

      if (attempt === 1) await onSend?.();
      const remaining = Math.max(1, deadline - Date.now());
      const budget = createBudget(DAILY_USD_CAP);
      const complete = withBudget(withDeadline(createComplete({ ref, apiKey, timeoutMs: remaining, effort: EFFORT }), remaining), { model, budget, estimateTokens, prices });
      let billable = true;
      try {
        const result = await complete(request);
        return { result, ms: Date.now() - started };
      } catch (error) {
        const failure = /** @type {{message?: unknown, mayHaveBilled?: unknown, timedOut?: unknown}} */ (error);
        billable = failure?.mayHaveBilled === true || failure?.timedOut === true;
        const canRetry = isRetryable(error) && attempt === 1 && deadline - Date.now() - RETRY_PAUSE_MS >= MIN_RETRY_WINDOW_MS;
        if (!canRetry) {
          const detail = String(failure?.message ?? error).replaceAll(apiKey, '[key]').slice(0, MAX_MESSAGE_LENGTH);
          const category = errorCategory(error);
          return { kind: 'error', reason: category === 'timeout' ? 'timeout' : 'error', category, detail, ms: Date.now() - started };
        }
        await wait(RETRY_PAUSE_MS);
      } finally {
        await settingsStore.updateUsage(day, (usage) => ({
          usage: { ...usage, calls: billable ? usage.calls : Math.max(0, usage.calls - 1), spentUsd: usage.spentUsd + budget.spentUsd, lostUsd: usage.lostUsd + budget.lostUsd },
          result: null,
        }));
      }
    }
  }

  /**
   * @param {string} id
   * @param {TreeNode} created the node as `onCreated` delivered it, or as it is now
   * @param {{fromEvent: boolean, duringImport: boolean}} how
   * @returns {Promise<LogEvent | Ignored>}
   */
  async function sort(id, created, { fromEvent, duringImport }) {
    const settings = await settingsStore.readSettings();
    if (fromEvent && !settings.enabled) return { kind: 'ignored', reason: 'disabled' };
    if (created.url === undefined) return { kind: 'ignored', reason: 'folder' };
    if (fromEvent && duringImport) return { kind: 'ignored', reason: 'import' };

    const { provider: providerId } = parseModelRef(settings.ref);
    let provider;
    try {
      provider = getProvider(providerId);
    } catch {
      return record('left', created, { reason: 'unknown-model' });
    }
    if (!(await permissions.contains(permissionsFor(provider)))) return record('left', created, { reason: 'no-permission' });
    if (fromEvent) {
      const active = await tabs.query({ active: true, lastFocusedWindow: true });
      if (!active.some((tab) => tab.url === created.url || tab.pendingUrl === created.url)) return { kind: 'ignored', reason: 'not-active-tab' };
    }

    if (fromEvent) {
      const parent = created.parentId === undefined ? undefined : await lookUp(created.parentId);
      if (!parent || !isRoot(parent)) return record('left', created, { reason: 'saved-in-folder' });
    }
    const entry = findModel(settings.ref);
    if (!entry) return record('left', created, { reason: 'unknown-model' });
    if (provider.adapter === 'anthropic-sdk') return record('left', created, { reason: 'provider-pending' });
    const apiKey = await settingsStore.readKey(provider.id);
    if (!apiKey) return record('left', created, { reason: 'no-key' });
    if (requiresTrainingConsent(provider) && !consentCovers(settings.consent, provider)) return record('left', created, { reason: 'no-consent' });

    if (fromEvent) await wait(delayMs);
    const node = await lookUp(id);
    if (!node) return record('left', created, { reason: 'gone' });
    if (fromEvent && node.parentId !== created.parentId) return record('left', node, { reason: 'chosen-by-person' });

    const tree = await bookmarks.getTree();
    const byId = indexTree(tree);
    const parentId = /** @type {string} */ (node.parentId);
    const excluded = excludedSet(tree, resolveExclusions(tree, settings).ids);
    if (excluded.has(node.id)) return record('left', node, { reason: 'excluded-folder' });
    const twin = [...byId.values()].find((other) => other.id !== node.id && other.url !== undefined && other.url === node.url);
    if (twin) {
      const where = twin.parentId === undefined ? undefined : byId.get(twin.parentId);
      return record('duplicate', node, { reason: 'duplicate', folder: where?.title, duplicateOf: twin.id });
    }
    const sanitized = sanitizeForLlm(node.url ?? '');
    if (!sanitized.sendable) return record('left', node, { reason: sanitized.reason });

    const full = settings.contextMode === 'full';
    const { folders, truncated } = candidateFolders(tree, Boolean(node.syncing), { excluded, examples: full });
    const loose = full ? looseSiblings(tree, parentId, node.id, { excluded }) : [];
    const request = buildAutoSortRequest({ bookmark: { title: node.title, url: sanitized.url }, folders, loose });
    const examples = folders.flatMap((folder) => folder.examples);
    const hostOf = (/** @type {string} */ reduced) => reduced.split('/')[0];
    // Written only once the call is reserved and about to leave: what it lists is what was sent.
    const onSend = () =>
      settingsStore.saveLastSent({
        at: now().toISOString(),
        folders: folders.length,
        examples: examples.length,
        loose: loose.length,
        truncatedFolders: truncated,
        chars: request.user.length,
        titles: [cleanTitle(node.title), ...loose.map((item) => item.title), ...examples].slice(0, MAX_PREVIEW_TITLES),
        sent: {
          bookmark: { title: cleanTitle(node.title), host: hostOf(sanitized.url) },
          folders: folders.map((folder) => ({ name: folder.name, examples: [...folder.examples] })),
          loose: loose.map((item) => ({ title: item.title, host: hostOf(item.url) })),
        },
      });
    const truncation = truncated > 0 ? { sent: folders.length, total: folders.length + truncated } : undefined;

    const outcome = await classify(request, { ref: settings.ref, model: entry.id, apiKey, maxCalls: settings.maxCallsPerDay, onSend });
    if (!('result' in outcome)) return record(outcome.kind, node, { ...outcome, truncation: outcome.category === 'daily-cap' ? undefined : truncation });
    const { ms } = outcome;
    const answer = readAutoSortAnswer(outcome.result, { folders, loose, parentId });
    if (answer.kind === 'left') return record('left', node, { reason: answer.reason, ms, truncation });

    /** @param {string} memberId */
    const proposed = (memberId) => {
      const member = /** @type {TreeNode} */ (byId.get(memberId) ?? node);
      return { id: member.id, title: member.title, host: describeForLog(member).host, parentId, index: /** @type {number} */ (member.index) };
    };
    const createdAt = now().toISOString();
    const base = { id: `proposal:${createdAt}:${node.id}`, createdAt, bookmark: { ...proposed(node.id), index: /** @type {number} */ (node.index) } };
    /** @param {Awaited<ReturnType<typeof proposals.add>>} added */
    const logDropped = async (added) => {
      for (const dropped of added.dropped) {
        await record('expired', dropped.bookmark, { reason: 'dropped', folder: dropped.newFolder?.name ?? dropped.folder?.name });
        await settingsStore.bumpMetric('expired', now());
      }
    };

    if (answer.kind === 'new') {
      const added = await proposals.add({
        ...base,
        kind: 'create',
        confidence: 'high',
        newFolder: { parentId, parentTitle: byId.get(parentId)?.title ?? '', name: answer.name, description: answer.description },
        together: answer.together.map((member) => proposed(member.id)),
      });
      await logDropped(added);
      return record('proposed', node, { folder: answer.name, newFolder: true, ms, truncation });
    }
    if (answer.folder.id === parentId) return record('left', node, { reason: 'already-there', folder: answer.folder.name, ms, truncation });
    if (answer.confidence === 'low' || settings.confirmBeforeMove) {
      const reason = answer.confidence === 'low' ? 'low-confidence' : 'confirm-mode';
      const added = await proposals.add({ ...base, kind: 'move', confidence: answer.confidence, reason, folder: { id: answer.folder.id, name: answer.folder.name }, together: [] });
      await logDropped(added);
      return record('proposed', node, { folder: answer.folder.name, reason, ms, truncation });
    }

    const result = await applyPlan([{ id: node.id, from: { parentId, index: /** @type {number} */ (node.index) }, to: { parentId: answer.folder.id } }], {
      bookmarks,
      store,
      now,
      kind: 'sort',
      label: `«${describeForLog(node).title}» → ${answer.folder.name}`,
    });
    const [skipped] = result.skipped;
    if (skipped) {
      const reason = skipped.reason === 'moved' ? 'chosen-by-person' : skipped.reason === 'missing' ? 'gone' : skipped.reason;
      return record(skipped.reason === 'error' ? 'error' : 'left', node, { reason, detail: skipped.message, folder: answer.folder.name, ms, truncation });
    }
    await settingsStore.bumpMetric('moved', now());
    await settingsStore.bumpMetric('filed', now());
    await flashBadge();
    return record('moved', node, { folder: answer.folder.name, changeId: result.changeId ?? undefined, ms, truncation });
  }

  /**
   * @param {string} id
   * @param {TreeNode} created
   * @param {{fromEvent: boolean, duringImport: boolean}} how
   * @returns {Promise<LogEvent | Ignored>}
   */
  const safely = async (id, created, how) => {
    try {
      return await sort(id, created, how);
    } catch (error) {
      const detail = String(/** @type {Error} */ (error)?.message ?? error).slice(0, MAX_MESSAGE_LENGTH);
      return record('error', created, { reason: 'error', category: 'server', detail }).catch(() => ({ kind: /** @type {const} */ ('ignored'), reason: 'error' }));
    }
  };

  const api = {
    proposals,
    settings: settingsStore,
    journal: store,

    /** Drops proposals whose bookmark the person moved or deleted; for onMoved and onRemoved. */
    prune: () => proposals.prune().then(
      () => undefined,
      () => undefined,
    ),

    /** Drops expired proposals, logging each one; at start-up. */
    async expire() {
      try {
        for (const proposal of await proposals.expire()) {
          await record('expired', proposal.bookmark, { reason: 'expired', folder: proposal.newFolder?.name ?? proposal.folder?.name });
          await settingsStore.bumpMetric('expired', now());
        }
      } catch {
        // Retried at the next start-up.
      }
    },

    importBegan() {
      importing = true;
    },
    importEnded() {
      importing = false;
    },

    /**
     * Never rejects: a failure becomes an `error` event in the log.
     *
     * @param {string} id
     * @param {TreeNode} created
     */
    handleCreated(id, created) {
      return safely(id, created, { fromEvent: true, duringImport: importing });
    },

    /**
     * Classifies a bookmark again, as it is now: no active-tab check, no wait, and wherever it
     * is. Counts against the daily cap and follows the mode, like Ctrl+D.
     *
     * @param {string} bookmarkId
     * @returns {Promise<LogEvent | Ignored>}
     */
    async reclassify(bookmarkId) {
      const node = await lookUp(bookmarkId);
      if (!node) return record('left', { id: bookmarkId, title: '' }, { reason: 'gone' });
      return safely(bookmarkId, node, { fromEvent: false, duringImport: false });
    },

    /**
     * «Elegir carpeta»: moves a bookmark where the person says, through the journal. Counts as a
     * correction when the last thing the sort did to it was a move.
     *
     * @param {string} bookmarkId
     * @param {string} folderId
     */
    async moveTo(bookmarkId, folderId) {
      const node = await lookUp(bookmarkId);
      const folder = await lookUp(folderId);
      if (!node || !folder) return { changeId: null, skipped: [{ id: node ? folderId : bookmarkId, reason: 'missing' }] };
      const result = await applyPlan([{ id: node.id, from: { parentId: /** @type {string} */ (node.parentId), index: /** @type {number} */ (node.index) }, to: { parentId: folderId } }], {
        bookmarks,
        store,
        now,
        kind: 'manual',
        label: `«${describeForLog(node).title}» → ${folder.title}`,
      });
      const last = (await settingsStore.readLog()).find((event) => event.bookmarkId === bookmarkId);
      if (result.done.length > 0 && last?.kind === 'moved') await settingsStore.bumpMetric('corrected', now());
      if (result.done.length > 0) await settingsStore.bumpMetric('filed', now(), result.done.length);
      return { changeId: result.changeId, skipped: result.skipped };
    },

    /**
     * «Quitar el duplicado nuevo»: removes this bookmark only if another with its URL still exists.
     *
     * @param {string} bookmarkId
     * @returns {Promise<{removed: boolean, reason?: 'gone' | 'not-duplicate'}>}
     */
    async removeDuplicate(bookmarkId) {
      const node = await lookUp(bookmarkId);
      if (!node || node.url === undefined) return { removed: false, reason: 'gone' };
      const others = [...indexTree(await bookmarks.getTree()).values()].filter((other) => other.id !== node.id && other.url === node.url);
      if (others.length === 0) return { removed: false, reason: 'not-duplicate' };
      await bookmarks.remove(node.id);
      return { removed: true };
    },

    /**
     * «Probar la clave»: one minimal call with a fixed test bookmark, nothing of the person's.
     * It counts against the daily cap if it could have been billed.
     *
     * @returns {Promise<{ok: boolean, category?: import('../core/autosort.js').ErrorCategory, messageEs: string, ms?: number, servedModel?: string}>}
     */
    /**
     * What «Ordenar sueltos» would send for this folder, without sending anything: the
     * confirmation shows it, and it is what the person agrees to.
     *
     * @param {string} folderId
     */
    async previewLoose(folderId) {
      const settings = await settingsStore.readSettings();
      const tree = await bookmarks.getTree();
      const excluded = excludedSet(tree, resolveExclusions(tree, settings).ids);
      const pending = await proposals.read();
      const pendingIds = new Set(pending.flatMap((proposal) => [proposal.bookmark.id, ...proposal.together.map((member) => member.id)]));
      const { folder, sendable, omitted } = looseToSort(tree, folderId, { excluded, pending: pendingIds });
      const { folders, truncated: foldersLeftOut } = candidateFolders(tree, Boolean(folder?.syncing), { excluded, examples: false });
      const usage = await settingsStore.readUsage(dayKey(now()));
      let provider = null;
      try {
        provider = getProvider(parseModelRef(settings.ref).provider);
      } catch {
        // Reported below as an unknown model.
      }
      const entry = findModel(settings.ref);
      const calls = estimatedCalls(sendable.length);
      const callsLeft = Math.max(0, settings.maxCallsPerDay - usage.calls);
      /** @type {{reason: string, messageEs: string} | null} */
      let blocked = null;
      if (!folder || isFolder(folder) === false) blocked = { reason: 'gone', messageEs: 'Esa carpeta ya no existe.' };
      else if (sendable.length === 0) blocked = { reason: 'nothing-to-sort', messageEs: 'No hay marcadores sueltos que se puedan enviar en esta carpeta.' };
      else if (!provider || !entry || provider.adapter === 'anthropic-sdk') blocked = { reason: 'unknown-model', messageEs: errorText('model') };
      else if (!(await permissions.contains({ permissions: [], origins: [hostPermissionFor(provider)] }))) blocked = { reason: 'no-permission', messageEs: errorText('permission') };
      else if (!(await settingsStore.readKey(provider.id))) blocked = { reason: 'no-key', messageEs: errorText('no-key') };
      else if (requiresTrainingConsent(provider) && !consentCovers(settings.consent, provider)) blocked = { reason: 'no-consent', messageEs: reasonText('no-consent') };
      else if (callsLeft === 0) blocked = { reason: 'daily-calls', messageEs: errorText('daily-cap') };
      return {
        folder: folder ? { id: folder.id, title: folder.title } : null,
        ref: settings.ref,
        providerName: provider?.name ?? '',
        model: entry?.id ?? '',
        sendable: sendable.length,
        items: sendable.map((item) => ({ id: item.id, title: cutText(cleanText(item.title), 80), host: item.host })),
        omitted: omitted.map((item) => ({ ...item, reasonEs: item.reason === 'pending' ? 'ya tiene una propuesta pendiente' : reasonText(item.reason) })),
        folderNames: folders.length,
        foldersLeftOut,
        calls,
        callsLeft,
        batches: Math.ceil(sendable.length / BATCH_SIZE),
        blocked,
      };
    },

    /**
     * «Ordenar sueltos»: proposes, for the loose bookmarks of one folder, existing or new
     * folders, grouped by destination. Nothing moves: every group is a proposal, even in automatic
     * mode. The folders come from M0's taxonomy prompt and the filing from M0's classification
     * prompt, in batches of 50, each call against the daily caps. When a cap or an error stops it
     * halfway, the groups already filed are still proposed and the rest is reported.
     *
     * @param {string} folderId
     */
    async sortLoose(folderId) {
      const preview = await api.previewLoose(folderId);
      if (preview.blocked) return { ok: false, ...preview };
      const settings = await settingsStore.readSettings();
      const provider = getProvider(parseModelRef(settings.ref).provider);
      const entry = /** @type {import('../core/models.js').ModelEntry} */ (findModel(settings.ref));
      const apiKey = /** @type {string} */ (await settingsStore.readKey(provider.id));
      const tree = await bookmarks.getTree();
      const byId = indexTree(tree);
      const excluded = excludedSet(tree, resolveExclusions(tree, settings).ids);
      const pending = await proposals.read();
      const pendingIds = new Set(pending.flatMap((proposal) => [proposal.bookmark.id, ...proposal.together.map((member) => member.id)]));
      const { folder, sendable } = looseToSort(tree, folderId, { excluded, pending: pendingIds });
      const sortedFolder = /** @type {TreeNode} */ (folder);
      const { folders: candidates } = candidateFolders(tree, Boolean(sortedFolder.syncing), { excluded, examples: false });

      let sentOnce = false;
      const onSend = async () => {
        if (sentOnce) return;
        sentOnce = true;
        await settingsStore.saveLastSent({
          at: now().toISOString(),
          folders: candidates.length,
          examples: 0,
          loose: sendable.length,
          truncatedFolders: 0,
          chars: 0,
          titles: sendable.slice(0, MAX_PREVIEW_TITLES).map((item) => cleanTitle(item.title)),
          sent: {
            bookmark: { title: `Ordenar sueltos de «${sortedFolder.title}»`, host: '' },
            folders: candidates.map((candidate) => ({ name: candidate.name, examples: [] })),
            loose: sendable.map((item) => ({ title: cleanTitle(item.title), host: item.host })),
          },
        });
      };
      /** @type {{category?: import('../core/autosort.js').ErrorCategory, reason: string} | null} */
      let stoppedBy = null;
      let calls = 0;
      /** @type {import('../core/types.js').Complete} */
      const capped = async (request) => {
        calls += 1;
        const outcome = await classify(request, { ref: settings.ref, model: entry.id, apiKey, maxCalls: settings.maxCallsPerDay, onSend });
        if ('result' in outcome) return outcome.result;
        stoppedBy = { category: outcome.category, reason: outcome.reason };
        throw Object.assign(new Error(outcome.reason), { stop: true });
      };

      const items = sendable.map(({ id, title, url }) => ({ id, title, url }));
      /** @type {{name: string, description?: string}[]} */
      let proposed = [];
      try {
        const taxonomy = await proposeTaxonomy(capped, {
          existingFolders: candidates.map((candidate) => candidate.name),
          sample: taxonomySample(sendable, byId).map(({ title, url }) => ({ title, url })),
          maxFolders: suggestFolderCount(sendable.length),
          language: 'the language of the existing folder names (Spanish if there are none)',
        });
        proposed = taxonomy.folders;
      } catch (error) {
        if (!(/** @type {{stop?: boolean}} */ (error)?.stop)) stoppedBy = { category: 'server', reason: 'error' };
      }

      const choices = classificationFolders(candidates, proposed);
      /** @type {{id: string, folder: string, confidence: 'high' | 'low'}[]} */
      const assignments = [];
      let unclassified = 0;
      if (!stoppedBy) {
        const batches = makeBatches(items, { maxItems: BATCH_SIZE, maxTokens: Number.POSITIVE_INFINITY });
        for (const [position, batch] of batches.entries()) {
          try {
            const result = await classifyBatch(capped, batch, choices.folders, { maxRetries: 1 });
            assignments.push(...result.assignments);
            unclassified += result.unclassified.length;
          } catch (error) {
            if (!(/** @type {{stop?: boolean}} */ (error)?.stop)) stoppedBy = { category: 'server', reason: 'error' };
            unclassified += batches.slice(position).reduce((total, rest) => total + rest.length, 0);
            break;
          }
        }
      }

      const { groups, unsorted } = groupAssignments(assignments, choices, folderId);
      const createdAt = now().toISOString();
      /** @param {string} id */
      const member = (id) => {
        const node = /** @type {TreeNode} */ (byId.get(id));
        return { id: node.id, title: node.title, host: describeForLog(node).host, parentId: folderId, index: /** @type {number} */ (node.index) };
      };
      let proposalsMade = 0;
      for (const [n, group] of groups.entries()) {
        const [first, ...rest] = group.members.map(member);
        const base = { id: `proposal:${createdAt}:sort:${n}`, createdAt, origin: /** @type {const} */ ('sort-loose'), confidence: group.confidence, bookmark: first, together: rest };
        const added =
          group.kind === 'move'
            ? await proposals.add({ ...base, kind: 'move', reason: group.confidence === 'low' ? 'low-confidence' : 'confirm-mode', folder: group.folder })
            : await proposals.add({ ...base, kind: 'create', newFolder: { parentId: group.parentId, parentTitle: byId.get(group.parentId)?.title ?? '', name: group.name, description: group.description } });
        if (!added.merged) proposalsMade += 1;
        for (const dropped of added.dropped) {
          await record('expired', dropped.bookmark, { reason: 'dropped', folder: dropped.newFolder?.name ?? dropped.folder?.name });
          await settingsStore.bumpMetric('expired', now());
        }
      }

      const filed = assignments.length - unsorted.length;
      const stop = /** @type {{category?: import('../core/autosort.js').ErrorCategory, reason: string} | null} */ (stoppedBy);
      const summary = {
        ok: true,
        folder: { id: folderId, title: sortedFolder.title },
        sent: sendable.length,
        proposals: proposalsMade,
        groups: groups.length,
        filed,
        unsorted: unsorted.length,
        unclassified,
        omitted: preview.omitted.length,
        calls,
        stopped: stop ? { reason: stop.reason, category: stop.category ?? 'server', messageEs: stop.category ? errorText(stop.category) : reasonText(stop.reason) } : null,
      };
      await record(stop ? 'error' : 'sorted', { title: `Ordenar sueltos de «${sortedFolder.title}»` }, {
        reason: stop?.reason,
        category: stop?.category,
        origin: 'sort-loose',
        counts: { sent: summary.sent, groups: summary.groups, filed, unsorted: summary.unsorted, unclassified, omitted: summary.omitted },
      });
      return summary;
    },

    async testProvider() {
      const settings = await settingsStore.readSettings();
      let provider;
      try {
        provider = getProvider(parseModelRef(settings.ref).provider);
      } catch {
        return { ok: false, category: 'model', messageEs: errorText('model') };
      }
      const entry = findModel(settings.ref);
      if (!entry || provider.adapter === 'anthropic-sdk') return { ok: false, category: 'model', messageEs: errorText('model') };
      if (!(await permissions.contains({ permissions: [], origins: [hostPermissionFor(provider)] }))) return { ok: false, category: 'permission', messageEs: errorText('permission') };
      const apiKey = await settingsStore.readKey(provider.id);
      if (!apiKey) return { ok: false, category: 'no-key', messageEs: errorText('no-key') };
      const request = buildAutoSortRequest({ bookmark: { title: 'Prueba de conexión de Bookmark Genie', url: 'example.com' }, folders: [], loose: [] });
      const outcome = await classify(request, { ref: settings.ref, model: entry.id, apiKey, maxCalls: settings.maxCallsPerDay });
      if (!('result' in outcome)) {
        const category = outcome.category ?? 'server';
        return { ok: false, category, messageEs: outcome.category ? errorText(category) : reasonText(outcome.reason), ms: outcome.ms };
      }
      const seconds = (outcome.ms / 1000).toFixed(1).replace('.', ',');
      return { ok: true, messageEs: `La clave funciona: ${provider.name} respondió con ${outcome.result.servedModel} en ${seconds} s.`, ms: outcome.ms, servedModel: outcome.result.servedModel };
    },

    errorText,
  };
  return api;
}
