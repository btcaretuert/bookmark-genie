/**
 * Reads the tree, applies a plan and undoes it through `chrome.bookmarks`
 * (https://developer.chrome.com/docs/extensions/reference/api/bookmarks). Moves run one at a
 * time, and each is checked against the node as it is right before moving it: whatever the
 * person changed in between wins, and the move is skipped and reported.
 *
 * Every function takes the API as a parameter so the tests can pass tests/helpers/fake-chrome.mjs.
 *
 * @typedef {import('../core/plan.js').Move} Move
 * @typedef {import('../core/tree.js').TreeNode} TreeNode
 * @typedef {import('./store.js').Store} Store
 * @typedef {import('./store.js').Change} Change
 * @typedef {import('./store.js').Skipped} Skipped
 * @typedef {import('./store.js').UndoRecord} UndoRecord
 * @typedef {import('./store.js').SnapshotKind} SnapshotKind
 * @typedef {import('../core/plan.js').JournalMove} JournalMove
 * @typedef {{
 *   getTree(): Promise<TreeNode[]>,
 *   get(id: string): Promise<TreeNode[]>,
 *   getChildren(id: string): Promise<TreeNode[]>,
 *   move(id: string, destination: {parentId?: string, index?: number}): Promise<TreeNode>,
 *   create(details: {parentId: string, title: string, index?: number, url?: string}): Promise<TreeNode>,
 *   remove(id: string): Promise<void>,
 * }} BookmarksApi
 * @typedef {{bookmarks?: BookmarksApi, store: Store, now?: () => Date}} Context
 */

import { toBackup } from '../core/backup.js';
import { captureOrigins, checkMove, invertJournal, validatePlan } from '../core/plan.js';
import { indexTree } from '../core/tree.js';
import { FLUSH_EVERY, STALE_MS } from './store.js';

/** @returns {BookmarksApi} */
const defaultBookmarks = () => chrome.bookmarks;

/**
 * @param {BookmarksApi} [bookmarks]
 * @returns {Promise<TreeNode[]>}
 */
export function readTree(bookmarks = defaultBookmarks()) {
  return bookmarks.getTree();
}

/**
 * The node as the API has it now, or undefined: `get` rejects an id that does not exist.
 *
 * @param {BookmarksApi} bookmarks
 * @param {string} id
 */
async function lookUp(bookmarks, id) {
  try {
    return (await bookmarks.get(id))[0];
  } catch {
    return undefined;
  }
}

/**
 * Reads the tree and stores it as a `backup@1` snapshot. For the «Respaldar» button and before a
 * bulk operation; `applyPlan` does not call it unless asked.
 *
 * @param {Context & {kind?: SnapshotKind, tree?: TreeNode[]}} context `tree`: one already read
 * @returns {Promise<{tree: TreeNode[], backup: import('../core/backup.js').Backup, key: string}>}
 */
export async function takeSnapshot({ bookmarks = defaultBookmarks(), store, now = () => new Date(), kind = 'manual', tree }) {
  const read = tree ?? (await bookmarks.getTree());
  const backup = toBackup(read, now().toISOString());
  const key = await store.saveSnapshot(backup, { kind });
  return { tree: read, backup, key };
}

/**
 * Applies `plan` in order and journals it as one change. The intent (the planned moves and the
 * order of the origin folders) is written before the first move, the moves are written in
 * batches of FLUSH_EVERY, and the change is closed at the end: a worker that dies in between
 * leaves a `running` change that `recoverInterrupted` reconciles with the real tree. A move
 * whose node is gone, or no longer in its origin folder, is skipped and reported. A plan that
 * moves nothing leaves no change, and removes the empty folders in `createdFolders`.
 *
 * `snapshot`: store a `bulk` snapshot of the tree first. Only for bulk operations.
 *
 * @param {Move[]} plan
 * @param {Context & {createdFolders?: string[], label?: string, kind?: string, snapshot?: boolean}} context
 * @returns {Promise<{
 *   changeId: string | null,
 *   done: JournalMove[],
 *   skipped: Skipped[],
 *   snapshotKey: string | null,
 *   createdFolders: string[],
 *   removedFolders: string[],
 *   moves: JournalMove[],
 * }>} `moves` is `done` under its 0.3.0 name
 */
export async function applyPlan(plan, { bookmarks = defaultBookmarks(), store, now = () => new Date(), createdFolders = [], label = '', kind = 'sort', snapshot = false }) {
  const tree = await bookmarks.getTree();
  const snapshotKey = snapshot ? (await takeSnapshot({ bookmarks, store, now, kind: 'bulk', tree })).key : null;
  const titles = indexTree(tree);
  const titleOf = (/** @type {string} */ id) => titles.get(id)?.title;
  const invalid = new Map(validatePlan(plan, tree).map((problem) => [problem.position, problem.reason]));
  const valid = plan.filter((_, position) => !invalid.has(position));

  const changeId = await store.beginChange({
    kind,
    label,
    createdAt: now().toISOString(),
    origins: captureOrigins(tree, valid),
    plan: valid,
    createdFolders,
    snapshotKey,
  });

  /** @type {JournalMove[]} */
  const done = [];
  /** @type {JournalMove[]} */
  let pending = [];
  /** @type {Skipped[]} */
  const skipped = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    await store.appendMoves(changeId, batch, now().toISOString());
  };

  for (const [position, move] of plan.entries()) {
    const known = invalid.get(position);
    if (known) {
      skipped.push({ id: String(move?.id), title: titleOf(move?.id), reason: known });
      continue;
    }
    const node = await lookUp(bookmarks, move.id);
    const reason = checkMove(move, node, await lookUp(bookmarks, move.to.parentId));
    if (reason) {
      skipped.push({ id: move.id, title: node?.title ?? titleOf(move.id), reason });
      continue;
    }
    try {
      const moved = await bookmarks.move(move.id, { parentId: move.to.parentId });
      const entry = {
        id: move.id,
        from: { parentId: move.from.parentId, index: /** @type {number} */ (node?.index) },
        to: { parentId: /** @type {string} */ (moved.parentId), index: /** @type {number} */ (moved.index) },
      };
      done.push(entry);
      pending.push(entry);
      if (pending.length >= FLUSH_EVERY) await flush();
    } catch (error) {
      skipped.push({ id: move.id, title: node?.title, reason: 'error', message: /** @type {Error} */ (error).message });
    }
  }
  await flush();
  await store.endChange(changeId, { skipped, finishedAt: now().toISOString() });

  /** @type {string[]} */
  const removedFolders = [];
  if (done.length === 0) {
    for (const id of createdFolders) {
      try {
        if ((await bookmarks.getChildren(id)).length === 0) {
          await bookmarks.remove(id);
          removedFolders.push(id);
        }
      } catch {
        // Already gone.
      }
    }
  }
  return { changeId: done.length === 0 ? null : changeId, done, skipped, snapshotKey, createdFolders, removedFolders, moves: done };
}

/**
 * Reconciles the changes a dead worker left `running`: each planned move whose node already sits
 * in its destination is added to the change, which becomes `interrupted`. A change that moved
 * nothing is dropped. Call it when the worker starts. A change touched less than `staleMs` ago
 * may still be running in another context, and is left alone.
 *
 * @param {Context & {staleMs?: number, only?: string}} context `only`: reconcile just this id, whatever its age
 * @returns {Promise<string[]>} the ids reconciled
 */
export async function recoverInterrupted({ bookmarks = defaultBookmarks(), store, now = () => new Date(), staleMs = STALE_MS, only }) {
  const at = now();
  const stale = (await store.listChanges(100)).filter(
    (header) => header.status === 'running' && (only === undefined ? at.getTime() - Date.parse(header.touchedAt) >= staleMs : header.id === only),
  );
  /** @type {string[]} */
  const recovered = [];
  for (const header of stale) {
    const change = await store.getChange(header.id);
    if (!change) continue;
    const known = new Set(change.moves.map((move) => move.id));
    const moves = [...change.moves];
    for (const planned of change.plan) {
      if (known.has(planned.id)) continue;
      const node = await lookUp(bookmarks, planned.id);
      if (node && node.parentId === planned.to.parentId) {
        moves.push({ id: planned.id, from: { parentId: planned.from.parentId, index: planned.from.index }, to: { parentId: planned.to.parentId, index: /** @type {number} */ (node.index) } });
      }
    }
    await store.reconcileChange(header.id, moves, at.toISOString());
    recovered.push(header.id);
  }
  return recovered;
}

/**
 * Undoes a change, last move first. Each node goes back to its origin folder, after its nearest
 * former predecessor still there, not at its old index: any sibling added or removed since
 * would make that index wrong. The same checks as applying hold: a node the person moved out of
 * the destination since, or one that is gone, stays as it is and is reported.
 *
 * Cost is linear in the moves: every origin folder is read once, the final order of its children
 * is worked out in memory, and each node is moved once to its final position.
 *
 * A folder the change created is removed once it is empty again. One that still holds something,
 * such as a bookmark the person added, stays, and is reported with how many items it holds.
 *
 * @param {string | {id?: string, changeId?: string | null}} target the change id
 * @param {Context} context
 * @returns {Promise<UndoRecord>}
 */
export async function undoChange(target, { bookmarks = defaultBookmarks(), store, now = () => new Date() }) {
  const id = typeof target === 'string' ? target : (target.changeId ?? target.id);
  if (typeof id !== 'string' || id === '') throw new Error('undoChange needs the id of a change');
  const header = (await store.listChanges(100)).find((entry) => entry.id === id);
  if (!header) throw new Error(`Change ${id} does not exist (it may have aged out of the journal)`);
  if (header.undone) throw new Error(`Change ${id} was already undone at ${header.undoAt}`);
  if (header.status === 'running') await recoverInterrupted({ bookmarks, store, now, only: id });
  if (!(await store.claimUndo(id, now().toISOString()))) throw new Error(`Change ${id} is being undone, or has nothing to undo`);

  try {
    const change = /** @type {import('./store.js').Change} */ (await store.getChange(id));
    const steps = invertJournal(change);
    /** @type {Map<string, TreeNode | undefined>} */
    const folders = new Map();
    const folderOf = async (/** @type {string} */ folderId) => {
      if (!folders.has(folderId)) folders.set(folderId, await lookUp(bookmarks, folderId));
      return folders.get(folderId);
    };
    /** @type {Skipped[]} */
    const skipped = [];
    /** @type {typeof steps} */
    const valid = [];
    for (const step of steps) {
      const node = await lookUp(bookmarks, step.id);
      const reason = checkMove(step, node, await folderOf(step.to.parentId));
      if (reason) skipped.push({ id: step.id, title: node?.title, reason });
      else valid.push(step);
    }

    // Per origin folder: its children now, then each node inserted after its anchor, in the
    // order of the steps, which is what restoring one at a time would give.
    /** @type {Map<string, {next: Map<string, string | null>, head: string | null, restoring: Set<string>}>} */
    const orders = new Map();
    for (const step of valid) {
      let order = orders.get(step.to.parentId);
      if (!order) {
        const children = (await bookmarks.getChildren(step.to.parentId)).map((child) => child.id);
        order = { next: new Map(children.map((child, at) => [child, children[at + 1] ?? null])), head: children[0] ?? null, restoring: new Set() };
        orders.set(step.to.parentId, order);
      }
      const anchor = step.after.find((candidate) => order.next.has(candidate));
      if (anchor === undefined) {
        order.next.set(step.id, order.head);
        order.head = step.id;
      } else {
        order.next.set(step.id, order.next.get(anchor) ?? null);
        order.next.set(anchor, step.id);
      }
      order.restoring.add(step.id);
    }

    /** @type {Set<string>} */
    const failed = new Set();
    for (const [folderId, order] of orders) {
      // Walk the final order; a restored node goes to the position it has reached. Everything
      // before it is already in place, because earlier restored nodes were moved first.
      let position = 0;
      for (let current = order.head; current !== null; current = order.next.get(current) ?? null) {
        if (order.restoring.has(current)) {
          try {
            await bookmarks.move(current, { parentId: folderId, index: position });
          } catch (error) {
            failed.add(current);
            skipped.push({ id: current, title: undefined, reason: 'error', message: /** @type {Error} */ (error).message });
            continue;
          }
        }
        position += 1;
      }
    }
    const restored = valid.filter((step) => !failed.has(step.id)).map((step) => step.id);

    /** @type {string[]} */
    const removedFolders = [];
    /** @type {{id: string, items: number}[]} */
    const keptFolders = [];
    for (const folderId of change.createdFolders) {
      try {
        const items = (await bookmarks.getChildren(folderId)).length;
        if (items > 0) {
          keptFolders.push({ id: folderId, items });
        } else {
          await bookmarks.remove(folderId);
          removedFolders.push(folderId);
        }
      } catch {
        // Already gone: nothing left to remove.
      }
    }

    const undo = { at: now().toISOString(), restored, skipped, removedFolders, keptFolders };
    await store.finishUndo(id, undo);
    return undo;
  } catch (error) {
    await store.finishUndo(id, null).catch(() => {});
    throw error;
  }
}
