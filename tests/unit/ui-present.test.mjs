import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activityView,
  backupReminder,
  cleanFolderName,
  folderOptions,
  formatMoney,
  formatWhen,
  groupProposals,
  lastResultView,
  metricsLine,
  moveQuestion,
  parseMaxCalls,
  plural,
  resultView,
  saveMessage,
  sentView,
  statusView,
  testResultText,
  usageLine,
} from '../../extension/ui/present.js';

// Local-time dates, so no test depends on the machine's time zone.
const NOW = new Date(2026, 10, 5, 20, 0, 0);
const iso = (/** @type {number} */ day, /** @type {number} */ hour = 19, /** @type {number} */ minute = 47) => new Date(2026, 10, day, hour, minute).toISOString();

test('plural agrees with the count and groups thousands the Latin American way', () => {
  assert.equal(plural(1, 'movido', 'movidos'), '1 movido');
  assert.equal(plural(0, 'movido', 'movidos'), '0 movidos');
  assert.equal(plural(2, 'movido', 'movidos'), '2 movidos');
  assert.match(plural(1234, 'movido', 'movidos'), /^1[ ,  ]?234 movidos$/);
});

test('money uses a decimal comma or point of es-419 with four decimals under a dollar', () => {
  assert.match(formatMoney(0.0011), /^US\$0[.,]0011$/);
  assert.match(formatMoney(0.1), /^US\$0[.,]1000$/);
});

test('formatWhen says today, yesterday, or the date', () => {
  assert.match(formatWhen(iso(5), NOW), /^hoy 19:47$/);
  assert.match(formatWhen(iso(4), NOW), /^ayer 19:47$/);
  assert.match(formatWhen(iso(1), NOW), /^1 nov,? 19:47$/);
  assert.equal(formatWhen('not a date', NOW), '');
});

test('the status line is calm when active and says how to fix it when paused', () => {
  assert.deepEqual(statusView({ state: 'off' }), { tone: 'off', text: 'Orden automático apagado', action: 'open-settings', actionLabel: 'Activar' });
  const active = statusView({ state: 'active', model: 'gemini-3.5-flash-lite', usage: { calls: 3, max: 50 } });
  assert.equal(active.tone, 'ok');
  assert.equal(active.text, 'Orden automático activo · gemini-3.5-flash-lite · 3/50 hoy');
  assert.match(statusView({ state: 'confirm' }).text, /^Orden con confirmación/);
  const permission = statusView({ state: 'paused', reason: 'no-permission' });
  assert.equal(permission.tone, 'error');
  assert.equal(permission.action, 'repair-permission');
  assert.equal(permission.actionLabel, 'Reparar');
  assert.match(permission.text, /^Pausado: falta un permiso/);
  const capped = statusView({ state: 'paused', reason: 'daily-calls' });
  assert.equal(capped.tone, 'warn');
  assert.equal(capped.action, undefined);
  assert.match(statusView({ state: 'paused', reason: 'error', errorMessage: 'La clave no es válida' }).text, /la clave no es válida/);
  assert.equal(statusView(null).tone, 'off');
});

test('an activity row names the bookmark, the destination and the reason, and offers only known actions', () => {
  const moved = activityView({ at: iso(5), kind: 'moved', title: 'dbt incremental', host: 'docs.getdbt.com', folder: 'DBT', actions: ['undo'] }, NOW);
  assert.equal(moved.icon, '✓');
  assert.equal(moved.text, 'dbt incremental → DBT');
  assert.deepEqual(moved.actions, [{ id: 'undo', label: 'Deshacer' }]);
  const failed = activityView({ at: iso(5), kind: 'error', title: '', host: 'a.com', messageEs: 'Gemini sin cuota por ahora', actions: ['retry', 'bogus'] }, NOW);
  assert.equal(failed.tone, 'error');
  assert.equal(failed.text, '(sin título) (a.com): Gemini sin cuota por ahora');
  assert.deepEqual(failed.actions.map((action) => action.id), ['retry']);
  const proposed = activityView({ at: iso(5), kind: 'proposed', title: 'X', folder: 'IA', newFolder: true }, NOW);
  assert.equal(proposed.text, 'X → IA (carpeta nueva): espera tu respuesta');
});

test('known reasons are translated and unknown ones are shown as they come', () => {
  assert.match(activityView({ at: iso(5), kind: 'left', title: 'K', reason: 'no-topic' }, NOW).text, /no tiene un tema claro$/);
  assert.match(activityView({ at: iso(5), kind: 'left', title: 'K', reason: 'saved-in-folder' }, NOW).text, /se respeta tu elección$/);
  assert.match(activityView({ at: iso(5), kind: 'left', title: 'K', reason: 'something-new' }, NOW).text, /: something-new$/);
});

test('the result strip names the folder, counts with agreement and keeps Undo only when something moved', () => {
  const done = resultView({ moved: 11, createdFolder: 'IA', changeId: 'change:1' });
  assert.equal(done.text, 'Carpeta «IA» creada. 11 marcadores movidos.');
  assert.equal(done.changeId, 'change:1');
  assert.equal(resultView({ moved: 2, reusedFolder: 'IA', changeId: 'c' }).text, 'Se usó la carpeta «IA», que ya existía. 2 marcadores movidos.');
  assert.match(resultView({ moved: 1, changeId: 'c' }).text, /^1 marcador movido\.$/);
  const partial = resultView({ moved: 1, skipped: [{ title: 'A', reason: 'moved' }, { id: '7' }], changeId: 'c' });
  assert.match(partial.text, /2 omitidos: «A», «7»\.$/);
  const none = resultView({ moved: 0, changeId: 'c' });
  assert.equal(none.changeId, null);
  assert.equal(none.tone, 'warn');
  assert.equal(resultView({ moved: 0, stale: true }).changeId, null);
});

test('proposals that would create the same folder are grouped, whatever the accents or case', () => {
  const create = (/** @type {string} */ id, /** @type {string} */ name, /** @type {string} */ at) => ({ id, kind: 'create', createdAt: at, bookmark: { id: `b${id}`, title: id }, newFolder: { name } });
  const groups = groupProposals([
    create('1', 'Inteligencia artificial', '2026-11-01'),
    { id: '2', kind: 'move', createdAt: '2026-11-02', bookmark: { id: 'b2', title: 'm' }, folder: { id: 'f', name: 'DBT' } },
    create('3', 'inteligencia  Artificial', '2026-11-03'),
    create('4', 'Recetas', '2026-11-04'),
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => group.proposals.map((proposal) => proposal.id)), [['4'], ['3', '1'], ['2']]);
  assert.equal(groups[1].acceptAllLabel, 'Aceptar las 2 de «Inteligencia artificial»');
  assert.equal(groups[0].acceptAllLabel, null);
});

test('the typed folder name is one trimmed line, bounded, and falls back when empty', () => {
  assert.equal(cleanFolderName('  Inteligencia\n artificial  ', 'IA'), 'Inteligencia artificial');
  assert.equal(cleanFolderName('   ', 'IA'), 'IA');
  assert.equal(cleanFolderName('x'.repeat(100), 'IA').length, 40);
});

test('the weekly line is absent without data and says how bookmarks were filed', () => {
  assert.equal(metricsLine(null), null);
  assert.equal(
    metricsLine({ filed: 12, moved: 0, accepted: 2, corrected: 1, undone: 1, undoneBookmarks: 10, discarded: 0, looseInBar: 29 }),
    'Esta semana: 12 marcadores ubicados (2 propuestas aceptadas, 1 corregido por ti); 10 devueltos con Deshacer. Sueltos en la barra: 29.',
  );
  assert.equal(metricsLine({ filed: 1, moved: 1, accepted: 0, undone: 0, discarded: 1 }), 'Esta semana: 1 marcador ubicado (1 automático); 1 propuesta descartada.');
  assert.equal(metricsLine({ filed: 0, moved: 0, accepted: 0, undone: 0, discarded: 0 }), 'Esta semana: 0 marcadores ubicados.');
});

test('the backup reminder turns stale after two weeks', () => {
  assert.deepEqual(backupReminder(null, NOW), { stale: true, text: 'Todavía no has hecho un respaldo.' });
  assert.deepEqual(backupReminder(iso(5, 8), NOW), { stale: false, text: 'Último respaldo: hoy.' });
  assert.deepEqual(backupReminder(new Date(2026, 10, 2, 8).toISOString(), NOW), { stale: false, text: 'Último respaldo: hace 3 días.' });
  assert.equal(backupReminder(new Date(2026, 9, 1).toISOString(), NOW).stale, true);
});

test('the daily cap typed in settings is rejected unless it is an integer in range', () => {
  assert.deepEqual(parseMaxCalls('50'), { ok: true, value: 50 });
  for (const bad of ['', '0', '-3', '1.5', 'abc', '1001']) assert.equal(parseMaxCalls(bad).ok, false, bad);
  assert.match(/** @type {{message: string}} */ (parseMaxCalls('0')).message, /entre 1 y 1.?000/);
});

test('usage and save messages say what happened', () => {
  assert.match(usageLine({ calls: 3, max: 50, spentUsd: 0.0011, capUsd: 0.1 }, false), /^Hoy: 3 de 50 llamadas, US\$0[.,]0011 de US\$0[.,]1000 calculado a tarifa de pago\.$/);
  assert.match(usageLine({ calls: 50, max: 50 }, true), /Tope alcanzado/);
  assert.equal(saveMessage({ wantsOn: true, enabled: false, missing: ['la clave', 'los permisos que Chrome pidió'], model: 'x' }), 'Guardado, pero sigue apagado: falta la clave, los permisos que Chrome pidió.');
  assert.equal(saveMessage({ wantsOn: false, enabled: false, missing: [], model: 'x' }), 'Guardado. Orden automático apagado.');
  assert.equal(saveMessage({ wantsOn: true, enabled: true, missing: [], model: 'flash', confirm: true }), 'Guardado. Orden automático activado con flash: te pide confirmar antes de mover.');
  assert.match(saveMessage({ wantsOn: true, enabled: true, missing: [], model: 'flash', confirm: false }), /mueve sin preguntar/);
});

test('folder options list nested folders with their path and leave out bookmarks and managed roots', () => {
  const tree = [
    {
      id: '0', title: '', children: [
        { id: '1', title: 'Barra', children: [
          { id: '10', title: 'DBT', children: [{ id: '11', title: 'core', children: [] }, { id: '12', title: 'a', url: 'https://a.com' }] },
          { id: '13', title: 'x', url: 'https://x.com' },
        ] },
        { id: '2', title: 'Otros', children: [] },
        { id: '9', title: 'Administrada', unmodifiable: 'managed', children: [{ id: '90', title: 'oculta', children: [] }] },
      ],
    },
  ];
  assert.deepEqual(folderOptions(tree).map((option) => [option.id, option.path, option.depth]), [
    ['1', 'Barra', 0], ['10', 'Barra / DBT', 1], ['11', 'Barra / DBT / core', 2], ['2', 'Otros', 0],
  ]);
  assert.equal(folderOptions(tree, 2).length, 2);
});

test('a move proposal says "no estaba segura" only when the IA doubted', () => {
  assert.equal(moveQuestion({ reason: 'confirm-mode', folder: { name: 'DBT' } }), '¿Mover a «DBT»?');
  assert.equal(moveQuestion({ reason: 'low-confidence', folder: { name: 'DBT' } }), 'La IA no estaba segura: ¿mover a «DBT»?');
  assert.equal(moveQuestion({ confidence: 'high', folder: { name: 'DBT' } }), '¿Mover a «DBT»?');
  assert.equal(moveQuestion({ confidence: 'low', folder: { name: 'DBT' } }), 'La IA no estaba segura: ¿mover a «DBT»?');
});

test('row actions that would only repeat or duplicate something are dropped', () => {
  const ids = (/** @type {any} */ entry) => activityView({ at: iso(5), title: 'X', ...entry }, NOW).actions.map((action) => action.id);
  assert.deepEqual(ids({ kind: 'left', reason: 'no-topic', actions: ['retry', 'choose-folder'] }), ['choose-folder']);
  assert.deepEqual(ids({ kind: 'error', reason: 'error', actions: ['retry', 'choose-folder'] }), ['retry', 'choose-folder']);
  assert.deepEqual(ids({ kind: 'proposed', actions: ['choose-folder', 'retry'] }), ['retry']);
  assert.deepEqual(ids({ kind: 'duplicate', actions: ['choose-folder', 'remove-duplicate'] }), ['remove-duplicate']);
});

test('the paused-for-permission line agrees with its Repair button', () => {
  const view = statusView({ state: 'paused', reason: 'no-permission', action: 'repair-permission', errorMessage: 'Falta un permiso de Chrome. Abre Ajustes y pulsa «Guardar» para pedirlo.' });
  assert.equal(view.text, 'Pausado: falta un permiso de Chrome');
  assert.equal(view.actionLabel, 'Reparar');
});

test('the strip after reopening shows the stored result, with Undo only while it can be undone', () => {
  assert.equal(lastResultView(null), null);
  assert.deepEqual(lastResultView({ messageEs: 'Carpeta «IA» creada. 10 marcadores movidos.', changeId: 'c1', undoable: true }), { tone: 'ok', text: 'Carpeta «IA» creada. 10 marcadores movidos.', changeId: 'c1' });
  assert.equal(lastResultView({ messageEs: 'Deshecho.', changeId: 'c1', undoable: false })?.changeId, null);
});

test('an activity row shows the trimmed-context notice once, and the provider detail apart', () => {
  const row = activityView({ at: iso(5), kind: 'moved', title: 'X', folder: 'DBT', truncation: { sent: 100, total: 140 }, detail: 'Rate limited' }, NOW);
  assert.equal(row.note, 'Contexto recortado: se enviaron 100 de 140 carpetas.');
  assert.equal(row.detail, 'Rate limited');
  const error = activityView({ at: iso(5), kind: 'error', title: 'X', messageEs: 'Sin cuota. Se enviaron 100 de 140 carpetas.', truncation: { sent: 100, total: 140 } }, NOW);
  assert.equal(error.note, null);
});

test('the status line warns about an excluded folder that changed', () => {
  const view = statusView({ state: 'confirm', exclusionWarnings: [{ path: 'Banco', status: 'changed' }] });
  assert.equal(view.tone, 'warn');
  assert.match(view.text, /Una carpeta excluida cambió: revísala en Ajustes\.$/);
  assert.equal(view.action, 'open-settings');
});

test('what was sent lists the bookmark, the folders with examples and the loose ones; titles and hosts only', () => {
  assert.equal(sentView(null), null);
  const view = sentView({ sent: { bookmark: { title: 'dbt incremental', host: 'docs.getdbt.com' }, folders: [{ name: 'DBT', examples: ['a', 'b'] }, { name: 'Cocina', examples: [] }], loose: [{ title: 'Claude', host: 'claude.ai' }] }, truncatedFolders: 3 });
  assert.equal(view?.summary, 'Lo último que se envió: el marcador, 2 carpetas, 2 ejemplos y 1 suelto (3 carpetas no cupieron). Sin URL completas ni clave.');
  assert.deepEqual(view?.lines, ['Marcador: dbt incremental · docs.getdbt.com', 'Carpeta «DBT»: a; b', 'Carpeta «Cocina»', 'Suelto: Claude · claude.ai']);
  assert.deepEqual(sentView({ folders: 4, examples: 9, loose: 2 })?.lines, []);
});

test('the key test says it counts against the daily cap, whatever the outcome', () => {
  assert.equal(testResultText({ ok: true, messageEs: '', ms: 412, servedModel: 'flash' }), 'La clave funciona. (flash, 412 ms) Esta prueba cuenta en el tope diario.');
  assert.equal(testResultText({ ok: false, messageEs: 'La clave no es válida: revísala en Ajustes.' }), 'La clave no es válida: revísala en Ajustes. Esta prueba cuenta en el tope diario.');
});
