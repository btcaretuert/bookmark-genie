/**
 * Read-only helpers over the tree that `chrome.bookmarks.getTree()` returns. Pure: no chrome.*.
 *
 * The node fields mirror `BookmarkTreeNode`
 * (https://developer.chrome.com/docs/extensions/reference/api/bookmarks): `folderType` and
 * `syncing` exist since Chrome 134, `unmodifiable` is only ever `'managed'`, and `url` is
 * omitted for folders.
 *
 * @typedef {'bookmarks-bar' | 'other' | 'mobile' | 'managed'} FolderType
 * @typedef {{
 *   id: string,
 *   parentId?: string,
 *   index?: number,
 *   title: string,
 *   url?: string,
 *   dateAdded?: number,
 *   dateGroupModified?: number,
 *   folderType?: FolderType,
 *   syncing?: boolean,
 *   unmodifiable?: 'managed',
 *   children?: TreeNode[],
 * }} TreeNode
 */

/**
 * A browser root: the tree root, or a folder the browser adds (`folderType`), which "cannot be
 * modified by the user or the extension".
 *
 * @param {TreeNode} node
 */
export function isRoot(node) {
  return node.parentId === undefined || node.folderType !== undefined;
}

/**
 * Configured by an administrator; the API refuses to move it or to move anything into it.
 *
 * @param {TreeNode} node
 */
export function isManaged(node) {
  return node.unmodifiable === 'managed' || node.folderType === 'managed';
}

/** @param {TreeNode} node */
export function isFolder(node) {
  return node.url === undefined;
}

/**
 * The top-level folders under the tree root. They are read on each use and never assumed to be
 * `'1'` or `'2'`: there may be several of each type, local and account.
 *
 * @param {TreeNode[]} tree what `getTree()` resolves to
 */
export function rootsOf(tree) {
  return tree.flatMap((top) => top.children ?? []);
}

/**
 * Every node by id, the tree root included.
 *
 * @param {TreeNode[]} tree
 * @returns {Map<string, TreeNode>}
 */
export function indexTree(tree) {
  /** @type {Map<string, TreeNode>} */
  const byId = new Map();
  const pending = [...tree];
  while (pending.length > 0) {
    const node = /** @type {TreeNode} */ (pending.pop());
    byId.set(node.id, node);
    pending.push(...(node.children ?? []));
  }
  return byId;
}

/**
 * Bookmarks and folders under each root, the root itself not counted.
 *
 * @param {TreeNode[]} tree
 * @returns {{id: string, title: string, folderType?: FolderType, syncing: boolean, bookmarks: number, folders: number}[]}
 */
export function countByRoot(tree) {
  return rootsOf(tree).map((root) => {
    let bookmarks = 0;
    let folders = 0;
    const pending = [...(root.children ?? [])];
    while (pending.length > 0) {
      const node = /** @type {TreeNode} */ (pending.pop());
      if (isFolder(node)) {
        folders += 1;
        pending.push(...(node.children ?? []));
      } else {
        bookmarks += 1;
      }
    }
    return { id: root.id, title: root.title, folderType: root.folderType, syncing: Boolean(root.syncing), bookmarks, folders };
  });
}
