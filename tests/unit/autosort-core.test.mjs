import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SETTINGS,
  MAX_EXAMPLES,
  MAX_LOOSE,
  buildAutoSortRequest,
  candidateFolders,
  consentCovers,
  dayKey,
  describeForLog,
  folderKey,
  looseSiblings,
  normalizeSettings,
  readAutoSortAnswer,
} from '../../extension/core/autosort.js';
import { estimateTokens } from '../../extension/core/batching.js';
import { createFakeChrome } from '../helpers/fake-chrome.mjs';

async function tree() {
  const { bookmarks } = createFakeChrome({ account: true, managed: [{ title: 'Intranet', url: 'https://intra.test/' }] });
  const add = (/** @type {string} */ parentId, /** @type {string} */ title) => bookmarks.create({ parentId, title });
  const dev = await add('4', 'Dev');
  const ci = await add(dev.id, 'CI');
  await add(ci.id, 'Deep'); // third level: offered by path since 0.5.1
  await add('4', 'Cocina');
  await add('5', 'Dev'); // same path in another account root
  await add('4', 'cuenta a@b.example'); // an email in a name: not sent
  await add('1', 'Local only');
  await bookmarks.create({ parentId: '4', title: 'a bookmark', url: 'https://a.test/' });
  return { tree: await bookmarks.getTree(), ids: { dev: dev.id, ci: ci.id } };
}

test('candidates are the folders of the same storage, at any depth by path, with unique names', async () => {
  const { tree: t, ids } = await tree();
  const { folders: account, truncated } = candidateFolders(t, true);
  assert.deepEqual(account.map((folder) => folder.title), ['Dev', 'CI', 'Deep', 'Cocina', 'Dev']);
  assert.deepEqual(
    account.map((folder) => folder.name),
    ['Dev', 'Dev/CI', 'Dev/CI/Deep', 'Cocina', 'Other bookmarks/Dev'],
  );
  assert.equal(truncated, 1, 'the folder whose name holds an email is left out, and counted');
  assert.equal(account[0].id, ids.dev);
  assert.equal(account[1].id, ids.ci);
  assert.deepEqual(candidateFolders(t, false).folders.map((folder) => folder.name), ['Local only']);
});

test('past 100 candidates, the most recently used and largest stay, in tree order, and the cut is counted', async () => {
  const { bookmarks } = createFakeChrome();
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < 110; i += 1) ids.push((await bookmarks.create({ parentId: '1', title: `Folder ${i}` })).id);
  // The ten oldest and emptiest are the first ten; one of them gets a fresh bookmark and stays.
  for (let i = 10; i < 110; i += 1) await bookmarks.create({ parentId: ids[i], title: `b${i}`, url: `https://b${i}.example.com/` });
  await bookmarks.create({ parentId: ids[3], title: 'fresh', url: 'https://fresh.example.com/' });
  await bookmarks.create({ parentId: '2', title: 'x'.repeat(101) });
  const { folders, truncated } = candidateFolders(await bookmarks.getTree(), false);
  assert.equal(folders.length, 100);
  assert.equal(truncated, 11, '10 past the cap and 1 path too long');
  assert.ok(folders.some((folder) => folder.id === ids[3]));
  assert.ok(!folders.some((folder) => [0, 1, 2, 4].map((i) => ids[i]).includes(folder.id)));
  assert.deepEqual(folders.map((folder) => folder.id), [...folders].sort((a, b) => Number(a.id) - Number(b.id)).map((folder) => folder.id), 'tree order');
  assert.ok(!folders.some((folder) => folder.name.length > 100));
});

test('each candidate carries up to 5 example titles, its own bookmarks first, none with a private host', async () => {
  const { bookmarks } = createFakeChrome();
  const cooking = await bookmarks.create({ parentId: '1', title: 'Libros de Cocina' });
  const bread = await bookmarks.create({ parentId: cooking.id, title: 'Panes' });
  await bookmarks.create({ parentId: bread.id, title: 'Masa madre paso a paso', url: 'https://bread.example.com/sourdough' });
  await bookmarks.create({ parentId: cooking.id, title: 'Receta en el NAS', url: 'http://192.168.1.5/recetas' });
  for (let i = 0; i < 6; i += 1) await bookmarks.create({ parentId: cooking.id, title: `Receta ${i}`, url: `https://recipes.example.com/${i}` });
  // The newest sits in the middle of the folder: neither tree order nor its reverse puts it first.
  await bookmarks.create({ parentId: cooking.id, index: 4, title: 'Nueva', url: 'https://recipes.example.com/new' });
  const [folder, panes] = candidateFolders(await bookmarks.getTree(), false).folders;
  assert.equal(folder.examples.length, MAX_EXAMPLES);
  assert.deepEqual(folder.examples, ['Nueva', 'Receta 5', 'Receta 4', 'Receta 3', 'Receta 2'], 'the most recent, never the private one');
  assert.deepEqual(panes.examples, ['Masa madre paso a paso']);
  assert.deepEqual(candidateFolders(await bookmarks.getTree(), false, { examples: false }).folders[0].examples, [], 'context: only the bookmark');
});

test('loose siblings: the 30 most recent sendable bookmarks of the same parent, in folder order', async () => {
  const { bookmarks } = createFakeChrome();
  await bookmarks.create({ parentId: '1', title: 'A folder' });
  await bookmarks.create({ parentId: '1', title: 'Router', url: 'http://192.168.1.1/' });
  for (let i = 0; i < 35; i += 1) await bookmarks.create({ parentId: '1', title: `Loose ${i}`, url: `https://loose${i}.example.com/page?token=abc` });
  const created = await bookmarks.create({ parentId: '1', title: 'New', url: 'https://new.example.com/' });
  const loose = looseSiblings(await bookmarks.getTree(), '1', created.id);
  assert.equal(loose.length, MAX_LOOSE);
  assert.equal(loose[0].title, 'Loose 5', 'the oldest five fall out');
  assert.equal(loose.at(-1)?.title, 'Loose 34');
  assert.ok(loose.every((item) => !item.url.includes('token') && item.title !== 'Router' && item.title !== 'New'));
});

/** The owner's shape: 9 folders with a few bookmarks each, about 15 loose ones in the bar. */
async function ownerLikeTree() {
  const { bookmarks } = createFakeChrome({ account: true });
  const names = ['Sitios locales', 'Proyectos', 'Servidor casero', 'DBT', 'Libros de Cocina', 'Servicios', 'Finanzas', 'Viajes', 'Lecturas'];
  for (const [n, name] of names.entries()) {
    const folder = await bookmarks.create({ parentId: '4', title: name });
    for (let i = 0; i < 4; i += 1) await bookmarks.create({ parentId: folder.id, title: `${name}: artículo de ejemplo número ${i}`, url: `https://site${n}.example.com/articulo/${i}` });
  }
  const loose = ['Claude', 'NotebookLM', 'ChatGPT', 'Gemini Advanced', 'DeepSeek', 'DeepSeek Platform', 'API keys - OpenAI API', 'API Plan Billing | Google AI Studio', 'Dashboard | Claude Platform', 'Canva - Imagenes', 'Gmail', 'YouTube', 'Banco', 'Mapa del metro', 'Clima'];
  for (const [i, title] of loose.entries()) await bookmarks.create({ parentId: '4', title, url: `https://loose${i}.example.com/app` });
  const created = await bookmarks.create({ parentId: '4', title: 'Clasificación IA 2026: mejores LLM clasificados a diario', url: 'https://sevenlab.ai/es/llm-ranking' });
  return { tree: await bookmarks.getTree(), created };
}

test('the request for the owner’s collection stays small: measured input tokens', async () => {
  const { tree: t, created } = await ownerLikeTree();
  const { folders } = candidateFolders(t, true);
  const loose = looseSiblings(t, '4', created.id);
  assert.equal(folders.length, 9);
  assert.equal(loose.length, 15);
  const request = buildAutoSortRequest({ bookmark: { title: created.title, url: 'sevenlab.ai/es/llm-ranking' }, folders, loose });
  const input = estimateTokens(request.system + request.user + JSON.stringify(request.schema));
  // bytes/3, the conservative estimate the budget uses; the provider's count is lower.
  assert.ok(input < 2000, `estimated ${input} input tokens`);
  assert.ok(request.user.includes('"examples":["Sitios locales: artículo de ejemplo número 3"'), 'most recent first');
  assert.ok(request.user.includes('{"j":0,"title":"Claude","url":"loose0.example.com/app"}'));
  assert.match(request.system, /Do not force an existing folder when the topic is different/);
  assert.match(request.system, /Propose a new folder only when the topic is clear, preferably one that also gathers some of the loose bookmarks/);
  assert.equal(request.maxTokens, 2048 + 150 + 15 * 4);
});

const result = (/** @type {unknown} */ data, stopReason = 'end_turn') => ({ data, stopReason });
const FOLDERS = [
  { id: '10', name: 'DBT', title: 'DBT', parentId: '4', examples: [] },
  { id: '11', name: 'Libros de Cocina', title: 'Libros de Cocina', parentId: '4', examples: [] },
  { id: '12', name: 'Dev/Programación', title: 'Programación', parentId: '20', examples: [] },
];
const LOOSE = [
  { id: '30', title: 'Claude', url: 'claude.ai' },
  { id: '31', title: 'ChatGPT', url: 'chatgpt.com' },
];
const CONTEXT = { folders: FOLDERS, loose: LOOSE, parentId: '4' };
const answer = (/** @type {Record<string, unknown>} */ fields) => result({ kind: 'none', folder: -1, confidence: 'low', name: '', description: '', together: [], ...fields });

test('an existing folder comes back with its confidence', () => {
  assert.deepEqual(readAutoSortAnswer(answer({ kind: 'existing', folder: 0, confidence: 'high' }), CONTEXT), { kind: 'existing', folder: FOLDERS[0], confidence: 'high' });
  assert.deepEqual(readAutoSortAnswer(answer({ kind: 'existing', folder: 1, confidence: 'LOW' }), CONTEXT), { kind: 'existing', folder: FOLDERS[1], confidence: 'low' });
});

test('a new folder comes back cleaned, with the valid loose bookmarks once each', () => {
  assert.deepEqual(
    readAutoSortAnswer(answer({ kind: 'new', name: '  Inteligencia\nartificial y modelos de lenguaje grandes  ', description: 'Herramientas de IA.', together: [1, 0, 1, 7, -1, 0.5] }), CONTEXT),
    { kind: 'new', name: 'Inteligencia artificial y modelos de len', description: 'Herramientas de IA.', together: [LOOSE[1], LOOSE[0]] },
  );
});

test('a new name equal to an existing folder, ignoring case and accents, is that folder, to confirm', () => {
  assert.deepEqual(readAutoSortAnswer(answer({ kind: 'new', name: 'dbt' }), CONTEXT), { kind: 'existing', folder: FOLDERS[0], confidence: 'low' });
  assert.deepEqual(readAutoSortAnswer(answer({ kind: 'new', name: 'PROGRAMACION' }), CONTEXT), { kind: 'existing', folder: FOLDERS[2], confidence: 'low' });
  assert.deepEqual(readAutoSortAnswer(answer({ kind: 'new', name: 'libros de cocína' }), CONTEXT).kind, 'existing');
  assert.equal(folderKey(' Programación '), 'programacion');
});

test('none, refusals, truncation and malformed answers leave the bookmark', () => {
  assert.deepEqual(readAutoSortAnswer(answer({ kind: 'none' }), CONTEXT), { kind: 'left', reason: 'no-topic' });
  assert.deepEqual(readAutoSortAnswer(result(null, 'refusal'), CONTEXT), { kind: 'left', reason: 'refused' });
  assert.deepEqual(readAutoSortAnswer(result(null, 'max_tokens'), CONTEXT), { kind: 'left', reason: 'truncated' });
  for (const bad of [
    answer({ kind: 'existing', folder: 3, confidence: 'high' }),
    answer({ kind: 'existing', folder: 0, confidence: 'maybe' }),
    answer({ kind: 'new', name: '   ' }),
    answer({ kind: 'new', name: 'Escribe a jefe@empresa.example' }),
    answer({ kind: 'other' }),
    result(null),
    result({ assignments: [{ i: 0, f: 0, confidence: 'high' }] }),
  ]) {
    assert.deepEqual(readAutoSortAnswer(bad, CONTEXT), { kind: 'left', reason: 'invalid-answer' });
  }
});

test('the response schema is strict: every field required, nothing else allowed', () => {
  const { schema } = buildAutoSortRequest({ bookmark: { title: 'x', url: 'x.example.com' }, folders: [], loose: [] });
  const strict = /** @type {any} */ (schema);
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual([...strict.required].sort(), Object.keys(strict.properties).sort());
  assert.deepEqual(strict.properties.kind.enum, ['existing', 'new', 'none']);
});

test('settings default to off, and bad values fall back', () => {
  assert.deepEqual(normalizeSettings(undefined), { ...DEFAULT_SETTINGS });
  assert.equal(DEFAULT_SETTINGS.enabled, false);
  assert.deepEqual(normalizeSettings({ enabled: 'yes', maxCallsPerDay: 0, ref: '', consent: { provider: 'gemini' }, contextMode: 'all', excludedFolderIds: [3, '', '7', '7'] }), { ...DEFAULT_SETTINGS, excludedFolderIds: ['7'] });
  assert.equal(DEFAULT_SETTINGS.confirmBeforeMove, true, 'D1: confirm before moving, by default');
  // Settings saved by 0.3.0 keep their choices; their consent is version 1.
  const old = normalizeSettings({ enabled: true, ref: 'gemini/gemini-3.5-flash-lite', maxCallsPerDay: 20, consent: { provider: 'gemini', readOn: '2026-11-05', at: 'x' } });
  assert.deepEqual(old, { ...DEFAULT_SETTINGS, enabled: true, maxCallsPerDay: 20, consent: { provider: 'gemini', readOn: '2026-11-05', version: 1, at: 'x' } });
  assert.equal(normalizeSettings({ maxCallsPerDay: 7 }).maxCallsPerDay, 7);
});

test('consent covers only the provider and the policy reading it was given for', () => {
  const gemini = { id: 'gemini', dataPolicy: { readOn: '2026-11-05' } };
  assert.equal(consentCovers({ provider: 'gemini', readOn: '2026-11-05', version: 3, at: 'x' }, gemini), true);
  assert.equal(consentCovers({ provider: 'gemini', readOn: '2026-11-05', version: 2, at: 'x' }, gemini), false, 'v2 did not cover deeper folder paths');
  assert.equal(consentCovers({ provider: 'gemini', readOn: '2026-11-05', version: 1, at: 'x' }, gemini), false, 'v1 did not cover the context');
  assert.equal(consentCovers({ provider: 'gemini', readOn: '2026-10-01', version: 3, at: 'x' }, gemini), false);
  assert.equal(consentCovers({ provider: 'openai', readOn: '2026-11-05', version: 3, at: 'x' }, gemini), false);
  assert.equal(consentCovers(null, gemini), false);
});

test('the log keeps a short title and the host, not the URL', () => {
  assert.deepEqual(describeForLog({ title: `  Mi\nbanco ${'x'.repeat(100)}`, url: 'https://bank.test/account?token=abc' }), {
    title: `Mi banco ${'x'.repeat(71)}`,
    host: 'bank.test',
  });
  assert.equal(dayKey(new Date(2026, 10, 5, 23, 59)), '2026-11-05');
});
