/**
 * The one entry point the extension's pages use for the automatic sort: state, activity with its
 * actions, proposals, settings, consent, metrics and texts. Every method is async and none throws
 * because something is missing (no key, no permission, no settings): the state and the results
 * say so. Contract: docs/arquitectura-bajo-nivel.md.
 *
 * @typedef {import('../core/autosort.js').AutoSortSettings} AutoSortSettings
 * @typedef {import('./settings.js').LogEvent} LogEvent
 * @typedef {LogEvent & {messageEs: string, actions: ('undo' | 'choose-folder' | 'retry' | 'remove-duplicate')[]}} ActivityEntry
 */

/** Reasons where «Clasificar de nuevo» would only repeat the same answer or the same refusal. */
const NO_RETRY = new Set([
  'no-topic', 'saved-in-folder', 'duplicate', 'already-there', 'private-host', 'unsupported-scheme', 'invalid-url',
  'excluded-folder', 'chosen-by-person', 'discarded', 'expired', 'dropped', 'gone',
]);

import {
  DAILY_USD_CAP,
  CONSENT_VERSION,
  consentCovers as covers,
  consentText as textOfConsent,
  dayKey,
  errorText,
  excludedSet,
  pathOf,
  reasonText,
  resolveExclusions,
  shouldSuggestAutomatic,
  weekKey,
} from '../core/autosort.js';
import { findModel, parseModelRef } from '../core/models.js';
import { indexTree, isFolder, isRoot, rootsOf } from '../core/tree.js';
import { createAutoSorter } from './autosort.js';
import { undoChange } from './bookmarks.js';
import { KEEP_CHANGES } from './store.js';
import { PROPOSAL_TTL_MS } from './proposals.js';
import { PROVIDERS, getProvider, policyFullEs, policySummaryEs, requiresTrainingConsent } from './providers.js';
import { METRIC_NAMES, hostPermissionFor, keyHint as hintOf, permissionsFor as permissionsOfProvider } from './settings.js';

/**
 * @param {{
 *   storage?: chrome.storage.StorageArea,
 *   bookmarks?: import('./bookmarks.js').BookmarksApi,
 *   tabs?: any,
 *   permissions?: {contains(p: {permissions: string[], origins: string[]}): Promise<boolean>, remove?(p: {permissions: string[], origins: string[]}): Promise<boolean>},
 *   action?: any,
 *   createComplete?: any,
 *   now?: () => Date,
 *   locks?: LockManager | null,
 *   schedule?: (callback: () => void, ms: number) => void,
 *   wait?: (ms: number) => Promise<void>,
 *   worker?: {sendMessage(message: unknown): Promise<any>} | null,
 * }} [deps]
 *   `worker`: where «Ordenar sueltos» runs, so a popup that closes does not cut it; without it,
 *   it runs here (the worker itself, and the tests)
 */
export function createFlow(deps = {}) {
  const storage = deps.storage ?? chrome.storage.local;
  const bookmarks = deps.bookmarks ?? chrome.bookmarks;
  const permissions = deps.permissions ?? chrome.permissions;
  const now = deps.now ?? (() => new Date());
  const sorter = createAutoSorter({
    bookmarks,
    tabs: deps.tabs ?? chrome.tabs,
    permissions,
    storage,
    action: deps.action ?? chrome.action,
    createComplete: deps.createComplete,
    now,
    locks: deps.locks,
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    ...(deps.wait ? { wait: deps.wait } : {}),
  });
  const { proposals, settings: store, journal } = sorter;

  /** @param {string} ref */
  const providerOf = (ref) => {
    try {
      return getProvider(parseModelRef(ref).provider);
    } catch {
      return null;
    }
  };

  /** @param {string} id */
  const exists = async (id) => {
    try {
      return (await bookmarks.get(id)).length > 0;
    } catch {
      return false;
    }
  };

  /** @param {number} count @param {string} one @param {string} many */
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  /** @param {{proposals?: number, groups?: number, filed: number, unsorted: number, unclassified: number, omitted: number}} counts */
  const sortedText = (counts) => {
    const groups = counts.proposals ?? counts.groups ?? 0;
    const parts = [`${plural(groups, 'propuesta', 'propuestas')} para ${plural(counts.filed, 'marcador', 'marcadores')}`];
    if (counts.unsorted > 0) parts.push(`${counts.unsorted} sin tema claro`);
    if (counts.unclassified > 0) parts.push(`${counts.unclassified} sin clasificar`);
    if (counts.omitted > 0) parts.push(plural(counts.omitted, 'omitido', 'omitidos'));
    return parts.join('; ');
  };

  /** @param {LogEvent} event */
  const baseMessage = (event) => {
    // The row shows its title («Ordenar sueltos de …») before this text.
    if (event.kind === 'sorted') {
      const text = sortedText(event.counts ?? { filed: 0, unsorted: 0, unclassified: 0, omitted: 0 });
      return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
    }
    if (event.kind === 'error' && event.origin === 'sort-loose') return `Se detuvo: ${errorText(event.category ?? 'server')}${event.counts ? ` Llegó a ${sortedText(event.counts)}.` : ''}`;
    if (event.kind === 'error') return errorText(event.category ?? 'server');
    if (event.kind === 'duplicate') return event.folder ? `Ya lo tenías en «${event.folder}».` : 'Ya lo tenías guardado.';
    if (event.kind === 'moved') return event.accepted ? `Movido a «${event.folder}» con tu confirmación.` : `Movido a «${event.folder}».`;
    if (event.kind === 'proposed') return event.newFolder ? `Propone crear «${event.folder}».` : `Propone mover a «${event.folder}».`;
    const text = reasonText(event.reason ?? '');
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.]$/.test(text) ? '' : '.'}`;
  };
  /** @param {LogEvent} event */
  const messageOf = (event) =>
    event.truncation ? `${baseMessage(event)} Se enviaron ${event.truncation.sent} de ${event.truncation.total} carpetas.` : baseMessage(event);

  /**
   * @param {import('./settings.js').LastResult['kind']} kind
   * @param {string} messageEs
   * @param {string | null | undefined} [changeId]
   */
  const remember = (kind, messageEs, changeId) =>
    store.saveLastResult({ at: now().toISOString(), kind, messageEs, ...(changeId ? { changeId } : {}) }).catch(() => {});
  /** @param {number} count */
  const bookmarksText = (count) => (count === 1 ? '1 marcador' : `${count} marcadores`);
  /** @param {import('./proposals.js').ApplyResult} result @param {string} fallbackName */
  const applyText = (result, fallbackName) => {
    if (result.error) return result.error.messageEs;
    if (result.stale) return 'El marcador ya no estaba donde lo dejó Ctrl+D: la propuesta se descartó.';
    const skipped = result.skipped.length > 0 ? ` ${bookmarksText(result.skipped.length)} se ${result.skipped.length === 1 ? 'omitió' : 'omitieron'}.` : '';
    return result.createdFolder
      ? `Carpeta «${fallbackName}» creada con ${bookmarksText(result.moved)}.${skipped}`
      : `${bookmarksText(result.moved)} ${result.moved === 1 ? 'movido' : 'movidos'} a «${fallbackName}».${skipped}`;
  };

  /**
   * Hosts of every provider but the one saved go back to Chrome; with the sort off, its host and
   * `tabs` too. Only what is granted is removed.
   *
   * @param {AutoSortSettings} saved
   */
  const giveBackPermissions = async (saved) => {
    if (!permissions.remove) return;
    const current = providerOf(saved.ref);
    const keep = saved.enabled && current ? hostPermissionFor(current) : null;
    const origins = Object.values(PROVIDERS)
      .filter((provider) => provider.adapter !== 'anthropic-sdk')
      .map((provider) => hostPermissionFor(provider))
      .filter((origin) => origin !== keep);
    /** @type {string[]} */
    const granted = [];
    for (const origin of origins) if (await permissions.contains({ permissions: [], origins: [origin] }).catch(() => false)) granted.push(origin);
    const dropTabs = !saved.enabled && (await permissions.contains({ permissions: ['tabs'], origins: [] }).catch(() => false));
    if (granted.length > 0 || dropTabs) await permissions.remove({ permissions: dropTabs ? ['tabs'] : [], origins: granted }).catch(() => false);
  };

  /**
   * Fills in the path of each excluded folder, in a second write, so the exclusion survives a new id.
   *
   * @param {AutoSortSettings} saved
   */
  const completePaths = async (saved) => {
    const known = new Set(saved.excludedFolders.map((entry) => entry.id));
    const missing = saved.excludedFolderIds.filter((id) => !known.has(id));
    if (missing.length === 0) return saved;
    const byId = indexTree(await bookmarks.getTree());
    const added = missing.flatMap((id) => {
      const path = pathOf(byId, id);
      return path ? [{ id, path }] : [];
    });
    if (added.length === 0) return saved;
    return store.saveSettings({ ...saved, excludedFolders: [...saved.excludedFolders, ...added] });
  };

  const flow = {
    /**
     * @returns {Promise<{state: 'active' | 'confirm' | 'paused' | 'off', reason?: string, ref: string, provider: string, providerName: string, model: string, usage: {day: string, calls: number, max: number, spentUsd: number, capUsd: number}, pending: number, errors: number, suggestAutomatic: boolean, messageEs?: string, action?: 'open-settings' | 'repair-permission' | 'wait-tomorrow'}>}
     */
    async getStatus() {
      const settings = await store.readSettings();
      const day = dayKey(now());
      const [usage, pending, errors, metrics] = await Promise.all([store.readUsage(day), proposals.read(), store.unseenErrors(), store.readMetrics()]);
      const provider = providerOf(settings.ref);
      const { model } = (() => {
        try {
          return parseModelRef(settings.ref);
        } catch {
          return { model: settings.ref };
        }
      })();
      const warnings = settings.excludedFolderIds.length > 0 ? resolveExclusions(await bookmarks.getTree(), settings).warnings : [];
      const base = {
        exclusionWarnings: warnings,
        ...(warnings.length > 0 ? { exclusionMessageEs: 'Una carpeta excluida cambió: revísala en Ajustes.' } : {}),
        ref: settings.ref,
        provider: provider?.id ?? '',
        providerName: provider?.name ?? '',
        model,
        usage: { day, calls: usage.calls, max: settings.maxCallsPerDay, spentUsd: usage.spentUsd, capUsd: DAILY_USD_CAP },
        pending: pending.length,
        errors,
        suggestAutomatic: settings.confirmBeforeMove && shouldSuggestAutomatic(metrics.totals),
      };
      if (!settings.enabled) return { ...base, state: /** @type {const} */ ('off') };
      const notice = warnings.length > 0 ? { messageEs: 'Una carpeta excluida cambió: revísala en Ajustes.' } : {};
      /** @param {string} reason @param {'open-settings' | 'repair-permission' | 'wait-tomorrow'} next @param {string} messageEs */
      const paused = (reason, next, messageEs) => ({ ...base, state: /** @type {const} */ ('paused'), reason, action: next, messageEs });
      if (!provider || !findModel(settings.ref)) return paused('unknown-model', 'open-settings', reasonText('unknown-model'));
      if (provider.adapter === 'anthropic-sdk') return paused('provider-pending', 'open-settings', reasonText('provider-pending'));
      const granted = await permissions.contains(permissionsOfProvider(provider)).catch(() => false);
      if (!granted) return paused('no-permission', 'repair-permission', errorText('permission'));
      if (!(await store.readKey(provider.id))) return paused('no-key', 'open-settings', errorText('no-key'));
      if (requiresTrainingConsent(provider) && !covers(settings.consent, provider)) return paused('no-consent', 'open-settings', reasonText('no-consent'));
      if (usage.calls >= settings.maxCallsPerDay) return paused('daily-calls', 'wait-tomorrow', errorText('daily-cap'));
      if (usage.spentUsd >= DAILY_USD_CAP) return paused('daily-budget', 'wait-tomorrow', errorText('daily-cap'));
      return { ...base, ...notice, state: settings.confirmBeforeMove ? /** @type {const} */ ('confirm') : /** @type {const} */ ('active') };
    },

    /** The window calls it when it opens: clears «!» and leaves the proposal count. */
    async ackErrors() {
      await store.ackErrors();
      await proposals.showCount();
    },

    /**
     * @param {number} [n]
     * @returns {Promise<ActivityEntry[]>} newest first
     */
    async listActivity(n = 50) {
      const log = (await store.readLog()).slice(0, n);
      const changes = new Map((await journal.listChanges(20)).map((header) => [header.id, header]));
      return Promise.all(
        log.map(async (event) => {
          /** @type {ActivityEntry['actions']} */
          const actions = [];
          const alive = event.bookmarkId ? await exists(event.bookmarkId) : false;
          if (event.changeId && changes.get(event.changeId)?.undoable) actions.push('undo');
          if (alive && !['proposed', 'duplicate', 'expired'].includes(event.kind)) actions.push('choose-folder');
          if (alive && (event.kind === 'left' || event.kind === 'error') && !NO_RETRY.has(event.reason ?? '')) actions.push('retry');
          if (alive && event.kind === 'duplicate' && event.duplicateOf && (await exists(event.duplicateOf))) actions.push('remove-duplicate');
          // 0.4.0 kept the provider's words in `message`; they are only ever a detail.
          const { message, ...rest } = /** @type {LogEvent & {message?: string}} */ (event);
          const detail = event.detail ?? message;
          return { ...rest, ...(detail ? { detail } : {}), messageEs: messageOf(event), actions };
        }),
      );
    },

    /** @param {string} bookmarkId */
    async reclassify(bookmarkId) {
      const event = await sorter.reclassify(bookmarkId);
      if (event.kind === 'ignored') return event;
      const entry = { ...event, messageEs: messageOf(event), actions: [] };
      await remember('reclassified', `«${event.title || 'Sin título'}»: ${entry.messageEs}`, event.changeId);
      return entry;
    },

    /** @param {string} bookmarkId @param {string} folderId */
    async moveTo(bookmarkId, folderId) {
      const result = await sorter.moveTo(bookmarkId, folderId);
      const folder = await bookmarks.get(folderId).then(([node]) => node.title, () => '');
      await remember('moved', result.changeId ? `Movido a «${folder}».` : 'No se pudo mover: el marcador o la carpeta ya no existen.', result.changeId);
      return result;
    },

    /** @param {string} bookmarkId */
    async removeDuplicate(bookmarkId) {
      const result = await sorter.removeDuplicate(bookmarkId);
      await remember('removed-duplicate', result.removed ? 'Duplicado nuevo quitado.' : 'No se quitó: ya no es un duplicado o ya no existe.');
      return result;
    },

    /**
     * The result the window's strip shows until the next action, with whether it can still be undone.
     *
     * @returns {Promise<(import('./settings.js').LastResult & {undoable: boolean}) | null>}
     */
    async lastResult() {
      const result = await store.readLastResult();
      if (!result) return null;
      const header = result.changeId ? (await journal.listChanges(20)).find((change) => change.id === result.changeId) : undefined;
      return { ...result, undoable: Boolean(header?.undoable) };
    },

    dismissLastResult: () => store.clearLastResult(),

    testProvider: () => sorter.testProvider(),

    /**
     * What «Ordenar sueltos» would send for a folder, without sending anything.
     *
     * @param {string} folderId
     */
    previewLoose: (folderId) => sorter.previewLoose(folderId),

    /**
     * «Ordenar sueltos», after the person confirmed the preview. Runs in the worker when there is
     * one. Its groups arrive as proposals; nothing moves until they are accepted.
     *
     * @param {string} folderId
     */
    async sortLoose(folderId) {
      if (deps.worker) return deps.worker.sendMessage({ type: 'sort-loose', folderId });
      const result = await sorter.sortLoose(folderId);
      if ('blocked' in result && result.blocked) {
        await remember('sorted', `No se ordenó: ${result.blocked.messageEs}`);
      } else if ('sent' in result) {
        const stop = result.stopped ? ` Se detuvo: ${result.stopped.messageEs}` : '';
        await remember('sorted', `Ordenar sueltos de «${result.folder.title}»: ${sortedText(result)}.${stop}${result.groups > 0 ? ' Revísalas arriba.' : ''}`);
      }
      return result;
    },

    /**
     * Undoes a change from the journal and counts it.
     *
     * @param {string} changeId
     */
    async undo(changeId) {
      const header = (await journal.listChanges(KEEP_CHANGES)).find((change) => change.id === changeId);
      if (header && !header.undoable) {
        // Already undone, or nothing moved: say so instead of failing.
        const messageEs = header.undone ? 'Ese cambio ya estaba deshecho.' : 'Ese cambio no movió nada.';
        await remember('undone', messageEs);
        return { at: now().toISOString(), restored: [], skipped: [], removedFolders: [], keptFolders: [], alreadyUndone: header.undone };
      }
      const record = await undoChange(changeId, { bookmarks, store: journal, now });
      if (record.restored.length > 0) {
        await store.bumpMetric('undone', now());
        await store.bumpMetric('undoneBookmarks', now(), record.restored.length);
      }
      const kept = record.keptFolders.length > 0 ? ' La carpeta creada se conservó porque tiene cosas que no movió Bookmark Genie.' : record.removedFolders.length > 0 ? ' La carpeta creada se borró.' : '';
      const skipped = record.skipped.length > 0 ? ` ${bookmarksText(record.skipped.length)} no ${record.skipped.length === 1 ? 'volvió' : 'volvieron'}: ya no ${record.skipped.length === 1 ? 'estaba' : 'estaban'} donde los dejó.` : '';
      await remember('undone', `Deshecho: ${bookmarksText(record.restored.length)} ${record.restored.length === 1 ? 'volvió' : 'volvieron'} a su lugar.${kept}${skipped}`);
      return record;
    },

    proposals: {
      async list() {
        await proposals.prune();
        const pending = await proposals.read();
        return pending.toReversed().map((proposal) => ({
          id: proposal.id,
          kind: proposal.kind,
          confidence: proposal.confidence,
          ...(proposal.reason ? { reason: proposal.reason } : {}),
          origin: proposal.origin ?? 'ctrl-d',
          createdAt: proposal.createdAt,
          expiresAt: new Date(Date.parse(proposal.createdAt) + PROPOSAL_TTL_MS).toISOString(),
          bookmark: { id: proposal.bookmark.id, title: proposal.bookmark.title, host: proposal.bookmark.host },
          ...(proposal.folder ? { folder: proposal.folder } : {}),
          ...(proposal.newFolder ? { newFolder: proposal.newFolder } : {}),
          together: proposal.together.map(({ id, title, host }) => ({ id, title, host })),
          members: 1 + proposal.together.length,
        }));
      },
      /**
       * @param {string} id
       * @param {{name?: string, targetFolderId?: string, memberIds?: string[]}} [options]
       */
      async apply(id, options) {
        const proposal = (await proposals.read()).find((candidate) => candidate.id === id);
        const result = await proposals.apply(id, options);
        const name = options?.name ?? proposal?.newFolder?.name ?? proposal?.folder?.name ?? '';
        const target = options?.targetFolderId ? await bookmarks.get(options.targetFolderId).then(([node]) => node.title, () => name) : name;
        await remember('applied', applyText(result, target), result.changeId);
        return result;
      },
      /** @param {string} id */
      async discard(id) {
        const removed = await proposals.discard(id);
        if (removed.length > 0) await store.bumpMetric(proposals.metricFor(removed[0], 'discarded'), now());
      },
      /**
       * «Aceptar todas», for one origin: all the groups in one change, undone with one «Deshacer».
       *
       * @param {'ctrl-d' | 'sort-loose'} [origin]
       */
      async acceptAll(origin) {
        const result = await proposals.acceptAll(origin);
        const groups = result.groups ?? 0;
        const created = result.createdFolders?.length ?? 0;
        const folders = created > 0 ? ` ${plural(created, 'carpeta nueva', 'carpetas nuevas')}.` : '';
        await remember('applied', `${plural(result.moved, 'marcador movido', 'marcadores movidos')} en ${plural(groups, 'grupo', 'grupos')}, como un solo cambio.${folders} «Deshacer» lo revierte entero.`, result.changeId);
        return result;
      },
      /** @param {string} name */
      async acceptGroup(name) {
        const result = await proposals.acceptGroup(name);
        await remember('applied', `${bookmarksText(result.moved)} ${result.moved === 1 ? 'movido' : 'movidos'} a «${name}».`, result.changeId);
        return result;
      },
    },

    settings: {
      get: () => store.readSettings(),
      /**
       * The whole settings object; written in the first statement. Turning the sort off gives
       * the optional permissions back.
       *
       * @param {AutoSortSettings} next
       */
      save(next) {
        const saving = store.saveSettings(next);
        return saving.then(async (saved) => {
          await giveBackPermissions(saved);
          return completePaths(saved);
        });
      },
      /** @param {string} providerId @param {string} key */
      saveKey: (providerId, key) => store.saveKey(providerId, key.trim()),
      /** @param {string} providerId */
      deleteKey: (providerId) => store.deleteKey(providerId),
      /** @param {string} providerId */
      async keyHint(providerId) {
        const key = await store.readKey(providerId);
        return key ? hintOf(key) : null;
      },
    },

    /** @param {string} ref */
    permissionsFor(ref) {
      const provider = providerOf(ref);
      return provider ? permissionsOfProvider(provider) : { permissions: ['tabs'], origins: [] };
    },

    /** @param {string} providerId */
    consentFor(providerId) {
      const provider = getProvider(providerId);
      return { provider: provider.id, readOn: provider.dataPolicy.readOn, version: CONSENT_VERSION, at: now().toISOString() };
    },
    /** @param {string} providerId */
    consentText: (providerId) => textOfConsent(getProvider(providerId)),
    /** @param {AutoSortSettings} settings @param {string} providerId */
    consentCovers: (settings, providerId) => covers(settings.consent, getProvider(providerId)),
    /** @param {string} providerId */
    policySummary: (providerId) => policySummaryEs(getProvider(providerId)),
    /** @param {string} providerId */
    policyFull: (providerId) => policyFullEs(getProvider(providerId)),

    /**
     * The folders that hold loose bookmarks, for the «Ordenar sueltos» picker: roots first, then
     * by how many they hold.
     *
     * @returns {Promise<{id: string, path: string, loose: number, root: boolean}[]>}
     */
    async looseFolders() {
      const tree = await bookmarks.getTree();
      /** @type {{id: string, path: string, loose: number, root: boolean}[]} */
      const out = [];
      /** @param {import('../core/tree.js').TreeNode} node @param {string[]} path */
      const visit = (node, path) => {
        const here = [...path, node.title];
        const loose = (node.children ?? []).filter((child) => !isFolder(child)).length;
        if (loose > 0 && node.folderType !== 'managed' && node.unmodifiable !== 'managed') out.push({ id: node.id, path: here.join(' › '), loose, root: isRoot(node) });
        for (const child of node.children ?? []) if (isFolder(child)) visit(child, here);
      };
      for (const root of rootsOf(tree)) visit(root, []);
      return out.sort((a, b) => Number(b.root) - Number(a.root) || b.loose - a.loose);
    },

    /** Folders to exclude, or to pick with «Otra carpeta». */
    async folderChoices() {
      const tree = await bookmarks.getTree();
      const settings = await store.readSettings();
      const excluded = excludedSet(tree, resolveExclusions(tree, settings).ids);
      /** @type {{id: string, path: string, syncing: boolean, root: boolean, excluded: boolean}[]} */
      const out = [];
      /** @param {import('../core/tree.js').TreeNode} node @param {string[]} path */
      const visit = (node, path) => {
        const here = [...path, node.title];
        out.push({ id: node.id, path: here.join(' › '), syncing: Boolean(node.syncing), root: isRoot(node), excluded: excluded.has(node.id) });
        for (const child of node.children ?? []) if (isFolder(child)) visit(child, here);
      };
      for (const root of rootsOf(tree)) visit(root, []);
      return out;
    },

    async weeklyMetrics() {
      const metrics = await store.readMetrics();
      const week = weekKey(now());
      const counts = Object.fromEntries(METRIC_NAMES.map((name) => [name, metrics.weeks[week]?.[name] ?? 0]));
      const tree = await bookmarks.getTree();
      const looseInBar = rootsOf(tree)
        .filter((root) => root.folderType === 'bookmarks-bar')
        .reduce((total, root) => total + (root.children ?? []).filter((child) => !isFolder(child)).length, 0);
      return /** @type {{week: string, moved: number, accepted: number, discarded: number, undone: number, corrected: number, expired: number, filed: number, undoneBookmarks: number, looseAccepted: number, looseDiscarded: number, looseFiled: number, looseInBar: number}} */ ({ week, ...counts, looseInBar });
    },

    lastSentPreview: () => store.readLastSent(),
    errorText,
    reasonText,
  };
  return flow;
}
