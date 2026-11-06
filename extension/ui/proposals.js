/**
 * "Por revisar": one card per proposal, grouped when several would create the same folder.
 * A card the person is editing is never rebuilt: the list is reconciled by proposal id, so a new
 * proposal arriving from the worker adds a card and leaves the rest (typed names, unticked
 * boxes) as they are.
 *
 * Each card shows the bookmark with its host, and offers: for a `create`, an editable folder
 * name, the loose bookmarks that would go along (ticked), "Crear y mover" and "Crear solo con
 * este"; for a `move`, "Mover" and "Otra carpeta…". Always "Dejar como está".
 */

import * as api from './api.js';
import { button, byId, el, messageOf } from './dom.js';
import { cleanFolderName, groupProposals, moveQuestion } from './present.js';

/** @typedef {Awaited<ReturnType<typeof api.listProposals>>[number]} Proposal */

/** @param {{onApplied: (result: {moved: number, skipped: any[], stale: boolean, createdFolder?: string, changeId: string | null, error?: {category?: string, messageEs?: string}}) => Promise<void> | void}} options */
export async function setUpProposals({ onApplied }) {
  /** @type {Map<string, HTMLElement>} */
  const cards = new Map();
  /** @type {{id: string, path: string, depth: number}[] | null} */
  let folders = null;

  /** @param {() => Promise<ReturnType<typeof api.applyProposal> extends Promise<infer R> ? R : never>} run */
  const finish = async (run) => {
    try {
      await onApplied(await run());
    } catch (error) {
      await onApplied({ moved: 0, skipped: [], stale: false, changeId: null });
      byId('result-text').textContent = `Error: ${messageOf(error)}`;
      byId('result').className = 'strip error';
    }
    await render();
  };

  /**
   * A group from «Ordenar sueltos»: every bookmark of the group can be unticked, the first one
   * too, and the buttons say how many go.
   *
   * @param {Proposal} proposal
   */
  const sortedCard = (proposal) => {
    const item = el('li', undefined, 'card');
    item.dataset.id = proposal.id;
    const members = [proposal.bookmark, ...proposal.together];
    /** @type {HTMLInputElement | null} */
    let nameInput = null;
    if (proposal.kind === 'move') {
      const doubt = proposal.reason === 'low-confidence' ? 'La IA no estaba segura: ' : '';
      item.append(el('p', `Ordenar sueltos: ${doubt}¿mover a «${proposal.folder?.name ?? ''}»?`));
    } else {
      const folder = proposal.newFolder ?? { name: '', parentTitle: '', description: '' };
      item.append(el('p', 'Ordenar sueltos: carpeta nueva'));
      const label = /** @type {HTMLLabelElement} */ (el('label', 'Nombre ', 'field'));
      nameInput = /** @type {HTMLInputElement} */ (el('input'));
      nameInput.type = 'text';
      nameInput.value = folder.name;
      nameInput.maxLength = 40;
      nameInput.setAttribute('aria-label', `Nombre de la carpeta nueva «${folder.name}»`);
      label.append(nameInput, el('span', `en «${folder.parentTitle}»`, 'note'));
      item.append(label);
      if (folder.description) item.append(el('p', folder.description, 'note'));
    }
    item.append(el('p', 'Desmarca los que no van:', 'note'));
    const list = el('ul', undefined, 'plain loose');
    /** @type {HTMLInputElement[]} */
    const boxes = members.map((member) => {
      const box = /** @type {HTMLInputElement} */ (el('input'));
      box.type = 'checkbox';
      box.checked = true;
      box.value = member.id;
      const text = el('label');
      text.append(box, ` ${member.title || '(sin título)'}${member.host ? ` · ${member.host}` : ''}`);
      const row = el('li');
      row.append(text);
      list.append(row);
      return box;
    });
    item.append(list);

    const actions = el('div', undefined, 'actions');
    const chosen = () => {
      const ticked = boxes.filter((box) => box.checked).map((box) => box.value);
      return { includeMain: ticked.includes(proposal.bookmark.id), memberIds: ticked.filter((id) => id !== proposal.bookmark.id) };
    };
    const verb = proposal.kind === 'move' ? 'Mover' : 'Crear y mover';
    const main = button(`${verb} ${members.length}`, () => {
      for (const other of actions.querySelectorAll('button')) /** @type {HTMLButtonElement} */ (other).disabled = true;
      return finish(() =>
        api.applyProposal(proposal.id, { ...chosen(), ...(nameInput ? { name: cleanFolderName(nameInput.value, proposal.newFolder?.name ?? '') } : {}) }),
      );
    }, 'primary');
    const recount = () => {
      const count = boxes.filter((box) => box.checked).length;
      main.textContent = `${verb} ${count}`;
      main.disabled = count === 0;
    };
    for (const box of boxes) box.addEventListener('change', recount);
    actions.append(main);
    if (proposal.kind === 'move') {
      const other = button('Otra carpeta…', async () => {
        if (actions.querySelector('select')) return;
        folders ??= await api.getFolders();
        const select = /** @type {HTMLSelectElement} */ (el('select'));
        select.setAttribute('aria-label', 'Otra carpeta para este grupo');
        select.append(new Option('Elegir carpeta…', ''));
        for (const option of folders) select.append(new Option(option.path, option.id));
        select.addEventListener('change', () => {
          if (select.value === '') return;
          void finish(() => api.applyProposal(proposal.id, { ...chosen(), targetFolderId: select.value }));
        });
        actions.insertBefore(select, other.nextSibling);
        select.focus();
      });
      actions.append(other);
    }
    actions.append(
      button('Dejar como está', async () => {
        await api.discardProposal(proposal.id);
        await render();
      }),
    );
    item.append(actions);
    return item;
  };

  /** @param {Proposal} proposal */
  const card = (proposal) => {
    if (proposal.origin === 'sort-loose') return sortedCard(proposal);
    const item = el('li', undefined, 'card');
    item.dataset.id = proposal.id;
    const host = proposal.bookmark.host ? ` · ${proposal.bookmark.host}` : '';
    const title = proposal.bookmark.title || '(sin título)';
    /** @type {HTMLInputElement[]} */
    const boxes = [];
    /** @type {HTMLInputElement | null} */
    let nameInput = null;
    /** @type {HTMLSelectElement | null} */
    let picker = null;

    if (proposal.kind === 'move') {
      item.append(el('p', `«${title}»${host}: ${moveQuestion(proposal)}`));
    } else {
      const folder = proposal.newFolder ?? { name: '', parentTitle: '', description: '' };
      item.append(el('p', `«${title}»${host}`));
      const label = /** @type {HTMLLabelElement} */ (el('label', 'Nueva carpeta ', 'field'));
      nameInput = /** @type {HTMLInputElement} */ (el('input'));
      nameInput.type = 'text';
      nameInput.value = folder.name;
      nameInput.maxLength = 40;
      nameInput.setAttribute('aria-label', `Nombre de la carpeta nueva para ${title}`);
      label.append(nameInput, el('span', `en «${folder.parentTitle}»`, 'note'));
      item.append(label);
      if (folder.description) item.append(el('p', folder.description, 'note'));
      if (proposal.together.length > 0) {
        item.append(el('p', `También irían ${proposal.together.length === 1 ? 'este marcador suelto' : `estos ${proposal.together.length} marcadores sueltos`} (desmarca los que no):`, 'note'));
        const list = el('ul', undefined, 'plain loose');
        for (const member of proposal.together) {
          const box = /** @type {HTMLInputElement} */ (el('input'));
          box.type = 'checkbox';
          box.checked = true;
          box.value = member.id;
          boxes.push(box);
          const row = el('li');
          const text = el('label');
          text.append(box, ` ${member.title || '(sin título)'}${member.host ? ` · ${member.host}` : ''}`);
          row.append(text);
          list.append(row);
        }
        item.append(list);
      }
    }

    const actions = el('div', undefined, 'actions');
    const lock = () => {
      for (const other of actions.querySelectorAll('button')) /** @type {HTMLButtonElement} */ (other).disabled = true;
    };
    /** @param {string} label @param {() => ReturnType<typeof api.applyProposal>} run @param {boolean} [primary] */
    const act = (label, run, primary = false) => {
      const created = button(label, () => {
        lock();
        return finish(run);
      }, primary ? 'primary' : undefined);
      created.setAttribute('aria-label', `${label}: ${title}`);
      actions.append(created);
    };
    const chosen = () => boxes.filter((box) => box.checked).map((box) => box.value);
    const typed = () => cleanFolderName(nameInput?.value ?? '', proposal.newFolder?.name ?? '');

    if (proposal.kind === 'move') {
      act('Mover', () => api.applyProposal(proposal.id, { memberIds: [] }), true);
      const other = button('Otra carpeta…', async () => {
        if (picker) return;
        folders ??= await api.getFolders();
        picker = /** @type {HTMLSelectElement} */ (el('select'));
        picker.setAttribute('aria-label', `Otra carpeta para ${title}`);
        picker.append(new Option('Elegir carpeta…', ''));
        for (const option of folders) picker.append(new Option(option.path, option.id));
        const select = picker;
        select.addEventListener('change', () => {
          if (select.value === '') return;
          lock();
          void finish(() => api.applyProposal(proposal.id, { targetFolderId: select.value, memberIds: [] }));
        });
        actions.insertBefore(select, other.nextSibling);
        select.focus();
      });
      actions.append(other);
    } else {
      act(`Crear y mover ${1 + boxes.length === 1 ? '' : 1 + boxes.length}`.trim(), () => api.applyProposal(proposal.id, { name: typed(), memberIds: chosen() }), true);
      act('Crear solo con este', () => api.applyProposal(proposal.id, { name: typed(), memberIds: [] }));
    }
    actions.append(
      button('Dejar como está', async () => {
        lock();
        await api.discardProposal(proposal.id);
        await render();
      }),
    );
    item.append(actions);
    return item;
  };

  const render = async () => {
    const pending = await api.listProposals();
    const groups = groupProposals(pending);
    byId('proposals-section').hidden = pending.length === 0;
    const ids = new Set(pending.map((proposal) => proposal.id));
    for (const [id, node] of cards) {
      if (!ids.has(id)) {
        node.remove();
        cards.delete(id);
      }
    }
    const list = byId('proposals');
    /** @type {HTMLElement[]} */
    const ordered = [];
    // «Aceptar todas» for the groups of «Ordenar sueltos»: one change per group.
    const sorted = pending.filter((proposal) => proposal.origin === 'sort-loose');
    const allKey = `accept-all:${sorted.length}`;
    for (const [id, node] of cards) if (id.startsWith('accept-all:') && id !== allKey) { node.remove(); cards.delete(id); }
    if (sorted.length >= 2) {
      let header = cards.get(allKey);
      if (!header) {
        header = el('li', undefined, 'card');
        const members = sorted.reduce((total, proposal) => total + proposal.members, 0);
        header.append(
          el('p', `Ordenar sueltos propuso ${sorted.length} grupos con ${members} marcadores.`, 'note'),
          button(`Aceptar todas (${sorted.length})`, async () => {
            await onApplied(await api.acceptAllSorted());
            await render();
          }, 'primary'),
        );
        cards.set(allKey, header);
      }
      ordered.push(header);
    }
    for (const group of groups) {
      if (group.acceptAllLabel) {
        const key = `group:${group.key}:${group.proposals.length}`;
        for (const [id, node] of cards) if (id.startsWith(`group:${group.key}:`) && id !== key) { node.remove(); cards.delete(id); }
        let header = cards.get(key);
        if (!header) {
          header = el('li', undefined, 'card');
          const label = group.acceptAllLabel;
          header.append(
            button(label, async () => {
              await onApplied(await api.acceptGroup(group.name));
              await render();
            }, 'primary'),
          );
          cards.set(key, header);
        }
        ordered.push(header);
      } else {
        for (const id of [...cards.keys()]) if (id.startsWith(`group:${group.key}:`)) { cards.get(id)?.remove(); cards.delete(id); }
      }
      for (const proposal of group.proposals) {
        let node = cards.get(proposal.id);
        if (!node) {
          node = card(proposal);
          cards.set(proposal.id, node);
        }
        ordered.push(node);
      }
    }
    list.replaceChildren(...ordered);
  };

  await render();
  return { refresh: render };
}
