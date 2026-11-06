/**
 * In-memory `chrome.bookmarks` and `chrome.storage.local`, limited to what the extension calls.
 * It follows the documentation (https://developer.chrome.com/docs/extensions/reference/api/bookmarks)
 * and, where that is silent, Chromium's code on main as read on 2026-11-05:
 *
 * - ids are decimal strings; the tree root is '0' and has no `parentId`.
 * - roots carry `folderType`; account roots, when present, have `syncing: true`, and every node
 *   inherits `syncing` from its root (bookmarks_helpers.cc: `syncing = !IsLocalOnlyNode(node)`).
 *   Nodes under the managed root carry `unmodifiable: 'managed'` and `syncing: false`.
 * - `get`, `getChildren` and `move` return nodes without `children`; `getTree` returns the whole
 *   tree. An unknown id rejects with "Can't find bookmark for id.".
 * - `move` (bookmarks_api.cc, BookmarksMoveFunction): a root rejects with "Can't modify the root
 *   bookmark folders.", a managed node or destination with "Can't modify managed bookmarks.", a
 *   folder into itself or a descendant with "Can't move a folder to itself or its descendant.",
 *   an index above the child count with "Index out of bounds."; without an index it goes last.
 *   Within one parent, an index equal to the current one or the next does nothing, and a larger
 *   one is lowered by one (bookmark_model.cc, BookmarkModel::Move). The destination's
 *   `dateGroupModified` is updated on every real move.
 * - `create`, `move` and `remove` fire `onCreated`, `onMoved` and `onRemoved` after they resolve;
 *   `importBookmarks` wraps creations in `onImportBegan` and `onImportEnded`.
 * - `tabs.query` leaves out `url` without the `tabs` permission; `permissions.request` grants
 *   what it is asked for unless `refuse` is set; `action` records the badge texts.
 *
 * A one-off probe in headless Chrome 156.0.8078.79 showed the same error messages, the same
 * within-parent index rule and the same default to the end. It also showed what the fake leaves
 * out: an empty Mobile root is hidden from getTree, and a line break in a new title becomes a
 * space. Sync and events are not modeled either.
 *
 * @typedef {{
 *   id: string, parentId?: string, title: string, url?: string, dateAdded: number,
 *   dateGroupModified?: number, folderType?: string, syncing: boolean, unmodifiable?: 'managed',
 *   children?: string[],
 * }} StoredNode
 */

const ERRORS = {
  noNode: "Can't find bookmark for id.",
  noParent: "Can't find parent bookmark for id.",
  invalidId: 'Bookmark id is invalid.',
  invalidIndex: 'Index out of bounds.',
  invalidParent: "Parameter 'parentId' does not specify a folder.",
  modifySpecial: "Can't modify the root bookmark folders.",
  modifyManaged: "Can't modify managed bookmarks.",
  folderNotEmpty: "Can't remove non-empty folder (use recursive to force).",
  invalidMoveDestination: "Can't move a folder to itself or its descendant.",
};

const LOCAL_ROOTS = [
  { title: 'Bookmarks bar', folderType: 'bookmarks-bar' },
  { title: 'Other bookmarks', folderType: 'other' },
  { title: 'Mobile bookmarks', folderType: 'mobile' },
];

/**
 * @param {{account?: boolean, managed?: {title: string, url: string}[], start?: number}} [options]
 *   `account`: also the three account roots (Chrome 134+). `managed`: bookmarks under a managed root.
 */
export function createFakeChrome({ account = false, managed, start = 1_700_000_000_000 } = {}) {
  /** @type {Map<string, StoredNode>} */
  const nodes = new Map();
  let nextId = 0;
  let clock = start;
  const tick = () => (clock += 1000);

  /**
   * @param {Omit<StoredNode, 'id' | 'dateAdded'>} fields
   * @param {number} [index]
   */
  const add = (fields, index) => {
    const node = /** @type {StoredNode} */ ({ ...fields, id: String(nextId++), dateAdded: tick() });
    nodes.set(node.id, node);
    if (node.parentId !== undefined) {
      const siblings = /** @type {string[]} */ (/** @type {StoredNode} */ (nodes.get(node.parentId)).children);
      siblings.splice(index ?? siblings.length, 0, node.id);
    }
    return node;
  };

  add({ title: '', syncing: false, children: [] });
  for (const root of LOCAL_ROOTS) add({ ...root, parentId: '0', syncing: false, children: [] });
  if (account) for (const root of LOCAL_ROOTS) add({ ...root, parentId: '0', syncing: true, children: [] });
  if (managed) {
    const folder = add({ title: 'Managed bookmarks', folderType: 'managed', parentId: '0', syncing: false, unmodifiable: 'managed', children: [] });
    for (const bookmark of managed) add({ ...bookmark, parentId: folder.id, syncing: false, unmodifiable: 'managed' });
  }

  /** @param {StoredNode} node */
  const isPermanent = (node) => node.parentId === undefined || node.folderType !== undefined;

  /** @param {unknown} id */
  const find = (id) => {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error(ERRORS.invalidId);
    const node = nodes.get(id);
    if (!node) throw new Error(ERRORS.noNode);
    return node;
  };

  /** @param {StoredNode} node */
  const indexOf = (node) =>
    node.parentId === undefined ? undefined : /** @type {string[]} */ (/** @type {StoredNode} */ (nodes.get(node.parentId)).children).indexOf(node.id);

  /**
   * As the API returns a node; `children` only with `recurse`.
   *
   * @param {StoredNode} node
   * @param {boolean} recurse
   * @returns {Record<string, unknown>}
   */
  const view = (node, recurse) => {
    /** @type {Record<string, unknown>} */
    const out = { id: node.id, title: node.title, dateAdded: node.dateAdded, syncing: node.syncing };
    if (node.parentId !== undefined) {
      out.parentId = node.parentId;
      out.index = indexOf(node);
    }
    if (node.url !== undefined) out.url = node.url;
    if (node.dateGroupModified !== undefined) out.dateGroupModified = node.dateGroupModified;
    if (node.folderType !== undefined) out.folderType = node.folderType;
    if (node.unmodifiable !== undefined) out.unmodifiable = node.unmodifiable;
    if (recurse && node.children) out.children = node.children.map((id) => view(/** @type {StoredNode} */ (nodes.get(id)), true));
    return out;
  };

  /** @param {StoredNode} node */
  const assertModifiable = (node) => {
    if (node.parentId === undefined) throw new Error(ERRORS.modifySpecial);
    if (node.unmodifiable === 'managed') throw new Error(ERRORS.modifyManaged);
  };

  /** @param {string | undefined} parentId */
  const findParent = (parentId) => {
    if (parentId !== undefined && !/^\d+$/.test(parentId)) throw new Error(ERRORS.invalidId);
    const parent = parentId === undefined ? undefined : nodes.get(parentId);
    if (!parent) throw new Error(ERRORS.noParent);
    return parent;
  };

  /** @param {StoredNode} node */
  const detach = (node) => {
    const siblings = /** @type {string[]} */ (/** @type {StoredNode} */ (nodes.get(/** @type {string} */ (node.parentId))).children);
    siblings.splice(siblings.indexOf(node.id), 1);
  };

  /** @param {StoredNode} node */
  const forget = (node) => {
    for (const id of node.children ?? []) forget(/** @type {StoredNode} */ (nodes.get(id)));
    nodes.delete(node.id);
  };

  /** @param {StoredNode} node */
  const rootOf = (node) => {
    let current = node;
    while (current.parentId !== '0' && current.parentId !== undefined) current = /** @type {StoredNode} */ (nodes.get(current.parentId));
    return current;
  };

  const onCreated = event();
  const onMoved = event();
  const onRemoved = event();
  /** @param {() => void} dispatch */
  const later = (dispatch) => void setTimeout(dispatch, 0);
  const bookmarks = {
    onCreated,
    onMoved,
    onRemoved,
    onImportBegan: event(),
    onImportEnded: event(),

    async getTree() {
      return [view(/** @type {StoredNode} */ (nodes.get('0')), true)];
    },

    /** @param {string | string[]} idOrIdList */
    async get(idOrIdList) {
      const ids = Array.isArray(idOrIdList) ? idOrIdList : [idOrIdList];
      if (ids.length === 0) throw new Error('Invalid argument: the list of ids is empty.');
      return ids.map((id) => view(find(id), false));
    },

    /** @param {string} id */
    async getChildren(id) {
      const node = find(id);
      return (node.children ?? []).map((childId) => view(/** @type {StoredNode} */ (nodes.get(childId)), false));
    },

    /**
     * @param {string} id
     * @param {{parentId?: string, index?: number}} destination
     */
    async move(id, destination = {}) {
      const node = find(id);
      if (isPermanent(node)) throw new Error(ERRORS.modifySpecial);
      const parent = destination.parentId === undefined ? /** @type {StoredNode} */ (nodes.get(/** @type {string} */ (node.parentId))) : findParent(destination.parentId);
      assertModifiable(parent);
      assertModifiable(node);
      if (!parent.children) throw new Error(ERRORS.invalidParent);
      for (let at = /** @type {StoredNode | undefined} */ (parent); at; at = at.parentId === undefined ? undefined : nodes.get(at.parentId)) {
        if (at.id === node.id) throw new Error(ERRORS.invalidMoveDestination);
      }
      let index = destination.index ?? parent.children.length;
      if (!Number.isInteger(index) || index < 0 || index > parent.children.length) throw new Error(ERRORS.invalidIndex);

      const oldIndex = /** @type {number} */ (indexOf(node));
      const sameParent = node.parentId === parent.id;
      if (!(sameParent && (index === oldIndex || index === oldIndex + 1))) {
        if (sameParent && index > oldIndex) index -= 1;
        const oldParentId = /** @type {string} */ (node.parentId);
        detach(node);
        parent.children.splice(index, 0, node.id);
        node.parentId = parent.id;
        parent.dateGroupModified = tick();
        later(() => onMoved.dispatch(node.id, { parentId: parent.id, index, oldParentId, oldIndex }));
      }
      return view(node, false);
    },

    /** @param {{parentId?: string, index?: number, title?: string, url?: string}} details */
    async create({ parentId = '2', index, title = '', url } = {}) {
      const parent = findParent(parentId);
      assertModifiable(parent);
      if (parent.id === '0') throw new Error(ERRORS.modifySpecial);
      if (!parent.children) throw new Error(ERRORS.invalidParent);
      if (index !== undefined && (index < 0 || index > parent.children.length)) throw new Error(ERRORS.invalidIndex);
      const syncing = rootOf(parent).syncing;
      const node = add(url === undefined ? { parentId, title, syncing, children: [] } : { parentId, title, url, syncing }, index);
      // Events arrive after the call that caused them, as they do across Chrome's processes.
      const created = view(node, false);
      setTimeout(() => onCreated.dispatch(node.id, created), 0);
      return view(node, false);
    },

    /** @param {string} id */
    async remove(id) {
      const node = find(id);
      if (isPermanent(node)) throw new Error(ERRORS.modifySpecial);
      assertModifiable(node);
      if (node.children && node.children.length > 0) throw new Error(ERRORS.folderNotEmpty);
      const removed = { parentId: /** @type {string} */ (node.parentId), index: /** @type {number} */ (indexOf(node)) };
      detach(node);
      forget(node);
      later(() => onRemoved.dispatch(id, removed));
    },

    /** @param {string} id */
    async removeTree(id) {
      const node = find(id);
      if (isPermanent(node)) throw new Error(ERRORS.modifySpecial);
      assertModifiable(node);
      const removed = { parentId: /** @type {string} */ (node.parentId), index: /** @type {number} */ (indexOf(node)) };
      detach(node);
      forget(node);
      later(() => onRemoved.dispatch(id, removed));
    },
  };

  /** @type {Map<string, string>} values kept as JSON, as storage keeps "JSON serializable values" */
  const stored = new Map();
  // Storage answers across processes in Chrome: never within the same turn of the event loop.
  const ipc = () => new Promise((resolve) => setImmediate(resolve));
  const local = {
    /** @param {string | string[] | Record<string, unknown> | null} [keys] */
    async get(keys) {
      await ipc();
      /** @type {Record<string, unknown>} */
      const out = {};
      const read = (/** @type {string} */ key) => {
        const json = stored.get(key);
        if (json !== undefined) out[key] = JSON.parse(json);
      };
      if (keys === null || keys === undefined) for (const key of stored.keys()) read(key);
      else if (typeof keys === 'string') read(keys);
      else if (Array.isArray(keys)) keys.forEach(read);
      else {
        for (const [key, fallback] of Object.entries(keys)) {
          out[key] = fallback;
          read(key);
        }
      }
      return out;
    },

    /** @param {Record<string, unknown>} items */
    async set(items) {
      await ipc();
      for (const [key, value] of Object.entries(items)) stored.set(key, JSON.stringify(value));
    },

    /** @param {string | string[]} keys */
    async remove(keys) {
      await ipc();
      for (const key of Array.isArray(keys) ? keys : [keys]) stored.delete(key);
    },

    /** @type {string | null} */
    accessLevel: null,
    /** @param {{accessLevel: string}} details */
    async setAccessLevel({ accessLevel }) {
      local.accessLevel = accessLevel;
    },
  };

  /** Granted optional permissions and origins; `request` grants unless `refuse` is set. */
  const permissions = {
    granted: new Set(/** @type {string[]} */ ([])),
    refuse: false,
    /** @type {{permissions?: string[], origins?: string[]}[]} */
    requests: [],
    /** @param {{permissions?: string[], origins?: string[]}} wanted */
    async contains({ permissions: names = [], origins = [] }) {
      return [...names, ...origins].every((name) => permissions.granted.has(name));
    },
    /** @param {{permissions?: string[], origins?: string[]}} wanted */
    async request(wanted) {
      permissions.requests.push(wanted);
      if (permissions.refuse) return false;
      for (const name of [...(wanted.permissions ?? []), ...(wanted.origins ?? [])]) permissions.granted.add(name);
      return true;
    },
    /** @param {{permissions?: string[], origins?: string[]}} given */
    async remove(given) {
      for (const name of [...(given.permissions ?? []), ...(given.origins ?? [])]) permissions.granted.delete(name);
      return true;
    },
  };

  /**
   * `onInstalled`, `onStartup`, a record of `openOptionsPage` calls, and messaging: `sendMessage`
   * resolves with what a listener passes to `sendResponse` (one that returns true answers later).
   */
  const onMessage = event();
  const runtime = {
    id: 'fake-extension-id',
    onInstalled: event(),
    onStartup: event(),
    onMessage,
    optionsOpened: 0,
    async openOptionsPage() {
      runtime.optionsOpened += 1;
    },
    /** @param {unknown} message */
    sendMessage(message) {
      return new Promise((resolve) => {
        let waiting = false;
        for (const listener of onMessage.listeners) if (listener(message, { id: runtime.id }, resolve) === true) waiting = true;
        if (!waiting) resolve(undefined);
      });
    },
  };

  /**
   * One window with one active tab. Without the `tabs` permission `url` and `pendingUrl` are left
   * out: they are "sensitive properties" (https://developer.chrome.com/docs/extensions/reference/api/tabs).
   */
  const tabs = {
    /** @type {{url: string, pendingUrl?: string} | null} */
    active: null,
    /** @param {string | null} url */
    setActive(url) {
      tabs.active = url === null ? null : { url };
    },
    /** @param {{active?: boolean, lastFocusedWindow?: boolean}} query */
    async query(query) {
      if (!tabs.active || query.active !== true) return [];
      return [permissions.granted.has('tabs') ? { id: 1, active: true, ...tabs.active } : { id: 1, active: true }];
    },
  };

  const action = {
    /** @type {string[]} */
    badges: [],
    /** @param {{text: string}} details */
    async setBadgeText({ text }) {
      action.badges.push(text);
    },
    async setBadgeBackgroundColor() {},
  };

  /**
   * Bookmarks created between onImportBegan and onImportEnded, as Chrome's importer does.
   *
   * @param {{parentId?: string, title?: string, url?: string}[]} entries
   */
  const importBookmarks = async (entries) => {
    bookmarks.onImportBegan.dispatch();
    const created = [];
    for (const entry of entries) created.push(await bookmarks.create(entry));
    // Ends right after the last onCreated, before any listener's storage read has come back.
    await new Promise((resolve) => setTimeout(resolve, 0));
    bookmarks.onImportEnded.dispatch();
    return created;
  };

  return { bookmarks, storage: { local }, tabs, permissions, action, runtime, importBookmarks };
}

/** An event with `addListener`, and `dispatch` for the fake itself. */
function event() {
  /** @type {((...args: any[]) => unknown)[]} */
  const listeners = [];
  return {
    listeners,
    /** @param {(...args: any[]) => void} listener */
    addListener(listener) {
      listeners.push(listener);
    },
    /** @param {...any} args */
    dispatch(...args) {
      for (const listener of listeners) listener(...args);
    },
  };
}

/**
 * The fields a round trip must keep: `(id, parentId, index, title, url, dateAdded)` of every
 * node. `dateGroupModified` is left out because every move updates it.
 *
 * @param {any[]} tree what `getTree()` resolves to
 * @returns {{id: string, parentId?: string, index?: number, title: string, url?: string, dateAdded: number}[]}
 */
export function normalForm(tree) {
  /** @type {any[]} */
  const out = [];
  /** @param {any} node */
  const visit = (node) => {
    out.push({ id: node.id, parentId: node.parentId, index: node.index, title: node.title, url: node.url, dateAdded: node.dateAdded });
    for (const child of node.children ?? []) visit(child);
  };
  tree.forEach(visit);
  return out.sort((a, b) => Number(a.id) - Number(b.id));
}
