/**
 * Proposals the automatic sort leaves for the person: move to an existing folder (always, in
 * «Confirmar antes de mover»; when it was unsure, in automatic mode), or create a new folder for
 * a clear topic, with the loose bookmarks that belong there. Nothing is created or moved until
 * the person confirms. They live in `chrome.storage.local` under `proposals`, oldest first.
 *
 * - No duplicates: two `create` proposals for the same folder name in the same parent (by
 *   `folderKey`) merge into one, and applying reuses a sibling folder with that key if the
 *   person made one meanwhile.
 * - No silent loss: at most MAX_PROPOSALS wait and each expires after 14 days; whatever falls
 *   out is returned so the caller logs it. A proposal leaves the list only when it was applied
 *   or went stale (the person moved or deleted its bookmark). If applying fails after creating a
 *   folder, the folder is removed and the proposal stays.
 * - Every read-modify-write goes through `withLock('proposals')`, shared with the worker.
 *
 * The badge belongs here too: «!» in red while there are unseen errors, otherwise the number of
 * pending proposals in blue, «✓» in green for a moment after a move.
 *
 * @typedef {import('./bookmarks.js').BookmarksApi} BookmarksApi
 * @typedef {import('./store.js').Skipped} Skipped
 * @typedef {{id: string, title: string, host: string, parentId: string, index: number}} ProposedBookmark
 * @typedef {{
 *   id: string,
 *   createdAt: string,
 *   kind: 'move' | 'create',
 *   confidence: 'high' | 'low',
 *   reason?: 'confirm-mode' | 'low-confidence',
 *   origin?: 'ctrl-d' | 'sort-loose',
 *   bookmark: ProposedBookmark,
 *   folder?: {id: string, name: string},
 *   newFolder?: {parentId: string, parentTitle: string, name: string, description: string},
 *   together: ProposedBookmark[],
 * }} Proposal
 *   `origin` `sort-loose`: a group from «Ordenar sueltos». Its first bookmark is just one of the
 *   group: it can be left out like the others, the proposal is stale only when none is left, and
 *   it counts in its own metrics.
 * @typedef {{
 *   changeId: string | null,
 *   moved: number,
 *   skipped: Skipped[],
 *   stale: boolean,
 *   createdFolder?: string,
 *   reusedFolder?: string,
 *   error?: {category: import('../core/autosort.js').ErrorCategory, messageEs: string},
 *   groups?: number,
 *   createdFolders?: string[],
 * }} ApplyResult
 *   `groups` and `createdFolders`: when several proposals went in one change
 */

import { MAX_NEW_FOLDER_NAME, errorText, folderKey } from '../core/autosort.js';
import { cleanText, cleanTitle, cutText } from '../core/prompt.js';
import { applyPlan } from './bookmarks.js';
import { createSettingsStore } from './settings.js';
import { createStore, withLock } from './store.js';

export const MAX_PROPOSALS = 50;
export const PROPOSAL_TTL_MS = 14 * 86_400_000;
const PROPOSALS_KEY = 'proposals';
export const BADGE_COLORS = Object.freeze({ error: '#c62828', pending: '#1565c0', moved: '#2e7d32' });

/**
 * A proposal as stored, with what 0.3.0 did not keep filled in.
 *
 * @param {any} raw
 * @returns {Proposal}
 */
function normalize(raw) {
  /** @param {any} member */
  const member = (member) => ({ id: String(member.id), title: String(member.title ?? ''), host: String(member.host ?? ''), parentId: String(member.parentId), index: Number(member.index) || 0 });
  const confidence = raw.confidence === 'high' ? 'high' : 'low';
  const reason = raw.kind === 'move' ? (raw.reason === 'confirm-mode' || raw.reason === 'low-confidence' ? raw.reason : confidence === 'high' ? 'confirm-mode' : 'low-confidence') : undefined;
  const origin = raw.origin === 'sort-loose' ? 'sort-loose' : 'ctrl-d';
  return { ...raw, confidence, origin, ...(reason ? { reason } : {}), bookmark: member(raw.bookmark), together: Array.isArray(raw.together) ? raw.together.map(member) : [] };
}

/** @param {Proposal} proposal */
const targetKey = (proposal) => folderKey(proposal.kind === 'create' ? proposal.newFolder?.name ?? '' : proposal.folder?.name ?? '');

/**
 * @param {{
 *   storage: chrome.storage.StorageArea,
 *   bookmarks: BookmarksApi,
 *   action?: {setBadgeText(details: {text: string}): Promise<void>, setBadgeBackgroundColor(details: {color: string}): Promise<void>},
 *   now?: () => Date,
 *   locks?: LockManager | null,
 * }} dependencies
 */
export function createProposals({ storage, bookmarks, action, now = () => new Date(), locks }) {
  const journal = createStore(storage, locks === undefined ? {} : { locks });
  const settings = createSettingsStore(storage, locks === undefined ? {} : { locks });
  /**
   * @template T
   * @param {() => Promise<T>} task
   */
  const locked = (task) => withLock('proposals', task, locks === undefined ? {} : { locks });

  /** @returns {Promise<Proposal[]>} */
  const read = async () => {
    const value = (await storage.get(PROPOSALS_KEY))[PROPOSALS_KEY];
    return Array.isArray(value) ? value.map(normalize) : [];
  };
  /** @param {Proposal[]} proposals */
  const write = (proposals) => storage.set({ [PROPOSALS_KEY]: proposals });

  /** @param {{text: string, color?: string}} badge */
  const setBadge = async ({ text, color }) => {
    if (!action) return;
    if (color) await action.setBadgeBackgroundColor({ color });
    await action.setBadgeText({ text });
  };
  const showCount = async () => {
    const [count, errors] = await Promise.all([read().then((list) => list.length), settings.unseenErrors()]);
    if (errors > 0) await setBadge({ text: '!', color: BADGE_COLORS.error });
    else await setBadge({ text: count > 0 ? String(count) : '', color: BADGE_COLORS.pending });
  };

  /** @param {{id: string, parentId: string}} expected */
  const stillThere = async (expected) => {
    try {
      const [node] = await bookmarks.get(expected.id);
      return node.parentId === expected.parentId;
    } catch {
      return false;
    }
  };

  /**
   * Removes the proposals `keep` rejects, under the lock.
   *
   * @param {(proposal: Proposal) => Promise<boolean> | boolean} keep
   * @returns {Promise<Proposal[]>} the removed ones
   */
  const removeWhere = async (keep) => {
    const removed = await locked(async () => {
      const proposals = await read();
      /** @type {Proposal[]} */
      const kept = [];
      /** @type {Proposal[]} */
      const out = [];
      for (const proposal of proposals) ((await keep(proposal)) ? kept : out).push(proposal);
      if (out.length > 0) await write(kept);
      return out;
    });
    await showCount();
    return removed;
  };

  /** @param {string} id */
  const remove = (id) => removeWhere((proposal) => proposal.id !== id);

  /**
   * A Ctrl+D proposal lives while its bookmark is where it was; a «Ordenar sueltos» group while
   * any of its bookmarks is.
   *
   * @param {Proposal} proposal
   */
  const anyStillThere = async (proposal) => {
    if (proposal.origin !== 'sort-loose') return stillThere(proposal.bookmark);
    for (const member of [proposal.bookmark, ...proposal.together]) if (await stillThere(member)) return true;
    return false;
  };

  /**
   * @param {Proposal} proposal
   * @param {'accepted' | 'corrected' | 'filed' | 'discarded'} name
   * @returns {import('./settings.js').MetricName}
   */
  const metricFor = (proposal, name) =>
    proposal.origin === 'sort-loose' ? /** @type {const} */ ({ accepted: 'looseAccepted', corrected: 'looseAccepted', filed: 'looseFiled', discarded: 'looseDiscarded' })[name] : name;


  /** @type {ApplyResult} */
  const STALE = { changeId: null, moved: 0, skipped: [], stale: true };

  /**
   * @typedef {{proposal: Proposal, plan: {id: string, from: {parentId: string, index: number}, to: {parentId: string}}[], targetName: string, edited: boolean, createdFolder?: string, reusedFolder?: string, label: string}} Prepared
   */

  /**
   * Checks a proposal and gets its destination ready, creating the folder if it needs one.
   * Returns the plan, or the result to give back when there is nothing to apply.
   *
   * @param {Proposal} proposal
   * @param {{name?: string, targetFolderId?: string, memberIds?: string[], includeMain?: boolean}} options
   * @returns {Promise<Prepared | {result: ApplyResult}>}
   */
  const prepare = async (proposal, { name, targetFolderId, memberIds, includeMain = true }) => {
    if (!(await anyStillThere(proposal))) {
      await remove(proposal.id);
      return { result: { ...STALE } };
    }
    /** @param {string} messageEs */
    const failed = (messageEs) => ({ result: { ...STALE, stale: false, error: { category: /** @type {const} */ ('server'), messageEs } } });
    const withMain = includeMain || proposal.origin !== 'sort-loose';
    const members = [...(withMain ? [proposal.bookmark] : []), ...proposal.together.filter((member) => memberIds === undefined || memberIds.includes(member.id))];
    if (members.length === 0) return failed('No marcaste ningún marcador.');
    /** @type {{createdFolder?: string, reusedFolder?: string}} */
    const folderInfo = {};
    let target = targetFolderId ?? proposal.folder?.id;
    let targetName = proposal.folder?.name ?? '';
    const wantedName = name === undefined ? proposal.newFolder?.name ?? '' : cutText(cleanText(name), MAX_NEW_FOLDER_NAME);
    try {
      if (targetFolderId !== undefined) {
        const [folder] = await bookmarks.get(targetFolderId);
        if (folder.url !== undefined) throw new Error(`${targetFolderId} is not a folder`);
        targetName = folder.title;
      } else if (proposal.kind === 'create' && proposal.newFolder) {
        if (wantedName === '' || cleanTitle(wantedName) !== wantedName) return failed('El nombre de la carpeta está vacío o contiene un correo o un identificador.');
        const key = folderKey(wantedName);
        const sibling = (await bookmarks.getChildren(proposal.newFolder.parentId)).find((child) => child.url === undefined && folderKey(child.title) === key);
        if (sibling) {
          target = sibling.id;
          folderInfo.reusedFolder = sibling.id;
        } else {
          target = (await bookmarks.create({ parentId: proposal.newFolder.parentId, title: wantedName })).id;
          folderInfo.createdFolder = target;
        }
        targetName = wantedName;
      }
    } catch (error) {
      return failed(`No se pudo preparar la carpeta: ${/** @type {Error} */ (error).message}`);
    }
    if (target === undefined) return failed('La propuesta no tiene carpeta de destino.');
    const destination = target;
    return {
      proposal,
      plan: members.map((member) => ({ id: member.id, from: { parentId: member.parentId, index: member.index }, to: { parentId: destination } })),
      targetName,
      edited: targetFolderId !== undefined || (name !== undefined && wantedName !== proposal.newFolder?.name),
      label: proposal.origin === 'sort-loose' ? `Ordenar sueltos: ${members.length} → ${targetName}` : `«${proposal.bookmark.title}» → ${targetName}`,
      ...folderInfo,
    };
  };

  /**
   * Moves what the prepared proposals hold as one change of the journal, then removes them and
   * updates the metrics and the log. If the move fails, the folders just created go and the
   * proposals stay.
   *
   * @param {Prepared[]} prepared
   * @param {string} label
   * @returns {Promise<ApplyResult>}
   */
  const commit = async (prepared, label) => {
    const createdFolders = prepared.flatMap((entry) => (entry.createdFolder ? [entry.createdFolder] : []));
    let result;
    try {
      result = await applyPlan(prepared.flatMap((entry) => entry.plan), { bookmarks, store: journal, now, kind: 'proposal', label, createdFolders });
    } catch (error) {
      for (const id of createdFolders) {
        const left = await bookmarks.getChildren(id).catch(() => [{}]);
        if (left.length === 0) await bookmarks.remove(id).catch(() => {});
      }
      return { ...STALE, stale: false, error: { category: 'server', messageEs: `${errorText('server')} (${/** @type {Error} */ (error).message})` } };
    }
    const done = new Set(result.done.map((move) => move.id));
    const changeId = result.changeId ?? undefined;
    for (const entry of prepared) {
      await remove(entry.proposal.id);
      const moved = entry.plan.filter((move) => done.has(move.id)).length;
      if (moved === 0) continue;
      await settings.bumpMetric(metricFor(entry.proposal, entry.edited ? 'corrected' : 'accepted'), now());
      await settings.bumpMetric(metricFor(entry.proposal, 'filed'), now(), moved);
      // The «proposed» rows of what moved become «moved», with the change to undo.
      const ids = new Set(entry.plan.map((move) => move.id).filter((id) => done.has(id)));
      await settings.rewriteLog(
        (event) => event.kind === 'proposed' && event.bookmarkId !== undefined && ids.has(event.bookmarkId),
        (event) => ({ ...event, kind: 'moved', folder: entry.targetName, newFolder: Boolean(entry.createdFolder), accepted: true, ...(changeId ? { changeId } : {}) }),
      );
    }
    // «Ordenar sueltos» groups have no row of their own: one row for the whole change.
    const sorted = prepared.filter((entry) => entry.proposal.origin === 'sort-loose' && entry.plan.some((move) => done.has(move.id)));
    if (sorted.length > 0) {
      const count = sorted.reduce((total, entry) => total + entry.plan.filter((move) => done.has(move.id)).length, 0);
      const names = sorted.map((entry) => entry.targetName);
      const at = now().toISOString();
      await settings.appendLog({
        id: `log:${at}:sort-loose:${sorted[0].proposal.id}`,
        at,
        kind: 'moved',
        title: `${count} ${count === 1 ? 'suelto ordenado' : 'sueltos ordenados'}`,
        host: '',
        folder: names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} y ${names.length - 3} más`,
        ...(sorted.some((entry) => entry.createdFolder) ? { newFolder: true } : {}),
        accepted: true,
        origin: 'sort-loose',
        ...(changeId ? { changeId } : {}),
      });
    }
    /** @type {ApplyResult} */
    const out = { changeId: result.changeId, moved: result.done.length, skipped: result.skipped, stale: result.done.length === 0 };
    if (prepared.length === 1) {
      if (prepared[0].createdFolder) out.createdFolder = prepared[0].createdFolder;
      if (prepared[0].reusedFolder) out.reusedFolder = prepared[0].reusedFolder;
    } else {
      out.groups = prepared.length;
      out.createdFolders = createdFolders.filter((id) => !result.removedFolders.includes(id));
    }
    return out;
  };

  /**
   * @param {Proposal[]} list
   * @param {string} label
   * @returns {Promise<ApplyResult>}
   */
  const applyMany = async (list, label) => {
    /** @type {Prepared[]} */
    const prepared = [];
    /** @type {import('./store.js').Skipped[]} */
    const failed = [];
    for (const proposal of list) {
      const entry = await prepare(proposal, {});
      if ('result' in entry) {
        if (entry.result.error) failed.push({ id: proposal.bookmark.id, title: proposal.bookmark.title, reason: 'error', message: entry.result.error.messageEs });
        continue;
      }
      prepared.push(entry);
    }
    if (prepared.length === 0) return { ...STALE, skipped: failed, groups: 0 };
    const result = await commit(prepared, label);
    return { ...result, skipped: [...result.skipped, ...failed], groups: prepared.length };
  };

  const api = {
    read,
    showCount,

    /** Shows «✓» in green; `showCount` puts the count back. */
    flashMoved: () => setBadge({ text: '✓', color: BADGE_COLORS.moved }),

    /**
     * Adds a proposal. One for the same bookmark replaces the old one; a `create` for the same
     * folder name in the same parent merges into the pending one, its bookmark joining
     * `together`. Past MAX_PROPOSALS the oldest fall out.
     *
     * @param {Proposal} proposal
     * @returns {Promise<{id: string, merged: boolean, dropped: Proposal[]}>}
     */
    async add(proposal) {
      const outcome = await locked(async () => {
        const proposals = (await read()).filter((other) => other.bookmark.id !== proposal.bookmark.id);
        const key = targetKey(proposal);
        const twin =
          proposal.kind === 'create'
            ? proposals.find((other) => other.kind === 'create' && other.newFolder?.parentId === proposal.newFolder?.parentId && targetKey(other) === key)
            : undefined;
        let id = proposal.id;
        if (twin) {
          const known = new Set([twin.bookmark.id, ...twin.together.map((member) => member.id)]);
          for (const member of [proposal.bookmark, ...proposal.together]) {
            if (!known.has(member.id)) {
              twin.together.push(member);
              known.add(member.id);
            }
          }
          id = twin.id;
        } else {
          // A bookmark already waiting as a member of another create leaves it: it has its own proposal now.
          for (const other of proposals) other.together = other.together.filter((member) => member.id !== proposal.bookmark.id);
          proposals.push(proposal);
        }
        const dropped = proposals.splice(0, Math.max(0, proposals.length - MAX_PROPOSALS));
        await write(proposals);
        return { id, merged: Boolean(twin), dropped };
      });
      await showCount();
      return outcome;
    },

    /**
     * Drops a proposal; its «proposed» row says it was discarded.
     *
     * @param {string} id
     */
    async discard(id) {
      const removed = await remove(id);
      const ids = new Set(removed.map((proposal) => proposal.bookmark.id));
      if (ids.size > 0) {
        await settings.rewriteLog(
          (event) => event.kind === 'proposed' && event.bookmarkId !== undefined && ids.has(event.bookmarkId),
          (event) => ({ ...event, kind: 'left', reason: 'discarded' }),
        );
      }
      return removed;
    },

    /**
     * Drops every proposal whose bookmark the person moved or deleted.
     *
     * @returns {Promise<Proposal[]>} the dropped ones
     */
    prune: () => removeWhere((proposal) => anyStillThere(proposal)),

    /**
     * Drops proposals older than PROPOSAL_TTL_MS.
     *
     * @returns {Promise<Proposal[]>} the expired ones
     */
    expire: () => removeWhere((proposal) => now().getTime() - Date.parse(proposal.createdAt) < PROPOSAL_TTL_MS),

    /**
     * Applies a proposal through the journal, so «Deshacer» reverts it, created folder included.
     *
     * @param {string} id
     * @param {{name?: string, targetFolderId?: string, memberIds?: string[], includeMain?: boolean}} [options]
     *   `name`: replaces the proposed folder name. `targetFolderId`: an existing folder instead.
     *   `memberIds`: which of `together` go too; all when omitted, none with []. `includeMain`:
     *   false leaves out the first bookmark too, only for a «Ordenar sueltos» group.
     * @returns {Promise<ApplyResult>}
     */
    async apply(id, options = {}) {
      const proposal = (await read()).find((candidate) => candidate.id === id);
      if (!proposal) return { ...STALE };
      const prepared = await prepare(proposal, options);
      if ('result' in prepared) return prepared.result;
      return commit([prepared], prepared.label);
    },

    /**
     * Applies every pending proposal whose destination has this name, by `folderKey`, as one change.
     *
     * @param {string} name
     * @returns {Promise<ApplyResult>}
     */
    async acceptGroup(name) {
      const key = folderKey(name);
      return applyMany((await read()).filter((proposal) => targetKey(proposal) === key), `Aceptar las de «${name}»`);
    },

    /**
     * «Aceptar todas»: applies every pending proposal of one origin as a single change, with all
     * the folders it creates, so one «Deshacer» reverts the lot. One change per group would push
     * the older ones out of the journal (it keeps KEEP_CHANGES) and leave folders behind.
     *
     * @param {'ctrl-d' | 'sort-loose'} [origin]
     * @returns {Promise<ApplyResult>}
     */
    async acceptAll(origin) {
      const chosen = (await read()).filter((proposal) => origin === undefined || proposal.origin === origin);
      return applyMany(chosen, `Aceptar todas: ${chosen.length} ${chosen.length === 1 ? 'grupo' : 'grupos'}`);
    },

    metricFor,
  };
  return api;
}
