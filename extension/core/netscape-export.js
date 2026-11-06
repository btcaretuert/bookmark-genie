/**
 * Tree to the Netscape bookmark HTML that Chrome writes and imports, with one `<H3>` per root.
 *
 * Chrome's own export (chrome/browser/bookmarks/bookmark_html_writer.cc) flattens Other and
 * Mobile into the top level and merges local and account roots, so it cannot tell them apart
 * again. This one keeps each root as a folder, and none is marked PERSONAL_TOOLBAR_FOLDER: an
 * import then lands as plain folders instead of mixing into the person's bookmarks bar.
 * Managed bookmarks are left out, as Chrome does: imported, they would become ordinary copies.
 *
 * Escaping is what both ends agree on. Chrome writes content with base::EscapeForHTML
 * (`< > & " '` as `&lt; &gt; &amp; &quot; &#39;`) and its importer
 * (components/user_data_importer/content/content_bookmark_parser_utils.cc) decodes exactly those
 * five with base::UnescapeForHTML, in titles and in HREF. Here every title and URL gets all five,
 * so no text can close a tag or an attribute. The importer reads one line at a time, so a line
 * break in a title becomes a space: kept, it would cut the entry in two.
 *
 * @typedef {import('./tree.js').TreeNode} TreeNode
 */

import { isFolder, isManaged, rootsOf } from './tree.js';

const HEADER = [
  '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
  '<!-- This is an automatically generated file.',
  '     It will be read and overwritten.',
  '     DO NOT EDIT! -->',
  '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
  '<TITLE>Bookmarks</TITLE>',
  '<H1>Bookmarks</H1>',
  '<DL><p>',
];
const NEWLINE = '\r\n';
const INDENT = '    ';

/** @type {Record<string, string>} */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * @param {string} text
 */
export function escapeHtml(text) {
  return text.replace(/\r\n|[\r\n]/g, ' ').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/**
 * Seconds since the epoch, as Chrome writes ADD_DATE and LAST_MODIFIED; `dateAdded` is in ms.
 *
 * @param {string} name
 * @param {number | undefined} ms
 */
function timeAttribute(name, ms) {
  return ms === undefined ? '' : ` ${name}="${Math.floor(ms / 1000)}"`;
}

/**
 * One distinct folder name per exported root. A root keeps its title unless another root has the
 * same one, as local and account roots of the same type can; then storage is named, and a number
 * settles anything still equal.
 *
 * @param {TreeNode[]} roots
 * @returns {Map<string, string>} root id to label
 */
export function rootLabels(roots) {
  /** @type {Map<string, number>} */
  const titleCount = new Map();
  for (const root of roots) titleCount.set(root.title, (titleCount.get(root.title) ?? 0) + 1);

  /** @type {Map<string, string>} */
  const labels = new Map();
  /** @type {Set<string>} */
  const used = new Set();
  for (const root of roots) {
    const base = /** @type {number} */ (titleCount.get(root.title)) > 1 ? `${root.title} (${root.syncing ? 'cuenta' : 'local'})` : root.title;
    let label = base;
    for (let n = 2; used.has(label); n += 1) label = `${base} ${n}`;
    used.add(label);
    labels.set(root.id, label);
  }
  return labels;
}

/**
 * @param {TreeNode} node
 * @param {string} indent
 * @param {string[]} lines
 * @param {string} [title] overrides the node's title, for roots
 */
function writeNode(node, indent, lines, title = node.title) {
  if (!isFolder(node)) {
    lines.push(`${indent}<DT><A HREF="${escapeHtml(node.url ?? '')}"${timeAttribute('ADD_DATE', node.dateAdded)}>${escapeHtml(title)}</A>`);
    return;
  }
  lines.push(
    `${indent}<DT><H3${timeAttribute('ADD_DATE', node.dateAdded)}${timeAttribute('LAST_MODIFIED', node.dateGroupModified)}>${escapeHtml(title)}</H3>`,
    `${indent}<DL><p>`,
  );
  for (const child of node.children ?? []) writeNode(child, indent + INDENT, lines);
  lines.push(`${indent}</DL><p>`);
}

/**
 * @param {TreeNode[]} tree what `getTree()` resolves to
 * @returns {string}
 */
export function toNetscapeHtml(tree) {
  const roots = rootsOf(tree).filter((root) => !isManaged(root));
  const labels = rootLabels(roots);
  const lines = [...HEADER];
  for (const root of roots) writeNode(root, INDENT, lines, labels.get(root.id));
  lines.push('</DL><p>', '');
  return lines.join(NEWLINE);
}
