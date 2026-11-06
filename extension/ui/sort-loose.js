/**
 * «Ordenar sueltos», shared by the popup and the settings page: pick a folder with loose
 * bookmarks, read exactly what will leave, and only then send. Never runs on its own. Text
 * reaches the DOM only through `textContent` and created nodes.
 */

import * as api from './api.js';
import { button, el, messageOf } from './dom.js';
import { plural, sortPreviewView } from './present.js';

/**
 * @param {HTMLElement} container
 * @param {{onDone: () => Promise<void> | void}} options
 */
export async function mountSortLoose(container, { onDone }) {
  const picker = /** @type {HTMLSelectElement} */ (el('select'));
  picker.setAttribute('aria-label', 'Carpeta con marcadores sueltos');
  const start = button('Ordenar sueltos', () => showPreview());
  const panel = el('div', undefined, 'card');
  panel.hidden = true;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Confirmar «Ordenar sueltos»');
  const status = el('p', '', 'note');
  status.setAttribute('role', 'status');
  const row = el('p', undefined, 'row');
  row.append(picker, ' ', start);
  container.replaceChildren(row, panel, status);

  const fill = async () => {
    const folders = await api.looseFolders();
    const previous = picker.value;
    picker.replaceChildren(...folders.map((folder) => new Option(`${folder.path} (${plural(folder.loose, 'suelto', 'sueltos')})`, folder.id)));
    if (folders.some((folder) => folder.id === previous)) picker.value = previous;
    start.disabled = folders.length === 0;
    if (folders.length === 0) status.textContent = 'No hay marcadores sueltos.';
  };

  const showPreview = async () => {
    status.textContent = '';
    const folderId = picker.value;
    if (!folderId) return;
    const view = sortPreviewView(await api.previewLoose(folderId));
    panel.replaceChildren(...view.lines.slice(0, 3).map((line) => el('p', line)));
    if (view.omitted.length > 0) {
      const list = el('ul', undefined, 'note loose');
      for (const line of view.omitted) list.append(el('li', line));
      panel.append(list);
    }
    if (view.lines[3]) panel.append(el('p', view.lines[3], 'note'));
    const actions = el('div', undefined, 'actions');
    if (view.ok) {
      actions.append(
        button(view.confirmLabel, async () => {
          for (const other of actions.querySelectorAll('button')) /** @type {HTMLButtonElement} */ (other).disabled = true;
          status.textContent = 'Ordenando… puede tardar unos segundos.';
          try {
            const result = await api.sortLoose(folderId);
            status.textContent = result?.blocked ? result.blocked.messageEs : 'Listo: revisa las propuestas.';
          } catch (error) {
            status.className = 'note error';
            status.textContent = `Error: ${messageOf(error)}`;
          }
          panel.hidden = true;
          await onDone();
          await fill();
        }, 'primary'),
      );
    }
    actions.append(button(view.ok ? 'Cancelar' : 'Cerrar', () => void (panel.hidden = true)));
    panel.append(actions);
    panel.hidden = false;
    /** @type {HTMLButtonElement | null} */ (actions.querySelector('button'))?.focus();
  };

  await fill();
  return { refresh: fill };
}
