/**
 * Service worker: the automatic sort of Ctrl+D, off until the person turns it on in the settings.
 * Listeners are registered at the top level, synchronously: "Registering a listener
 * asynchronously (for example inside a promise or callback) is not guaranteed to work in
 * Manifest V3" (https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers).
 * Nothing is kept in globals that must survive the worker, except the import flag, whose loss
 * the active-tab check covers.
 */

import { recoverInterrupted } from './platform/bookmarks.js';
import { createAutoSorter } from './platform/autosort.js';
import { createFlow } from './platform/flow.js';

const sorter = createAutoSorter({
  bookmarks: chrome.bookmarks,
  tabs: chrome.tabs,
  permissions: chrome.permissions,
  storage: chrome.storage.local,
  action: chrome.action,
});

chrome.bookmarks.onCreated.addListener((id, node) => {
  void sorter.handleCreated(id, node);
});
chrome.bookmarks.onImportBegan.addListener(() => sorter.importBegan());
chrome.bookmarks.onImportEnded.addListener(() => sorter.importEnded());
// A proposal whose bookmark the person moves or deletes is dropped, and the badge count follows.
chrome.bookmarks.onMoved.addListener(() => void sorter.prune());
chrome.bookmarks.onRemoved.addListener(() => void sorter.prune());

// «Ordenar sueltos» runs here, asked by a page, so a popup that closes does not cut it short.
// "To respond asynchronously using sendResponse(), return a literal true"
// (https://developer.chrome.com/docs/extensions/develop/concepts/messaging).
const flow = createFlow();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'sort-loose' || typeof message.folderId !== 'string') return false;
  flow.sortLoose(message.folderId).then(sendResponse, (error) =>
    sendResponse({ ok: false, blocked: { reason: 'error', messageEs: `No se pudo ordenar: ${error instanceof Error ? error.message : String(error)}` } }),
  );
  return true;
});

// A new install opens the settings, where the person turns the sort on and pins the icon.
// https://developer.chrome.com/docs/extensions/reference/api/runtime#event-onInstalled
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') void chrome.runtime.openOptionsPage().catch(() => {});
});

/** A change a stopped worker left half done is reconciled, and old proposals expire. */
const startUp = () => {
  void recoverInterrupted({ bookmarks: chrome.bookmarks, store: sorter.journal }).catch(() => {});
  void sorter.expire();
};
chrome.runtime.onStartup.addListener(startUp);
startUp();

// The API key lives in storage.local, which "By default, it's exposed to content scripts". There
// are none, and this keeps it that way if one is ever added.
// https://developer.chrome.com/docs/extensions/reference/api/storage
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
