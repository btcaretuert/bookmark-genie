import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseCsv, readText, toCsv } from '../../tools/lib/csv.mjs';
import { parseNetscapeBookmarks } from '../../tools/lib/netscape.mjs';

const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" LAST_MODIFIED="2" PERSONAL_TOOLBAR_FOLDER="true">Barra de marcadores</H3>
    <DL><p>
        <DT><A HREF="https://example.com/a?x=1&amp;y=2" ADD_DATE="3" ICON="data:image/png;base64,AAAA">Pan &amp; masa</A>
        <DT><H3 ADD_DATE="4">Cocina</H3>
        <DL><p>
            <DT><A HREF="https://example.com/b" ADD_DATE="5">Ni&#241;os &#x1F355;</A>
            <DT><H3 ADD_DATE="6">Vacía</H3>
            <DL><p>
            </DL><p>
        </DL><p>
        <DT><A HREF="https://example.com/c" ADD_DATE="7">Después de la carpeta</A>
    </DL><p>
    <DT><A HREF="https://example.com/d" ADD_DATE="8"></A>
</DL><p>
`;

test('parses titles, URLs and folder paths from a Chrome export', () => {
  assert.deepEqual(parseNetscapeBookmarks(CHROME_EXPORT), [
    { id: 'b0', title: 'Pan & masa', url: 'https://example.com/a?x=1&y=2', folderPath: '' },
    { id: 'b1', title: 'Niños 🍕', url: 'https://example.com/b', folderPath: 'Cocina' },
    { id: 'b2', title: 'Después de la carpeta', url: 'https://example.com/c', folderPath: '' },
    { id: 'b3', title: '', url: 'https://example.com/d', folderPath: '' },
  ]);
});

test('an empty document has no bookmarks', () => {
  assert.deepEqual(parseNetscapeBookmarks('<html></html>'), []);
});

test('csv round trip handles quotes and commas, and flattens line breaks', () => {
  const rows = [['y', 'Título, con "comillas"', 'línea\nnueva'], ['', 'simple', '']];
  const parsed = parseCsv(toCsv(['judgment', 'title', 'note'], rows));
  assert.deepEqual(parsed, [
    { judgment: 'y', title: 'Título, con "comillas"', note: 'línea nueva' },
    { judgment: '', title: 'simple', note: '' },
  ]);
});

test('csv neutralizes cells a spreadsheet would run as formulas', () => {
  const parsed = parseCsv(toCsv(['title'], [['=HYPERLINK("http://evil")'], ['+1'], ['-1'], ['@cmd'], ['normal']]));
  assert.deepEqual(parsed.map((row) => row.title), [`'=HYPERLINK("http://evil")`, "'+1", "'-1", "'@cmd", 'normal']);
});

test('csv parser tolerates Windows line endings from a spreadsheet', () => {
  assert.deepEqual(parseCsv('judgment,title\r\ny,uno\r\nn,dos\r\n'), [
    { judgment: 'y', title: 'uno' },
    { judgment: 'n', title: 'dos' },
  ]);
});

const fixture = (/** @type {string} */ name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

test('Chrome layout: Other and Mobile have no folder of their own, their children sit beside the bar', () => {
  const parsed = parseNetscapeBookmarks(fixture('chrome-real-export.html'));
  assert.deepEqual(
    parsed.map(({ title, folderPath }) => [title, folderPath]),
    [
      ['In the bar', ''],
      ['Work wiki', 'Work'],
      ['Loose in Other', ''],
      ['Work in Other', 'Work'],
      ['Read later', 'Phone reads'],
      ['Loose in Mobile', ''],
    ],
  );
});

test('entities: names from the table only, never inherited ones', () => {
  const [, , third] = parseNetscapeBookmarks(fixture('unicode-edge.html'));
  assert.equal(third.title, "&amp; &constructor; &__proto__; &#x110000; 'quoted'");
});

test('entities that decode to lone surrogates become the replacement character', () => {
  const parsed = parseNetscapeBookmarks(fixture('unicode-edge.html'));
  assert.equal(parsed[1].title, 'lone \ufffd and \ufffd surrogates');
  for (const { title, url, folderPath } of parsed) {
    assert.ok(title.isWellFormed() && url.isWellFormed() && folderPath.isWellFormed());
  }
});

test('a zero-width joiner sequence survives intact', () => {
  assert.equal(parseNetscapeBookmarks(fixture('unicode-edge.html'))[3].title, '日本語のタイトル 👨\u200d💻');
});

test('malformed input is read without throwing, losing only the broken entry', () => {
  const parsed = parseNetscapeBookmarks(fixture('malformed-unclosed.html'));
  assert.ok(parsed.some((entry) => entry.title === 'fine'));
});

test('csv parser reads a comma file with a trailing blank line', () => {
  const rows = parseCsv(fixture('review-trailing-blank.csv'));
  assert.deepEqual(rows.map((row) => row.judgment), ['y', 'n']);
});

test('csv parser reads a semicolon file with BOM when the header says so', () => {
  const rows = parseCsv(fixture('review-semicolon-bom.csv'));
  assert.deepEqual(rows.map((row) => [row.judgment, row.title, row.confidence]), [
    ['y', 'One; with semicolon', 'high'],
    ['n', 'Two', 'low'],
  ]);
});

test('a semicolon inside a comma file is not taken as a separator', () => {
  assert.deepEqual(parseCsv('judgment,title\ny,a;b\n'), [{ judgment: 'y', title: 'a;b' }]);
  assert.deepEqual(parseCsv('judgment,title\ny,"a,b"\n'), [{ judgment: 'y', title: 'a,b' }]);
});

test('csv parser skips blank rows but keeps a row that only has an empty judgment', () => {
  assert.deepEqual(parseCsv('judgment,title\n\n,a\n,\n'), [{ judgment: '', title: 'a' }]);
});

test('csv parser keeps a carriage return inside a quoted cell', () => {
  assert.deepEqual(parseCsv('judgment,title\r\ny,"a\r"\r\n'), [{ judgment: 'y', title: 'a\r' }]);
});

test('csv cells are one line, without control or format characters', () => {
  const csv = toCsv(['t'], [['a\nb\r\nc\u2028d\u0000e'], ['x\u202Ey\u200Bz']]);
  assert.equal(csv, '"t"\n"a b  c d e"\n"xyz"\n'.replace('a b  c d e', 'a b c d e'));
});

test('csv neutralizes formulas, full-width forms and a leading space', () => {
  const titles = ['=1+1', '＝1', '＋1', '－1', '＠x', ' =1', '\t=1', '-5 tips'];
  const parsed = parseCsv(toCsv(['t'], titles.map((title) => [title])));
  for (const row of parsed) assert.ok(row.t.startsWith("'"), row.t);
  assert.equal(parseCsv(toCsv(['t'], [['plain']]))[0].t, 'plain');
});

test('unclosed tags cost linear time, not a scan to the end of the file per tag', () => {
  const unclosed = `<DL><p>${Array.from({ length: 40000 }, (_, i) => `<DT><A HREF="https://e.com/${i}">t`).join('\n')}</DL>`;
  const started = performance.now();
  assert.deepEqual(parseNetscapeBookmarks(unclosed), []);
  assert.ok(performance.now() - started < 1000, `took ${performance.now() - started} ms`);
  const closedAfter = `${unclosed}<DT><A HREF="https://ok.example.com/">fine</A>`;
  assert.deepEqual(parseNetscapeBookmarks(closedAfter).map((entry) => entry.title), ['fine']);
});

test('readText decodes UTF-8, and falls back to Windows-1252 for a spreadsheet save', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-readtext-'));
  try {
    await writeFile(join(dir, 'utf8.csv'), 'judgment\nsí\n');
    await writeFile(join(dir, 'cp1252.csv'), Buffer.from([0x6a, 0x75, 0x64, 0x67, 0x6d, 0x65, 0x6e, 0x74, 0x0a, 0x73, 0xed, 0x0a]));
    assert.equal(await readText(join(dir, 'utf8.csv')), 'judgment\nsí\n');
    assert.equal(await readText(join(dir, 'cp1252.csv')), 'judgment\nsí\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
