/** Settings page: the automatic sort settings and the count per root. */

import { countByRoot } from '../core/tree.js';
import * as api from './api.js';
import { byId, debounce, el, messageOf } from './dom.js';
import { setUpSettings } from './autosort.js';
import { mountSortLoose } from './sort-loose.js';

async function renderCounts() {
  const rows = countByRoot(await api.getFolderTree()).map((root) => {
    const row = el('tr');
    row.append(el('td', root.title), el('td', root.folderType === 'managed' ? 'Administrada' : root.syncing ? 'Cuenta' : 'Local'), el('td', String(root.bookmarks), 'number'), el('td', String(root.folders), 'number'));
    return row;
  });
  byId('counts').replaceChildren(...rows);
}

renderCounts().catch((error) => {
  byId('counts').replaceChildren(el('tr', `Error: ${messageOf(error)}`));
});
setUpSettings()
  .then(async (settings) => {
    const sortLoose = await mountSortLoose(byId('sort-loose'), { onDone: () => renderCounts() });
    const redraw = debounce(() => void Promise.all([settings.refresh(), renderCounts(), sortLoose.refresh()]).catch(() => {}));
    chrome.storage.onChanged.addListener((_changes, area) => {
      if (area === 'local') redraw();
    });
  })
  .catch((error) => {
    byId('auto-status').className = 'error';
    byId('auto-status').textContent = `Error: ${messageOf(error)}`;
  });
