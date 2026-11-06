/**
 * The popup: status line, the result of the last action with its Undo, proposals to review,
 * recent activity (each row with its own action), the weekly line and the backup. Settings live
 * in their own page. Everything the person typed or saved reaches the DOM only through
 * `textContent` and created nodes. All logic that decides what to show is in `present.js`.
 *
 * Writes go through `api.js`, which serializes them with the worker; the popup keeps no state
 * of its own beyond what is drawn, and redraws from storage events (debounced).
 */

import { serializeBackup } from '../core/backup.js';
import { toNetscapeHtml } from '../core/netscape-export.js';
import { takeSnapshot } from '../platform/bookmarks.js';
import * as api from './api.js';
import { button, byId, debounce, el, messageOf } from './dom.js';
import { activityView, backupReminder, lastResultView, metricsLine, resultView, statusView } from './present.js';
import { setUpProposals } from './proposals.js';
import { mountSortLoose } from './sort-loose.js';

const LAST_BACKUP_KEY = 'lastBackupAt';
const ACTIVITY_PAGE = 8;
let activityCount = ACTIVITY_PAGE;
/** @type {string[]} */
let objectUrls = [];

/** The last-backup stamp is a per-browser convenience, not data the worker needs. */
function lastBackup() {
  try {
    return localStorage.getItem(LAST_BACKUP_KEY);
  } catch {
    return null;
  }
}

/** @param {unknown} error */
function readableError(error) {
  return `Error: ${messageOf(error)}`;
}

function openSettings() {
  void chrome.runtime.openOptionsPage();
}

async function repairPermission() {
  const settings = await api.readSettings();
  // Inside the click: Chrome only shows the dialog for a user gesture.
  const granted = await chrome.permissions.request(api.permissionsFor(settings.ref));
  if (!granted) showResult({ moved: 0, skipped: [], stale: false }, 'Chrome no concedió el permiso. Sin él no se ordena nada.');
  await renderStatus();
}

async function renderStatus() {
  const view = statusView(await api.getStatus().catch(() => null));
  const strip = byId('status');
  strip.className = `strip ${view.tone}`;
  byId('status-text').textContent = `${view.tone === 'error' ? '⚠ ' : view.tone === 'ok' ? '● ' : ''}${view.text}`;
  const action = /** @type {HTMLButtonElement} */ (byId('status-action'));
  action.hidden = !view.action;
  action.textContent = view.actionLabel ?? '';
  action.onclick = view.action === 'repair-permission' ? () => void repairPermission().catch((error) => (byId('status-text').textContent = readableError(error))) : openSettings;
}

/** A message that is not the lane's stored result (an error of this page); it stays until the next action. */
let transient = false;

/**
 * Shows `text` in the strip, with Undo when `changeId` is given.
 *
 * @param {{tone: string, text: string, changeId: string | null}} view
 * @param {boolean} focus move the focus to the strip: only right after an action
 */
function paintResult(view, focus) {
  const strip = byId('result');
  strip.hidden = false;
  strip.className = `strip ${view.tone}`;
  byId('result-text').textContent = view.text;
  const undo = /** @type {HTMLButtonElement} */ (byId('result-undo'));
  undo.hidden = view.changeId === null;
  undo.disabled = false;
  undo.onclick = () => {
    undo.disabled = true;
    void undoChange(/** @type {string} */ (view.changeId));
  };
  if (focus) strip.focus();
}

/**
 * Shows a result of this page that the lane does not store (a stale proposal, an error).
 *
 * @param {Parameters<typeof resultView>[0]} result
 * @param {string} [override]
 */
function showResult(result, override) {
  const view = resultView(result);
  transient = true;
  paintResult({ ...view, text: override ?? view.text, tone: override ? 'error' : view.tone }, true);
}

/**
 * The strip follows the lane's stored last result, so it is still there when the popup reopens.
 *
 * @param {boolean} [focus]
 */
async function renderResult(focus = false) {
  if (transient && !focus) return;
  const view = lastResultView(await api.lastResult().catch(() => null));
  const strip = byId('result');
  if (!view) {
    if (!transient) strip.hidden = true;
    return;
  }
  transient = false;
  paintResult(view, focus);
}

/** @param {string} changeId */
async function undoChange(changeId) {
  transient = false;
  try {
    await api.undo(changeId);
    await renderResult(true);
  } catch (error) {
    showResult({ moved: 0, skipped: [], stale: false }, readableError(error));
  }
  await refreshAll();
}

async function renderActivity() {
  const now = new Date();
  const entries = await api.listActivity(activityCount + 1);
  const list = byId('activity');
  if (entries.length === 0) {
    list.replaceChildren(el('li', 'Sin actividad todavía.', 'note'));
  } else {
    list.replaceChildren(
      ...entries.slice(0, activityCount).map((entry) => {
        const view = activityView(entry, now);
        const item = el('li');
        item.className = view.tone;
        const icon = el('span', view.icon, 'icon');
        icon.setAttribute('aria-hidden', 'true');
        const text = el('span', view.text, 'text');
        if (view.note) text.append(el('br'), el('span', view.note, 'note'));
        if (view.detail) {
          const details = el('details');
          details.append(el('summary', 'Detalles'), el('pre', view.detail, 'note'));
          text.append(details);
        }
        item.append(icon, el('span', view.when, 'when'), text);
        for (const action of view.actions) item.append(rowAction(action.id, action.label, entry, item));
        return item;
      }),
    );
  }
  byId('activity-more').hidden = entries.length <= activityCount;
}

/**
 * @param {string} id
 * @param {string} label
 * @param {import('./present.js').ActivityEntry} entry
 * @param {HTMLElement} item the row, where a folder picker may appear
 */
function rowAction(id, label, entry, item) {
  const named = `${label}: ${entry.title || 'marcador'}`;
  /** @type {() => Promise<void>} */
  let run;
  if (id === 'undo' && entry.changeId) {
    run = () => undoChange(/** @type {string} */ (entry.changeId));
  } else if (id === 'choose-folder' && entry.bookmarkId) {
    run = () => chooseFolderFor(/** @type {string} */ (entry.bookmarkId), entry.title, item);
  } else if (id === 'remove-duplicate' && entry.bookmarkId) {
    run = async () => {
      await api.removeDuplicate(/** @type {string} */ (entry.bookmarkId));
      await refreshAll();
    };
  } else if (id === 'retry' && entry.bookmarkId) {
    run = async () => {
      await api.retry(/** @type {string} */ (entry.bookmarkId));
      await refreshAll();
    };
  } else {
    run = async () => {};
  }
  const node = button(label, () => run().catch((error) => showResult({ moved: 0, skipped: [], stale: false }, readableError(error))), 'link');
  node.setAttribute('aria-label', named);
  return node;
}

/**
 * Adds a folder picker to the row of a bookmark the IA left; picking one moves it.
 *
 * @param {string} bookmarkId
 * @param {string} title
 * @param {HTMLElement} item
 */
async function chooseFolderFor(bookmarkId, title, item) {
  if (item.querySelector('select')) return;
  const options = await api.getFolders();
  const select = /** @type {HTMLSelectElement} */ (el('select'));
  select.setAttribute('aria-label', `Carpeta para ${title || 'el marcador'}`);
  select.append(new Option('Elegir carpeta…', ''));
  for (const option of options) select.append(new Option(option.path, option.id));
  select.addEventListener('change', () => {
    if (select.value === '') return;
    select.disabled = true;
    api
      .chooseFolder(bookmarkId, select.value)
      .then(() => {
        transient = false;
        return renderResult(true);
      })
      .catch((error) => showResult({ moved: 0, skipped: [], stale: false }, readableError(error)))
      .finally(() => void refreshAll());
  });
  item.append(select);
  select.focus();
}

async function renderMetrics() {
  const line = metricsLine(await api.weeklyMetrics().catch(() => null));
  const node = byId('metrics');
  node.hidden = line === null;
  node.textContent = line ?? '';
}

function renderBackupReminder() {
  const reminder = backupReminder(lastBackup(), new Date());
  const node = byId('backup-reminder');
  node.textContent = reminder.text;
  node.className = reminder.stale ? 'note error' : 'note';
}

/** @param {{name: string, type: string, text: string}[]} files */
function download(files) {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  const list = byId('downloads');
  list.replaceChildren();
  for (const { name, type, text } of files) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    objectUrls.push(url);
    const link = /** @type {HTMLAnchorElement} */ (el('a', name));
    link.href = url;
    link.download = name;
    const item = el('li');
    item.append(link);
    list.append(item);
    link.click();
  }
}

async function backUp() {
  const status = byId('backup-status');
  status.className = 'note';
  status.textContent = 'Respaldando…';
  try {
    const { tree, backup } = await takeSnapshot({ store: api.store, kind: 'manual' });
    const stamp = backup.createdAt.slice(0, 19).replaceAll(':', '-');
    download([
      { name: `bookmark-genie-${stamp}.html`, type: 'text/html', text: toNetscapeHtml(tree) },
      { name: `bookmark-genie-${stamp}.backup@1.json`, type: 'application/json', text: serializeBackup(backup) },
    ]);
    try {
      localStorage.setItem(LAST_BACKUP_KEY, backup.createdAt);
    } catch {
      // Private window or blocked site data: the reminder just stays as it was.
    }
    status.textContent = `Respaldo guardado (${backup.nodes.length} nodos). Si falta un archivo, haz clic en su enlace.`;
    renderBackupReminder();
  } catch (error) {
    status.className = 'error';
    status.textContent = readableError(error);
  }
}

/** @type {{refresh: () => Promise<void>} | undefined} */
let proposalsView;
/** @type {{refresh: () => Promise<void>} | undefined} */
let sortLooseView;

async function refreshAll() {
  await Promise.allSettled([renderStatus(), renderActivity(), renderMetrics(), renderResult(), proposalsView?.refresh(), sortLooseView?.refresh()]);
}

if (location.search === '?tab') byId('open-tab').hidden = true;
byId('open-settings').addEventListener('click', openSettings);
byId('result-close').addEventListener('click', () => {
  transient = false;
  byId('result').hidden = true;
  void api.dismissLastResult();
});
byId('backup').addEventListener('click', () => {
  const backupButton = /** @type {HTMLButtonElement} */ (byId('backup'));
  backupButton.disabled = true;
  void backUp().finally(() => (backupButton.disabled = false));
});
byId('activity-more').addEventListener('click', () => {
  activityCount += ACTIVITY_PAGE;
  void renderActivity();
});
renderBackupReminder();

api.init()
  .then(() => setUpProposals({
  onApplied: async (result) => {
    // A stale or failed apply is not stored by the lane: say it here. Otherwise show what it stored.
    if (result.stale || result.error) showResult(result, result.error?.messageEs);
    else await renderResult(true);
    await refreshAll();
  },
}))
  .then(async (view) => {
    proposalsView = view;
    sortLooseView = await mountSortLoose(byId('sort-loose'), {
      onDone: async () => {
        transient = false;
        await renderResult(true);
        await refreshAll();
      },
    });
    return refreshAll();
  })
  .then(() => api.acknowledgeErrors())
  .catch((error) => {
    byId('status-text').textContent = readableError(error);
  });

// The worker writes while this page is open: redraw once per burst.
const redraw = debounce(() => void refreshAll());
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') redraw();
});
