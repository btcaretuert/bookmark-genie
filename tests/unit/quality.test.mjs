import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { summarizeQuality } from '../../extension/core/quality.js';
import { sanitizeForLlm } from '../../extension/core/url.js';
import { parseNetscapeBookmarks } from '../../tools/lib/netscape.mjs';

test('counts the problems that starve the model of context', () => {
  const html = readFileSync(new URL('../fixtures/quality-issues.html', import.meta.url), 'utf8');
  const bookmarks = parseNetscapeBookmarks(html);
  const sendable = bookmarks.flatMap(({ title, url }) => {
    const sanitized = sanitizeForLlm(url);
    return sanitized.sendable ? [{ title, url: sanitized.url }] : [];
  });
  assert.deepEqual(summarizeQuality({ bookmarks, sendable }), {
    total: 7,
    sendable: 7,
    emptyTitles: 1,
    titleIsUrl: 1,
    hostOnlyUrls: 1,
    exactDuplicates: 1,
    duplicatesAfterReduction: 1,
  });
});

test('the summary holds numbers only', () => {
  const summary = summarizeQuality({
    bookmarks: [{ title: 'secret title', url: 'https://a.example.com/?token=abc' }],
    sendable: [{ title: 'secret title', url: 'a.example.com' }],
  });
  assert.ok(Object.values(summary).every((value) => typeof value === 'number'));
});

test('an empty collection is all zeros', () => {
  assert.deepEqual(Object.values(summarizeQuality({ bookmarks: [], sendable: [] })), [0, 0, 0, 0, 0, 0, 0]);
});

test('a long run of slashes does not make the comparison quadratic', () => {
  const hostile = `${'/'.repeat(200000)}x`;
  const started = performance.now();
  const summary = summarizeQuality({ bookmarks: [{ title: hostile, url: hostile }], sendable: [{ title: hostile, url: hostile }] });
  assert.ok(performance.now() - started < 500);
  assert.equal(summary.titleIsUrl, 1);
});
