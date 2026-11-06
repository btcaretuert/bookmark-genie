import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeHtml, rootLabels, toNetscapeHtml } from '../../extension/core/netscape-export.js';
import { parseNetscapeBookmarks } from '../../tools/lib/netscape.mjs';
import { createFakeChrome } from '../helpers/fake-chrome.mjs';

const HOSTILE = `</a><script>alert(1)</script>"><img src=x onerror=alert(2)> & 'quotes' &amp;`;

/**
 * Local and account roots with the same titles, nested folders, and text that HTML would
 * misread. Folder names avoid `/` here only because tools/lib/netscape.mjs joins segments with it.
 */
async function sampleTree() {
  const { bookmarks } = createFakeChrome({ account: true, managed: [{ title: 'Intranet', url: 'https://intra.test/' }] });
  const add = (/** @type {Record<string, unknown>} */ details) => bookmarks.create(details);
  const dev = await add({ parentId: '1', title: 'Dev & <Ops>' });
  await add({ parentId: dev.id, title: HOSTILE, url: 'https://example.test/?a=1&b="2"&c=<3>' });
  const ci = await add({ parentId: dev.id, title: 'CI "pipelines"' });
  await add({ parentId: ci.id, title: 'Niños 🍕 — día', url: 'https://example.test/ñ' });
  await add({ parentId: ci.id, title: '', url: 'https://example.test/untitled' });
  await add({ parentId: dev.id, title: 'after the folder', url: 'https://example.test/after' });
  await add({ parentId: '1', title: 'loose', url: 'https://loose.test/' });
  await add({ parentId: '2', title: "it's other", url: 'https://other.test/' });
  await add({ parentId: '3', title: 'phone', url: 'https://phone.test/' });
  const work = await add({ parentId: '4', title: 'Work' });
  await add({ parentId: work.id, title: 'account bookmark', url: 'https://work.test/' });
  await add({ parentId: '5', title: 'account other', url: 'https://work.test/other' });
  return bookmarks.getTree();
}

/**
 * Every bookmark under the exported roots as `{segments, title, url}`, roots first; the managed
 * root is not exported.
 *
 * @param {any[]} tree
 */
function expectedEntries(tree) {
  const roots = tree[0].children.filter((/** @type {any} */ root) => root.folderType !== 'managed');
  const labels = rootLabels(roots);
  /** @type {{segments: string[], title: string, url: string}[]} */
  const out = [];
  /** @param {any} node @param {string[]} path */
  const visit = (node, path) => {
    if (node.url !== undefined) out.push({ segments: path, title: node.title, url: node.url });
    else for (const child of node.children) visit(child, [...path, node.title]);
  };
  for (const root of roots) for (const child of root.children) visit(child, [/** @type {string} */ (labels.get(root.id))]);
  return out;
}

/**
 * Reads the file the way Chrome's importer does
 * (components/user_data_importer/content/content_bookmark_parser_utils.cc): one line at a time,
 * a folder name or title after the last `>` before its closing tag, HREF from the attributes, and
 * only the five entities of base::UnescapeForHTML.
 *
 * @param {string} html
 */
function readLikeChrome(html) {
  const unescape = (/** @type {string} */ text) =>
    text.replace(/&(lt|gt|amp|quot|#39);/g, (_, name) => ({ lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" })[/** @type {'lt'} */ (name)]);
  /** @type {string[]} */
  const path = [];
  /** @type {string | null} */
  let pending = null;
  /** @type {{segments: string[], title: string, url: string}[]} */
  const out = [];
  for (const raw of html.split('\n')) {
    const line = raw.trim().replace(/^<DT>/i, '');
    if (line.startsWith('<H3')) {
      const end = line.indexOf('</H3>');
      pending = unescape(line.slice(line.lastIndexOf('>', end) + 1, end));
    } else if (line.startsWith('<A')) {
      const end = line.indexOf('</A>');
      const href = /HREF="([^"]*)"/.exec(line);
      assert.ok(end !== -1 && href, `a bookmark line Chrome can read: ${line}`);
      out.push({ segments: [...path], title: unescape(line.slice(line.lastIndexOf('>', end) + 1, end)), url: unescape(href[1]) });
    } else if (line.startsWith('<DL>')) {
      if (pending !== null) path.push(pending);
      pending = null;
    } else if (line.startsWith('</DL>')) {
      path.pop();
    }
  }
  return out;
}

test('round trip through tools/lib/netscape.mjs keeps [folder segments, title, url] per root', async () => {
  const tree = await sampleTree();
  const expected = expectedEntries(tree);
  for (const entry of expected) for (const segment of entry.segments) assert.ok(!segment.includes('/'), 'segments split back exactly');

  const parsed = parseNetscapeBookmarks(toNetscapeHtml(tree));
  const labels = [...rootLabels(tree[0].children.filter((/** @type {any} */ root) => root.folderType !== 'managed')).values()];
  for (const label of labels) {
    const inRoot = (/** @type {string[]} */ segments) => segments[0] === label;
    assert.deepEqual(
      parsed.map((bookmark) => ({ segments: bookmark.folderPath.split('/'), title: bookmark.title, url: bookmark.url })).filter((entry) => inRoot(entry.segments)),
      expected.filter((entry) => inRoot(entry.segments)),
      `root ${label}`,
    );
  }
  assert.equal(parsed.length, expected.length, 'nothing outside the roots');
});

test('read the way Chrome imports it, segments, titles and URLs come back exactly, a "/" in a name included', async () => {
  const { bookmarks } = createFakeChrome();
  const dev = await bookmarks.create({ parentId: '1', title: 'Dev' });
  const slash = await bookmarks.create({ parentId: dev.id, title: 'CI/CD' });
  const ci = await bookmarks.create({ parentId: dev.id, title: 'CI' });
  const cd = await bookmarks.create({ parentId: ci.id, title: 'CD' });
  await bookmarks.create({ parentId: slash.id, title: HOSTILE, url: 'https://a.test/?x=1&y=2' });
  await bookmarks.create({ parentId: cd.id, title: 'nested', url: 'https://b.test/' });
  const tree = await bookmarks.getTree();
  assert.deepEqual(readLikeChrome(toNetscapeHtml(tree)), expectedEntries(tree));
  assert.notDeepEqual(expectedEntries(tree)[0].segments, expectedEntries(tree)[1].segments);
});

test('a hostile title cannot open or close a tag', async () => {
  const tree = await sampleTree();
  const html = toNetscapeHtml(tree);
  assert.doesNotMatch(html, /<script|<img|onerror=alert\(2\)>/i);
  assert.ok(html.includes('&lt;/a&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img src=x onerror=alert(2)&gt; &amp; &#39;quotes&#39; &amp;amp;'));
  // Each line is one entry: the tags present are exactly the ones the writer puts there.
  const tags = html.match(/<\/?[A-Za-z][^>]*>/g) ?? [];
  const names = new Set(tags.map((tag) => /** @type {string} */ (/^<\/?([A-Za-z0-9]+)/.exec(tag))[1].toUpperCase()));
  assert.deepEqual([...names].sort(), ['A', 'DL', 'DT', 'H1', 'H3', 'META', 'P', 'TITLE']);
  assert.equal(tags.filter((tag) => /^<A\b/i.test(tag)).length, expectedEntries(tree).length);
  assert.equal(tags.filter((tag) => tag === '</A>').length, expectedEntries(tree).length);
  const parsed = parseNetscapeBookmarks(html);
  assert.equal(parsed.find((bookmark) => bookmark.title === HOSTILE)?.url, 'https://example.test/?a=1&b="2"&c=<3>');
});

test('a line break in a title becomes a space, so the line-based importer keeps one entry', async () => {
  const { bookmarks } = createFakeChrome();
  await bookmarks.create({ parentId: '1', title: 'one\ntwo\r\nthree\rfour', url: 'https://a.test/' });
  const html = toNetscapeHtml(await bookmarks.getTree());
  assert.deepEqual(readLikeChrome(html).map((entry) => entry.title), ['one two three four']);
});

test('the file has Chrome’s header, one H3 per root without PERSONAL_TOOLBAR_FOLDER, and no managed root', async () => {
  const tree = await sampleTree();
  const html = toNetscapeHtml(tree);
  assert.ok(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>\r\n'));
  assert.ok(html.includes('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\r\n'));
  assert.doesNotMatch(html, /PERSONAL_TOOLBAR_FOLDER/);
  assert.doesNotMatch(html, /Managed bookmarks|Intranet/);
  const rootLines = html.split('\r\n').filter((line) => /^ {4}<DT><H3/.test(line));
  assert.deepEqual(
    rootLines.map((line) => line.replace(/<[^>]*>/g, '').trim()),
    ['Bookmarks bar (local)', 'Other bookmarks (local)', 'Mobile bookmarks (local)', 'Bookmarks bar (cuenta)', 'Other bookmarks (cuenta)', 'Mobile bookmarks (cuenta)'],
  );
  assert.match(html, /<DT><A HREF="https:\/\/loose\.test\/" ADD_DATE="\d{10}">loose<\/A>/);
});

test('root labels stay distinct and keep the title when it is unique', () => {
  const root = (/** @type {string} */ id, /** @type {string} */ title, syncing = false) => ({ id, title, syncing });
  assert.deepEqual(
    [...rootLabels([root('1', 'Bar'), root('2', 'Other'), root('4', 'Bar', true), root('7', 'Bar', true)]).values()],
    ['Bar (local)', 'Other', 'Bar (cuenta)', 'Bar (cuenta) 2'],
  );
});

test('escapeHtml uses the five entities Chrome decodes, and nothing else', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(escapeHtml('ñ € 🍕 / \\ \t'), 'ñ € 🍕 / \\ \t');
});
