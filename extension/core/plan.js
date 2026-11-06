/**
 * A plan, the checks that guard each of its moves, and the inversion of a journal. Pure: the
 * platform layer reads the nodes and performs the moves.
 *
 * A move never stays in its own folder. Within one parent the API's `index` counts positions
 * before the node is taken out: Chromium skips a move to the current index or the next one and
 * lowers any larger index by one (components/bookmarks/browser/bookmark_model.cc,
 * BookmarkModel::Move). Nothing here depends on that rule, because no move, and no undo of one,
 * has the same origin and destination.
 *
 * @typedef {import('./tree.js').TreeNode} TreeNode
 * @typedef {{id: string, from: {parentId: string, index: number}, to: {parentId: string}}} Move
 * @typedef {{id: string, from: {parentId: string, index: number}, to: {parentId: string, index: number}}} JournalMove
 *   a move as it happened; both indexes are informative
 * @typedef {{moves: JournalMove[], origins: Record<string, string[]>}} Journal
 *   `origins`: the child ids of each origin folder, in order, before the first move
 * @typedef {{
 *   id: string,
 *   from: {parentId: string, index: number},
 *   to: {parentId: string, index: number},
 *   after: string[],
 * }} UndoStep `after`: the node's former predecessors in its origin, nearest first
 * @typedef {'malformed' | 'duplicate' | 'same-folder' | 'missing' | 'root' | 'managed' | 'moved'
 *   | 'missing-destination' | 'not-a-folder' | 'root-destination' | 'managed-destination'
 *   | 'cross-storage' | 'into-itself'} SkipReason
 */

import { indexTree, isFolder, isManaged, isRoot } from './tree.js';

/** @param {unknown} value */
const isId = (value) => typeof value === 'string' && value !== '';

/**
 * @param {unknown} value
 * @returns {value is Move}
 */
function isMoveShape(value) {
  const move = /** @type {{id?: unknown, from?: {parentId?: unknown, index?: unknown}, to?: {parentId?: unknown}} | null} */ (value);
  return (
    isId(move?.id) &&
    isId(move?.from?.parentId) &&
    Number.isInteger(move?.from?.index) &&
    /** @type {number} */ (move?.from?.index) >= 0 &&
    isId(move?.to?.parentId)
  );
}

/**
 * Why `move` must not happen now, or `null`. `node` and `destination` are as the API returns them
 * at this moment (undefined if missing). The node must still be in `move.from.parentId`: if the
 * person moved it since the plan was made, their change wins. Local and account storage are told
 * apart by `syncing`, and nothing crosses between them.
 *
 * @param {{id: string, from: {parentId: string}, to: {parentId: string}}} move
 * @param {TreeNode | undefined} node
 * @param {TreeNode | undefined} destination
 * @returns {SkipReason | null}
 */
export function checkMove(move, node, destination) {
  if (move.from.parentId === move.to.parentId) return 'same-folder';
  if (!node) return 'missing';
  if (isRoot(node)) return 'root';
  if (isManaged(node)) return 'managed';
  if (node.parentId !== move.from.parentId) return 'moved';
  if (!destination) return 'missing-destination';
  if (!isFolder(destination)) return 'not-a-folder';
  if (destination.parentId === undefined) return 'root-destination';
  if (isManaged(destination)) return 'managed-destination';
  if (Boolean(node.syncing) !== Boolean(destination.syncing)) return 'cross-storage';
  if (destination.id === node.id) return 'into-itself';
  return null;
}

/**
 * Checks a whole plan against one tree. Each node may appear once, and a folder may not go into
 * itself or a descendant.
 *
 * @param {unknown[]} plan
 * @param {TreeNode[]} tree what `getTree()` resolves to
 * @returns {{position: number, id: string | null, reason: SkipReason}[]} empty when every move is valid
 */
export function validatePlan(plan, tree) {
  const byId = indexTree(tree);
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {{position: number, id: string | null, reason: SkipReason}[]} */
  const problems = [];

  plan.forEach((move, position) => {
    if (!isMoveShape(move)) {
      const id = /** @type {{id?: unknown} | null} */ (move)?.id;
      problems.push({ position, id: typeof id === 'string' ? id : null, reason: 'malformed' });
      return;
    }
    const reason = seen.has(move.id)
      ? 'duplicate'
      : (checkMove(move, byId.get(move.id), byId.get(move.to.parentId)) ??
        (isWithin(move.to.parentId, move.id, byId) ? 'into-itself' : null));
    seen.add(move.id);
    if (reason) problems.push({ position, id: move.id, reason });
  });
  return problems;
}

/**
 * Whether `id` is `ancestorId` or lies below it.
 *
 * @param {string} id
 * @param {string} ancestorId
 * @param {Map<string, TreeNode>} byId
 */
function isWithin(id, ancestorId, byId) {
  for (let node = byId.get(id); node; node = node.parentId === undefined ? undefined : byId.get(node.parentId)) {
    if (node.id === ancestorId) return true;
  }
  return false;
}

/**
 * The child order of every origin folder in the plan, taken from the tree before anything moves.
 * Undo anchors on it.
 *
 * @param {TreeNode[]} tree
 * @param {Move[]} plan
 * @returns {Record<string, string[]>}
 */
export function captureOrigins(tree, plan) {
  const byId = indexTree(tree);
  /** @type {Record<string, string[]>} */
  const origins = {};
  for (const { from } of plan) {
    if (Object.hasOwn(origins, from.parentId)) continue;
    const folder = byId.get(from.parentId);
    if (folder) origins[from.parentId] = (folder.children ?? []).map((child) => child.id);
  }
  return origins;
}

/**
 * The steps that undo a journal, last move first. Each step puts the node back in its origin,
 * right after its nearest former predecessor that is still there (see `restoreIndex`), not at
 * its old index: any sibling added or removed since would make that index wrong.
 *
 * @param {Journal} journal
 * @returns {UndoStep[]}
 */
export function invertJournal({ moves, origins }) {
  return moves.toReversed().map((move) => {
    const order = Object.hasOwn(origins, move.from.parentId) ? origins[move.from.parentId] : [];
    const at = order.indexOf(move.id);
    return {
      id: move.id,
      from: { parentId: move.to.parentId, index: move.to.index },
      to: { parentId: move.from.parentId, index: move.from.index },
      after: at === -1 ? [] : order.slice(0, at).reverse(),
    };
  });
}

/**
 * Where to put a node back: right after the first id of `after` (nearest first) found among the
 * folder's current children, or first if none of them is left.
 *
 * @param {string[]} after
 * @param {string[]} childIds the folder's children now, in order, without the node itself
 */
export function restoreIndex(after, childIds) {
  const positions = new Map(childIds.map((id, index) => [id, index]));
  for (const id of after) {
    const index = positions.get(id);
    if (index !== undefined) return index + 1;
  }
  return 0;
}
