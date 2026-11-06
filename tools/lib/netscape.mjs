/** @type {Record<string, string>} */
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Decoded text, with any unpaired surrogate (from the source or an entity) replaced, so that
 * it is well formed wherever it goes next.
 *
 * @param {string} text
 */
function decodeEntities(text) {
  return decode(text).replace(/\p{Surrogate}/gu, '\ufffd');
}

/** @param {string} text */
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] !== '#') {
      const name = body.toLowerCase();
      return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : match;
    }
    const isHex = body[1].toLowerCase() === 'x';
    const codePoint = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
    if (codePoint > 0x10ffff) return match;
    // A lone surrogate is not text; it would reach the request as an unpaired escape.
    return codePoint >= 0xd800 && codePoint <= 0xdfff ? '\ufffd' : String.fromCodePoint(codePoint);
  });
}

/**
 * A title is text up to its closing tag, but never across the next structural tag. Without that
 * stop, an unclosed `<A>` or `<H3>` would scan to the end of the file for every one that follows.
 */
const TEXT = String.raw`((?:[^<]|<(?!\/?(?:DT|DL|A|H3)\b))*)`;
const TOKENS = new RegExp(
  String.raw`<DT><H3\b([^>]*)>${TEXT}<\/H3>|<DT><A\b[^>]*?\bHREF="([^"]*)"[^>]*>${TEXT}<\/A>|<DL\b[^>]*>|<\/DL>`,
  'gi',
);

/**
 * Parses the bookmark HTML that Chrome exports. The bookmarks bar is a browser root, not a
 * folder the person chose, so it does not appear in `folderPath`.
 *
 * @param {string} html
 * @returns {{id: string, title: string, url: string, folderPath: string}[]}
 */
export function parseNetscapeBookmarks(html) {
  /** @type {(string | null)[]} */
  const folderStack = [];
  /** @type {string | null} */
  let pendingFolder = null;
  /** @type {{id: string, title: string, url: string, folderPath: string}[]} */
  const bookmarks = [];

  for (const match of html.matchAll(TOKENS)) {
    const [token, folderAttributes, folderName, href, title] = match;
    if (folderName !== undefined) {
      pendingFolder = /PERSONAL_TOOLBAR_FOLDER="true"/i.test(folderAttributes) ? null : decodeEntities(folderName).trim();
    } else if (href !== undefined) {
      bookmarks.push({
        id: `b${bookmarks.length}`,
        title: decodeEntities(title).trim(),
        url: decodeEntities(href),
        folderPath: folderStack.filter(Boolean).join('/'),
      });
    } else if (token[1] === '/') {
      folderStack.pop();
    } else {
      folderStack.push(pendingFolder);
      pendingFolder = null;
    }
  }
  return bookmarks;
}

const TREE_TOKENS = new RegExp(String.raw`<DT><H3\b([^>]*)>${TEXT}<\/H3>|<DT><A\b([^>]*)>${TEXT}<\/A>|<DL\b[^>]*>|<\/DL>`, 'gi');

/**
 * @param {string} attributes
 * @param {string} name
 */
function attribute(attributes, name) {
  return new RegExp(String.raw`\b${name}="([^"]*)"`, 'i').exec(attributes)?.[1];
}

/** @param {string | undefined} seconds ADD_DATE and LAST_MODIFIED are in seconds */
function toMs(seconds) {
  return seconds !== undefined && /^\d+$/.test(seconds) ? Number(seconds) * 1000 : undefined;
}

/**
 * The export as the tree `chrome.bookmarks.getTree()` would give, for code that takes a tree:
 * a root with a bookmarks bar and an Other root, folders kept even when empty, ADD_DATE as
 * `dateAdded` and `index` by position. Chrome's export cannot say more (bookmark_html_writer.cc
 * flattens Other and Mobile into the top level and merges local and account roots), so Mobile
 * lands in Other and every node is `syncing: false`. Without a PERSONAL_TOOLBAR_FOLDER, the bar
 * stays empty and everything is in Other.
 *
 * @param {string} html
 * @returns {{tree: import('../../extension/core/tree.js').TreeNode[], hasBar: boolean}}
 */
export function parseNetscapeTree(html) {
  /** @typedef {import('../../extension/core/tree.js').TreeNode & {children?: any[]}} Node */
  let nextId = 3;
  /** @type {Node} */
  const bar = { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', syncing: false, children: [] };
  /** @type {Node} */
  const other = { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', syncing: false, children: [] };
  /** @type {Node} */
  const root = { id: '0', title: '', syncing: false, children: [bar, other] };
  let hasBar = false;
  /** @type {Node[]} */
  const stack = [];
  /** @type {Node | null} */
  let pending = null;
  const current = () => stack.at(-1) ?? other;

  for (const match of html.matchAll(TREE_TOKENS)) {
    const [token, folderAttributes, folderName, linkAttributes, title] = match;
    if (folderName !== undefined) {
      const dateAdded = toMs(attribute(folderAttributes, 'ADD_DATE'));
      if (!hasBar && /PERSONAL_TOOLBAR_FOLDER="true"/i.test(folderAttributes)) {
        hasBar = true;
        bar.title = decodeEntities(folderName).trim() || bar.title;
        if (dateAdded !== undefined) bar.dateAdded = dateAdded;
        pending = bar;
        continue;
      }
      const parent = current();
      /** @type {Node} */
      const folder = { id: String(nextId++), parentId: parent.id, title: decodeEntities(folderName).trim(), syncing: false, children: [] };
      if (dateAdded !== undefined) folder.dateAdded = dateAdded;
      const modified = toMs(attribute(folderAttributes, 'LAST_MODIFIED'));
      if (modified !== undefined) folder.dateGroupModified = modified;
      /** @type {Node[]} */ (parent.children).push(folder);
      pending = folder;
    } else if (linkAttributes !== undefined) {
      // A folder header followed by a link had no list of its own: it stays empty.
      pending = null;
      const href = attribute(linkAttributes, 'HREF');
      if (href === undefined) continue;
      const parent = current();
      /** @type {Node} */
      const bookmark = { id: String(nextId++), parentId: parent.id, title: decodeEntities(title).trim(), url: decodeEntities(href), syncing: false };
      const dateAdded = toMs(attribute(linkAttributes, 'ADD_DATE'));
      if (dateAdded !== undefined) bookmark.dateAdded = dateAdded;
      /** @type {Node[]} */ (parent.children).push(bookmark);
    } else if (token[1] === '/') {
      stack.pop();
    } else {
      // A list without a header of its own (the outermost one) holds what is in it now.
      stack.push(pending ?? current());
      pending = null;
    }
  }
  /** @param {Node} node */
  const number = (node) => node.children?.forEach((child, index) => {
    child.index = index;
    number(child);
  });
  number(root);
  return { tree: [root], hasBar };
}
