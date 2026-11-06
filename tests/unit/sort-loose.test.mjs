import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONSENT_VERSION, DEFAULT_SETTINGS, dayKey } from '../../extension/core/autosort.js';
import { UNSORTED } from '../../extension/core/classify.js';
import { classificationFolders, estimatedCalls, groupAssignments, looseToSort } from '../../extension/core/sort-loose.js';
import { createFlow } from '../../extension/platform/flow.js';
import { getProvider } from '../../extension/platform/providers.js';
import { createSettingsStore } from '../../extension/platform/settings.js';
import { createStore } from '../../extension/platform/store.js';
import { sortPreviewView } from '../../extension/ui/present.js';
import { createFakeChrome, normalForm } from '../helpers/fake-chrome.mjs';
import { startFakeOpenAi } from '../helpers/fake-openai.mjs';

const KEY = 'test-key-not-real-1234567890';
const GEMINI_HOST = 'https://generativelanguage.googleapis.com/*';
const OWNER_FOLDERS = ['Sitios locales', 'Proyectos', 'Servidor casero', 'DBT', 'Libros de Cocina', 'Servicios'];
const AI_LOOSE = [
  ['Claude', 'https://claude.ai/new'],
  ['NotebookLM', 'https://notebooklm.google.com/'],
  ['ChatGPT', 'https://chatgpt.com/'],
  ['Gemini Advanced', 'https://gemini.google.com/app'],
  ['DeepSeek', 'https://chat.deepseek.com/'],
  ['DeepSeek Platform', 'https://platform.deepseek.com/usage'],
  ['API keys - OpenAI API', 'https://platform.openai.com/api-keys'],
  ['API Plan Billing | Google AI Studio', 'https://aistudio.google.com/plan_information'],
  ['Dashboard | Claude Platform', 'https://platform.claude.com/dashboard'],
  ['Canva - Imagenes', 'https://www.canva.com/ai-image-generator/'],
  ['Perplexity', 'https://www.perplexity.ai/'],
  ['Hugging Face', 'https://huggingface.co/models'],
];
const AI_TITLES = new Set(AI_LOOSE.map(([title]) => title));

/** @typedef {import('../../extension/core/types.js').CompletionRequest} CompletionRequest */

const result = (/** @type {unknown} */ data) => ({
  data,
  stopReason: 'end_turn',
  refusalCategory: null,
  servedModel: 'gemini-3.5-flash-lite',
  requestId: null,
  latencyMs: 5,
  usage: { attempts: [{ model: 'gemini-3.5-flash-lite', inputTokens: 500, outputTokens: 60, thinkingTokens: 0, kind: 'message' }], inputTokens: 500, outputTokens: 60, thinkingTokens: 0, usedFallback: false },
});

/**
 * Answers like the model would for the owner: the taxonomy reuses DBT and proposes «IA»; the
 * classification files AI titles in «IA», the rest nowhere.
 *
 * @param {{newName?: string}} [options]
 */
const ownerModel = ({ newName = 'IA' } = {}) => (/** @type {CompletionRequest} */ request) => {
  if (request.user.includes('<bookmark_sample>')) return result({ folders: [{ name: newName, description: 'Herramientas de inteligencia artificial.' }, { name: 'DBT', description: 'Modelado de datos.' }] });
  const folders = JSON.parse(/** @type {string[]} */ (/<folders>\n(.*)\n<\/folders>/s.exec(request.user))[1]);
  const bookmarks = JSON.parse(/** @type {string[]} */ (/<bookmarks>\n(.*)\n<\/bookmarks>/s.exec(request.user))[1]);
  const ai = folders.find((/** @type {any} */ folder) => folder.name === newName).f;
  return result({ assignments: bookmarks.map((/** @type {any} */ item) => ({ i: item.i, f: AI_TITLES.has(item.title) || /^Herramienta/.test(item.title) ? ai : -1, confidence: 'high' })) });
};

/**
 * The owner's account bar: six folders and loose bookmarks, mostly AI. The sort is set up with
 * Gemini, key, consent v2 and the host permission; `tabs` is not needed for this action.
 *
 * @param {{reply?: (request: CompletionRequest) => any, settings?: object, loose?: [string, string][], grant?: string[]}} [options]
 */
async function setUp({ reply = ownerModel(), settings = {}, loose = [...AI_LOOSE, ['Gmail', 'https://mail.google.com/'], ['Router', 'http://192.168.1.1/']], grant = [GEMINI_HOST] } = {}) {
  const fake = createFakeChrome({ account: true });
  const b = fake.bookmarks;
  /** @type {Record<string, string>} */
  const folders = {};
  for (const name of OWNER_FOLDERS) folders[name] = (await b.create({ parentId: '4', title: name })).id;
  await b.create({ parentId: folders.DBT, title: 'What is dbt?', url: 'https://docs.getdbt.com/docs/introduction' });
  /** @type {Record<string, string>} */
  const ids = {};
  for (const [title, url] of loose) ids[title] = (await b.create({ parentId: '4', title, url })).id;
  const store = createSettingsStore(fake.storage.local);
  await store.saveSettings({
    ...DEFAULT_SETTINGS,
    enabled: true,
    consent: { provider: 'gemini', readOn: getProvider('gemini').dataPolicy.readOn, version: CONSENT_VERSION, at: '2026-11-05T10:00:00.000Z' },
    ...settings,
  });
  await store.saveKey('gemini', KEY);
  for (const name of grant) fake.permissions.granted.add(name);
  /** @type {CompletionRequest[]} */
  const calls = [];
  let replyWith = reply;
  const flow = createFlow({
    storage: fake.storage.local,
    bookmarks: b,
    tabs: fake.tabs,
    permissions: fake.permissions,
    action: fake.action,
    schedule: () => {},
    createComplete: () => async (/** @type {CompletionRequest} */ request) => {
      calls.push(request);
      return replyWith(request);
    },
  });
  return { fake, b, folders, ids, store, flow, calls, setReply: (/** @type {any} */ next) => (replyWith = next) };
}

test('the owner’s bar: the preview says what leaves and what not, and nothing is sent yet', async () => {
  const { flow, calls } = await setUp();
  const preview = await flow.previewLoose('4');
  assert.equal(preview.sendable, 13);
  assert.deepEqual(preview.omitted.map((item) => [item.title, item.reason]), [['Router', 'private-host']]);
  assert.equal(preview.calls, 2);
  assert.equal(preview.blocked, null);
  assert.equal(calls.length, 0);
  const view = sortPreviewView(preview);
  assert.match(view.lines[0], /^Se enviarán a Google Gemini \(gemini-3\.5-flash-lite\) los títulos limpios y las URL reducidas de 13 marcadores sueltos de «Bookmarks bar», con los nombres de tus 6 carpetas\.$/);
  assert.equal(view.omitted[0], '«Router» · 192.168.1.1: es un host privado: no se envía');
  assert.equal(view.lines[2], 'No se envía 1 marcador:');
  assert.equal(view.confirmLabel, 'Enviar 13 y proponer');
});

test('sorting proposes «IA» with the 12, moves nothing, and accepting then undoing reverts it all', async () => {
  const { flow, b, calls, ids, fake } = await setUp();
  const before = normalForm(await b.getTree());
  const summary = /** @type {any} */ (await flow.sortLoose('4'));
  assert.deepEqual({ sent: summary.sent, groups: summary.groups, filed: summary.filed, unsorted: summary.unsorted, calls: summary.calls }, { sent: 13, groups: 1, filed: 12, unsorted: 1, calls: 2 });
  assert.deepEqual(normalForm(await b.getTree()), before, 'nothing moved, nothing created');
  assert.doesNotMatch(calls.map((call) => call.user).join('\n'), /Router|192\.168/);

  const [proposal] = await flow.proposals.list();
  assert.deepEqual({ kind: proposal.kind, origin: proposal.origin, name: proposal.newFolder?.name, members: proposal.members }, { kind: 'create', origin: 'sort-loose', name: 'IA', members: 12 });
  assert.equal((await flow.lastResult())?.messageEs, 'Ordenar sueltos de «Bookmarks bar»: 1 propuesta para 12 marcadores; 1 sin tema claro; 1 omitido. Revísalas arriba.');

  const applied = await flow.proposals.apply(proposal.id);
  assert.equal(applied.moved, 12);
  const folder = (await b.getChildren('4')).find((child) => child.title === 'IA' && child.url === undefined);
  assert.equal((await b.getChildren(/** @type {any} */ (folder).id)).length, 12);
  assert.equal((await b.get(ids.Gmail))[0].parentId, '4');
  const [row] = await flow.listActivity();
  assert.deepEqual({ kind: row.kind, changeId: row.changeId, folder: row.folder }, { kind: 'moved', changeId: applied.changeId, folder: 'IA' });
  assert.ok(row.actions.includes('undo'));

  const undo = await flow.undo(/** @type {string} */ (applied.changeId));
  assert.equal(undo.removedFolders.length, 1, 'the created folder goes when empty');
  assert.deepEqual(normalForm(await b.getTree()), before);
  assert.equal((await createStore(fake.storage.local).listChanges(5)).filter((change) => change.kind === 'proposal').length, 1, 'one change for the group');
});

test('even in automatic mode, «Ordenar sueltos» only proposes', async () => {
  const { flow, b } = await setUp({ settings: { confirmBeforeMove: false } });
  const before = normalForm(await b.getTree());
  await flow.sortLoose('4');
  assert.deepEqual(normalForm(await b.getTree()), before);
  assert.equal((await flow.proposals.list()).length, 1);
});

test('a bookmark in an excluded folder never leaves: sorting inside one sends nothing', async () => {
  const { flow, b, folders, store, calls } = await setUp();
  const inner = await b.create({ parentId: folders.Servicios, title: 'Privado' });
  await b.create({ parentId: inner.id, title: 'Banco', url: 'https://bank.example.com/' });
  await b.create({ parentId: folders.Servicios, title: 'Netflix', url: 'https://www.netflix.com/' });
  await store.saveSettings({ ...(await store.readSettings()), excludedFolderIds: [folders.Servicios] });
  const preview = await flow.previewLoose(folders.Servicios);
  assert.equal(preview.sendable, 0);
  assert.deepEqual(preview.omitted.map((item) => item.reason), ['excluded-folder']);
  assert.equal(preview.blocked?.reason, 'nothing-to-sort');
  await flow.sortLoose(folders.Servicios);
  assert.equal(calls.length, 0);
  // Sorting the bar: the excluded folder's name and contents are not in any request.
  await flow.sortLoose('4');
  assert.doesNotMatch(calls.map((call) => call.user).join('\n'), /Servicios|Netflix|Banco|Privado/);
});

test('more than 50 loose bookmarks go in batches of 50, after one folders call', async () => {
  const loose = /** @type {[string, string][]} */ (Array.from({ length: 120 }, (_, i) => [`Herramienta ${i}`, `https://tool${i}.example.com/`]));
  const { flow, calls } = await setUp({ loose });
  const preview = await flow.previewLoose('4');
  assert.deepEqual({ sendable: preview.sendable, batches: preview.batches, calls: preview.calls }, { sendable: 120, batches: 3, calls: 4 });
  const summary = /** @type {any} */ (await flow.sortLoose('4'));
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((call) => call.user.includes('<bookmarks>')).length, 3);
  const sizes = calls.filter((call) => call.user.includes('<bookmarks>')).map((call) => JSON.parse(/** @type {string[]} */ (/<bookmarks>\n(.*)\n<\/bookmarks>/s.exec(call.user))[1]).length);
  assert.deepEqual(sizes, [50, 50, 20]);
  assert.equal(summary.filed, 120);
});

test('the daily cap cuts it halfway: what was filed is proposed, the rest is reported', async () => {
  const loose = /** @type {[string, string][]} */ (Array.from({ length: 70 }, (_, i) => [`Herramienta ${i}`, `https://tool${i}.example.com/`]));
  const { flow, calls, store } = await setUp({ loose, settings: { maxCallsPerDay: 2 } });
  const preview = await flow.previewLoose('4');
  assert.match(sortPreviewView(preview).lines[1], /El tope diario puede cortarlo a medias\./);
  const summary = /** @type {any} */ (await flow.sortLoose('4'));
  assert.equal(calls.length, 2);
  assert.equal(summary.stopped?.reason, 'daily-calls');
  assert.equal(summary.filed, 50);
  assert.equal(summary.unclassified, 20);
  assert.equal((await store.readUsage(dayKey(new Date()))).calls, 2);
  assert.equal((await flow.proposals.list())[0].members, 50);
  assert.match(/** @type {string} */ ((await flow.lastResult())?.messageEs), /Se detuvo: Se alcanzó el tope diario/);
  const blocked = await flow.previewLoose('4');
  assert.equal(blocked.blocked?.reason, 'daily-calls');
});

test('a new name equal to a pending Ctrl+D proposal merges into it', async () => {
  const { flow, fake, b, ids } = await setUp({ reply: ownerModel({ newName: 'ia' }) });
  const saved = await b.create({ parentId: '4', title: 'Clasificación IA 2026', url: 'https://sevenlab.ai/es/llm-ranking' });
  const { createProposals } = await import('../../extension/platform/proposals.js');
  await createProposals({ storage: fake.storage.local, bookmarks: b, action: fake.action }).add({
    id: 'proposal:ctrl-d',
    createdAt: new Date().toISOString(),
    kind: 'create',
    confidence: 'high',
    bookmark: { id: saved.id, title: saved.title, host: 'sevenlab.ai', parentId: '4', index: /** @type {number} */ (saved.index) },
    newFolder: { parentId: '4', parentTitle: 'Bookmarks bar', name: 'IA', description: 'IA.' },
    together: [{ id: ids.Claude, title: 'Claude', host: 'claude.ai', parentId: '4', index: 0 }],
  });
  const preview = await flow.previewLoose('4');
  assert.ok(preview.omitted.some((item) => item.reason === 'pending' && item.title === 'Claude'), 'already in a proposal: not sent again');
  await flow.sortLoose('4');
  const list = await flow.proposals.list();
  assert.equal(list.length, 1, 'merged by name, ignoring case');
  assert.equal(list[0].id, 'proposal:ctrl-d');
  assert.equal(list[0].members, 13);
  const applied = await flow.proposals.apply(list[0].id);
  assert.equal(applied.moved, 13);
  assert.equal((await b.getChildren('4')).filter((child) => child.url === undefined && child.title.toLowerCase() === 'ia').length, 1);
});

test('consent v2 must be in force, and the key and host permission there', async () => {
  for (const [options, reason] of /** @type {[any, string][]} */ ([
    [{ settings: { consent: { provider: 'gemini', readOn: getProvider('gemini').dataPolicy.readOn, version: 1, at: 'x' } } }, 'no-consent'],
    [{ grant: [] }, 'no-permission'],
  ])) {
    const { flow, calls } = await setUp(options);
    assert.equal((await flow.previewLoose('4')).blocked?.reason, reason);
    const outcome = /** @type {any} */ (await flow.sortLoose('4'));
    assert.equal(outcome.blocked?.reason, reason);
    assert.equal(calls.length, 0);
  }
});

test('«Aceptar todas» applies every group as one change, and the metrics count it apart', async () => {
  const reply = (/** @type {CompletionRequest} */ request) => {
    if (request.user.includes('<bookmark_sample>')) return result({ folders: [{ name: 'IA', description: 'IA.' }, { name: 'Correo', description: 'Correo.' }] });
    const folders = JSON.parse(/** @type {string[]} */ (/<folders>\n(.*)\n<\/folders>/s.exec(request.user))[1]);
    const bookmarks = JSON.parse(/** @type {string[]} */ (/<bookmarks>\n(.*)\n<\/bookmarks>/s.exec(request.user))[1]);
    const f = (/** @type {string} */ name) => folders.find((/** @type {any} */ folder) => folder.name === name).f;
    return result({ assignments: bookmarks.map((/** @type {any} */ item) => ({ i: item.i, f: item.title === 'Gmail' ? f('Correo') : f('IA'), confidence: 'high' })) });
  };
  const { flow, store, fake } = await setUp({ reply, loose: [['Claude', 'https://claude.ai/'], ['ChatGPT', 'https://chatgpt.com/'], ['Gmail', 'https://mail.google.com/']] });
  await flow.sortLoose('4');
  assert.equal((await flow.proposals.list()).length, 2);
  const accepted = await flow.proposals.acceptAll('sort-loose');
  assert.deepEqual({ moved: accepted.moved, groups: accepted.groups, created: accepted.createdFolders?.length }, { moved: 3, groups: 2, created: 2 });
  assert.equal((await createStore(fake.storage.local).listChanges(5)).length, 1, 'one change for all the groups');
  const metrics = await store.readMetrics();
  assert.deepEqual({ accepted: metrics.totals.accepted }, { accepted: 0 }, 'does not decide Ctrl+D automatic mode');
  const week = await flow.weeklyMetrics();
  assert.deepEqual({ looseAccepted: week.looseAccepted, looseFiled: week.looseFiled, filed: week.filed }, { looseAccepted: 2, looseFiled: 3, filed: 0 });
  assert.match(/** @type {string} */ ((await flow.lastResult())?.messageEs), /^3 marcadores movidos en 2 grupos, como un solo cambio\. 2 carpetas nuevas\./);
});

test('0.5.1: 42 groups accepted at once are one change, and one «Deshacer» reverts all of them', async () => {
  // A scattered answer: 40 bookmarks each to its own existing folder, 2 to two new folders. Before
  // 0.5.1 this made 42 changes, the journal kept 20, and 22 groups (and folders) could not be undone.
  const loose = /** @type {[string, string][]} */ (Array.from({ length: 42 }, (_, i) => [`Tema ${i}`, `https://tema${i}.example.com/`]));
  const reply = (/** @type {CompletionRequest} */ request) => {
    if (request.user.includes('<bookmark_sample>')) return result({ folders: [{ name: 'Nueva A', description: 'A.' }, { name: 'Nueva B', description: 'B.' }] });
    const folders = JSON.parse(/** @type {string[]} */ (/<folders>\n(.*)\n<\/folders>/s.exec(request.user))[1]);
    const bookmarks = JSON.parse(/** @type {string[]} */ (/<bookmarks>\n(.*)\n<\/bookmarks>/s.exec(request.user))[1]);
    const target = (/** @type {number} */ n) => (n === 40 ? 'Nueva A' : n === 41 ? 'Nueva B' : `Destino ${n}`);
    return result({
      assignments: bookmarks.map((/** @type {any} */ item) => ({ i: item.i, f: folders.find((/** @type {any} */ folder) => folder.name.endsWith(target(Number(item.title.slice(5))))).f, confidence: 'high' })),
    });
  };
  const { flow, b, fake } = await setUp({ reply, loose });
  for (let n = 0; n < 40; n += 1) await b.create({ parentId: '5', title: `Destino ${n}` });
  const before = normalForm(await b.getTree());
  await flow.sortLoose('4');
  assert.equal((await flow.proposals.list()).length, 42);
  const accepted = await flow.proposals.acceptAll('sort-loose');
  assert.deepEqual({ moved: accepted.moved, groups: accepted.groups, created: accepted.createdFolders?.length }, { moved: 42, groups: 42, created: 2 });
  const changes = await createStore(fake.storage.local).listChanges(100);
  assert.equal(changes.length, 1, 'one change, so the journal limit cannot leave part of it behind');
  const undo = await flow.undo(/** @type {string} */ (accepted.changeId));
  assert.equal(undo.restored.length, 42);
  assert.equal(undo.removedFolders.length, 2, 'the folders it created go');
  assert.deepEqual(normalForm(await b.getTree()), before, 'the tree is as it was');
});

test('0.5.1: an undone change is marked as such in listChanges, offers no «Deshacer», and undoing it again is harmless', async () => {
  const { flow, fake, b } = await setUp();
  await flow.sortLoose('4');
  const [proposal] = await flow.proposals.list();
  const applied = await flow.proposals.apply(proposal.id);
  await flow.undo(/** @type {string} */ (applied.changeId));
  const [header] = await createStore(fake.storage.local).listChanges(5);
  assert.deepEqual({ undone: header.undone, undoable: header.undoable, undo: Boolean(header.undo) }, { undone: true, undoable: false, undo: true });
  const rows = await flow.listActivity();
  assert.ok(!rows.some((row) => row.changeId === applied.changeId && row.actions.includes('undo')));
  const before = normalForm(await b.getTree());
  const again = /** @type {any} */ (await flow.undo(/** @type {string} */ (applied.changeId)));
  assert.equal(again.alreadyUndone, true);
  assert.equal((await flow.lastResult())?.messageEs, 'Ese cambio ya estaba deshecho.');
  assert.deepEqual(normalForm(await b.getTree()), before);
});

test('0.5.1: folders deeper than two levels are offered by path, and a cut is reported', async () => {
  const { flow, b, folders, calls } = await setUp();
  const level2 = await b.create({ parentId: folders.Servicios, title: 'Nube' });
  const level3 = await b.create({ parentId: level2.id, title: 'Backups' });
  await b.create({ parentId: level3.id, title: 'Restic', url: 'https://restic.example.com/' });
  await flow.sortLoose('4');
  const sent = calls.map((call) => call.user).join('\n');
  assert.match(sent, /Servicios\/Nube\/Backups/);
  const preview = /** @type {any} */ (await flow.lastSentPreview());
  assert.ok(preview.sent.folders.some((/** @type {{name: string}} */ folder) => folder.name === 'Servicios/Nube/Backups'));
  // A path too long to send is left out, and the confirmation says so.
  await b.create({ parentId: level3.id, title: 'x'.repeat(90) });
  const next = await flow.previewLoose('4');
  assert.equal(next.foldersLeftOut, 1);
  assert.match(sortPreviewView(next).lines[0], /Quedan fuera 1 carpeta \(pasan el tope de 100 o su ruta es muy larga\): no se ofrecen como destino\.$/);
});

test('a group can leave out any of its bookmarks, the first one included', async () => {
  const { flow, b, ids } = await setUp();
  await flow.sortLoose('4');
  const [proposal] = await flow.proposals.list();
  const keep = proposal.together.slice(0, 2).map((member) => member.id);
  const applied = await flow.proposals.apply(proposal.id, { memberIds: keep, includeMain: false });
  assert.equal(applied.moved, 2);
  assert.equal((await b.get(proposal.bookmark.id))[0].parentId, '4');
  for (const member of proposal.together.slice(2)) assert.equal((await b.get(member.id))[0].parentId, '4', 'unticked stays');
  void ids;
  const discarded = await setUp();
  await discarded.flow.sortLoose('4');
  const [other] = await discarded.flow.proposals.list();
  await discarded.flow.proposals.discard(other.id);
  assert.equal((await discarded.flow.weeklyMetrics()).looseDiscarded, 1);
  assert.equal((await discarded.flow.weeklyMetrics()).discarded, 0);
});

test('activity shows one summary row for the sort', async () => {
  const { flow } = await setUp();
  await flow.sortLoose('4');
  const [row] = await flow.listActivity();
  assert.equal(row.kind, 'sorted');
  assert.equal(row.title, 'Ordenar sueltos de «Bookmarks bar»');
  assert.equal(row.messageEs, '1 propuesta para 12 marcadores; 1 sin tema claro; 1 omitido.');
  const { activityView } = await import('../../extension/ui/present.js');
  assert.equal(activityView(row, new Date()).text, 'Ordenar sueltos de «Bookmarks bar»: 1 propuesta para 12 marcadores; 1 sin tema claro; 1 omitido.');
  assert.deepEqual(row.actions, []);
});

test('from a page it runs in the worker, through a message the worker answers', async (t) => {
  const context = await setUp();
  const { fake } = context;
  /** @type {any} */ (globalThis).chrome = { ...fake, storage: fake.storage };
  t.after(() => delete (/** @type {any} */ (globalThis).chrome));
  // The worker's flow uses the fake chrome.*; its provider call is the adapter, so give it a stand-in server.
  const server = await startFakeOpenAi({ dialect: 'gemini' });
  t.after(() => server.close());
  await import(`../../extension/sw.js?sort-${Date.now()}`);
  /** @type {unknown[]} */
  const sent = [];
  const worker = { sendMessage: (/** @type {unknown} */ message) => (sent.push(message), fake.runtime.sendMessage(message)) };
  const page = createFlow({ storage: fake.storage.local, bookmarks: fake.bookmarks, permissions: fake.permissions, action: fake.action, worker });
  const blocked = /** @type {any} */ (await page.sortLoose('nope'));
  assert.deepEqual(sent, [{ type: 'sort-loose', folderId: 'nope' }], 'the page asked the worker');
  assert.equal(blocked.blocked?.reason, 'gone', 'the worker answered');
  assert.equal(await fake.runtime.sendMessage({ type: 'other', folderId: '4' }), undefined, 'other messages are not answered');
  const [listener] = fake.runtime.onMessage.listeners;
  assert.equal(listener({ type: 'sort-loose', folderId: '4' }, { id: 'another-extension' }, () => {}), false, 'only this extension may ask');
});

// --- pure parts ---

test('looseToSort keeps only direct loose bookmarks that may leave, with the reason for the rest', async () => {
  const { bookmarks } = createFakeChrome();
  const folder = await bookmarks.create({ parentId: '1', title: 'Sub' });
  await bookmarks.create({ parentId: folder.id, title: 'deep', url: 'https://deep.example.com/' });
  const ok = await bookmarks.create({ parentId: '1', title: 'Ok', url: 'https://ok.example.com/a?b=1' });
  const pending = await bookmarks.create({ parentId: '1', title: 'Pending', url: 'https://p.example.com/' });
  await bookmarks.create({ parentId: '1', title: 'Local', url: 'http://localhost:8080/' });
  await bookmarks.create({ parentId: '1', title: 'Js', url: 'javascript:alert(1)' });
  const { sendable, omitted } = looseToSort(await bookmarks.getTree(), '1', { pending: new Set([pending.id]) });
  assert.deepEqual(sendable.map((item) => [item.id, item.url, item.host]), [[ok.id, 'ok.example.com/a', 'ok.example.com']]);
  assert.deepEqual(omitted.map((item) => item.reason), ['pending', 'private-host', 'unsupported-scheme']);
  assert.equal(estimatedCalls(0), 0);
  assert.equal(estimatedCalls(50), 2);
  assert.equal(estimatedCalls(51), 3);
});

test('groups: existing names become moves, new ones creates, a «Parent/Child» name goes inside its parent', () => {
  const existing = [
    { id: '10', name: 'DBT', title: 'DBT', parentId: '4', examples: [] },
    { id: '11', name: 'Dev', title: 'Dev', parentId: '4', examples: [] },
  ];
  const choices = classificationFolders(existing, [{ name: 'dbt', description: 'Datos.' }, { name: 'IA', description: 'IA.' }, { name: 'Dev/CI', description: 'CI.' }]);
  assert.deepEqual(choices.folders.map((folder) => folder.name), ['DBT', 'Dev', 'IA', 'Dev/CI']);
  assert.equal(choices.folders[0].description, 'Datos.');
  const { groups, unsorted } = groupAssignments(
    [
      { id: 'a', folder: 'DBT', confidence: 'high' },
      { id: 'b', folder: 'IA', confidence: 'high' },
      { id: 'c', folder: 'IA', confidence: 'low' },
      { id: 'd', folder: 'Dev/CI', confidence: 'high' },
      { id: 'e', folder: UNSORTED, confidence: 'high' },
    ],
    choices,
    '4',
  );
  assert.deepEqual(groups, [
    { kind: 'move', folder: { id: '10', name: 'DBT' }, members: ['a'], confidence: 'high' },
    { kind: 'create', parentId: '4', name: 'IA', description: 'IA.', members: ['b', 'c'], confidence: 'low' },
    { kind: 'create', parentId: '11', name: 'CI', description: 'CI.', members: ['d'], confidence: 'high' },
  ]);
  assert.deepEqual(unsorted, ['e']);
});
