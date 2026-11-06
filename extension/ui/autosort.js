/**
 * Settings of the automatic sort, in their own page (a popup closes when it loses focus, and the
 * permission dialog does exactly that). As in the rest of the extension, data reaches the DOM
 * only through `textContent` and created nodes.
 *
 * Save order matters: the key, the consent and the other settings are written in the same turn
 * of the click that asks Chrome for permissions, and "on" is written only afterwards. If the
 * page dies behind the dialog, nothing typed is lost.
 */

import { parseModelRef } from '../core/models.js';
import { hostPermissionFor } from '../platform/settings.js';
import * as api from './api.js';
import { byId, el, messageOf } from './dom.js';
import { runSave } from './save-flow.js';
import { parseMaxCalls, saveMessage, sentView, statusView, testResultText, usageLine } from './present.js';

const input = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (byId(id));
const select = (/** @type {string} */ id) => /** @type {HTMLSelectElement} */ (byId(id));

function fillModels() {
  const models = select('auto-model');
  /** @type {Map<string, HTMLOptGroupElement>} */
  const groups = new Map();
  for (const entry of api.models()) {
    let group = groups.get(entry.provider.id);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = entry.provider.name;
      groups.set(entry.provider.id, group);
      models.append(group);
    }
    const pending = entry.provider.adapter === 'anthropic-sdk';
    const gone = entry.unavailable || entry.id === 'gemini-2.5-flash-lite';
    const option = new Option(pending ? `${entry.id} (próximamente)` : gone ? `${entry.id} (no disponible para cuentas nuevas)` : entry.id, entry.ref);
    option.disabled = pending || gone;
    group.append(option);
  }
}

export async function setUpSettings() {
  await api.init();
  fillModels();
  const status = byId('auto-status');
  /** @type {string[]} */
  let excluded = [];
  /** @type {{id: string, path: string, depth: number}[]} */
  let folders = [];

  const showFolders = () => {
    const box = byId('auto-excluded');
    box.replaceChildren(
      ...(folders.length === 0 ? [el('p', 'No hay carpetas.', 'note')] : folders.map((folder) => {
        const label = el('label');
        label.style.display = 'block';
        label.style.paddingLeft = `${folder.depth * 14}px`;
        const check = /** @type {HTMLInputElement} */ (el('input'));
        check.type = 'checkbox';
        check.value = folder.id;
        check.checked = excluded.includes(folder.id);
        label.append(check, ` ${folder.path.split(api.PATH_SEPARATOR).at(-1)}`);
        return label;
      })),
    );
  };

  const showProvider = async () => {
    const view = await api.readProviderView(select('auto-model').value);
    byId('auto-policy').replaceChildren(...view.policySummary.slice(0, 3).map((/** @type {string} */ line) => el('li', line)));
    byId('auto-policy-full').textContent = view.policyFull.join('\n');
    byId('auto-consent-row').hidden = !view.needsConsent;
    byId('auto-consent-text').textContent = view.consentText;
    input('auto-consent').checked = view.consented;
    byId('auto-key-saved').textContent = view.keyHint ? `Clave guardada: ${view.keyHint}. Escribe otra para reemplazarla.` : 'Sin clave guardada.';
    byId('auto-key-delete').hidden = !view.keyHint;
    byId('auto-key-test').hidden = !view.keyHint;
    return view;
  };

  const showState = async () => {
    const view = statusView(await api.getStatus().catch(() => null));
    const strip = byId('state');
    strip.className = `strip ${view.tone}`;
    strip.textContent = view.text;
    const { usage, capped } = await api.readUsage();
    byId('auto-usage').textContent = usageLine(usage, capped);
    const sent = sentView(await api.lastSentPreview().catch(() => null));
    byId('auto-sent-box').hidden = !sent;
    if (sent) {
      byId('auto-sent').textContent = `Ver qué se envió. ${sent.summary}`;
      byId('auto-sent-list').replaceChildren(...sent.lines.map((line) => el('li', line)));
    }
  };

  const show = async () => {
    const settings = await api.readSettings();
    excluded = /** @type {string[]} */ (settings.excludedFolderIds ?? []);
    input('auto-enabled').checked = settings.enabled;
    input('auto-confirm').checked = settings.confirmBeforeMove !== false;
    select('auto-model').value = settings.ref;
    select('auto-context').value = settings.contextMode ?? 'full';
    input('auto-max-calls').value = String(settings.maxCallsPerDay);
    showFolders();
    await showProvider();
    await showState();
    return settings;
  };

  const settings = await api.readSettings();
  folders = await api.getFolders();
  await show();

  select('auto-model').addEventListener('change', () => void showProvider());
  input('auto-max-calls').addEventListener('input', () => {
    const parsed = parseMaxCalls(input('auto-max-calls').value);
    byId('auto-max-error').textContent = parsed.ok ? '' : parsed.message;
  });
  byId('auto-key-test').addEventListener('click', () => {
    const result = byId('auto-key-test-result');
    if (input('auto-key').value.trim() !== '') {
      result.className = 'note';
      result.textContent = 'Pulsa «Guardar» antes de probar la clave nueva.';
      return;
    }
    const testButton = /** @type {HTMLButtonElement} */ (byId('auto-key-test'));
    testButton.disabled = true;
    result.className = 'note';
    result.textContent = 'Probando… cuenta en el tope diario.';
    api
      .testProvider()
      .then(async (outcome) => {
        result.className = outcome.ok ? 'note' : 'error';
        result.textContent = testResultText(outcome);
        await showState();
      })
      .catch((error) => {
        result.className = 'error';
        result.textContent = `Error: ${messageOf(error)}`;
      })
      .finally(() => {
        testButton.disabled = false;
      });
  });
  byId('auto-key-delete').addEventListener('click', () => {
    const ref = select('auto-model').value;
    api
      .deleteKey(parseModelRef(ref).provider)
      .then(async () => {
        status.className = 'note';
        status.textContent = 'Clave borrada. El orden automático queda en pausa hasta que guardes otra.';
        await show();
      })
      .catch(fail);
  });

  /** @param {unknown} error */
  function fail(error) {
    status.className = 'error';
    status.textContent = `Error: ${messageOf(error)}`;
  }

  byId('auto-save').addEventListener('click', () => {
    const ref = select('auto-model').value;
    const wantsOn = input('auto-enabled').checked;
    const typedMax = parseMaxCalls(input('auto-max-calls').value);
    if (!typedMax.ok) {
      byId('auto-max-error').textContent = typedMax.message;
      input('auto-max-calls').focus();
      return;
    }
    const wanted = api.permissionsFor(ref);
    const providerId = parseModelRef(ref).provider;
    const typedKey = input('auto-key').value.trim();
    const consentWanted = input('auto-consent').checked;
    // Read everything now: the page may be gone by the time the dialog answers.
    const typed = {
      ref,
      maxCallsPerDay: typedMax.value,
      confirmBeforeMove: input('auto-confirm').checked,
      contextMode: select('auto-context').value,
      excludedFolderIds: [...byId('auto-excluded').querySelectorAll('input:checked')].map((box) => /** @type {HTMLInputElement} */ (box).value),
      consentAccepted: consentWanted,
    };
    // Both writes start in this turn, side by side: neither waits for the other or for the dialog.
    const persist = async () => {
      await Promise.all([typedKey ? api.saveKey(providerId, typedKey) : null, api.saveSettings(typed)]);
    };
    runSave({
      wantsOn,
      request: () => chrome.permissions.request(wanted),
      persist,
      finalize: async (granted) => {
        input('auto-key').value = '';
        const view = await api.readProviderView(ref);
        /** @type {string[]} */
        const missing = [];
        if (!view.keyHint) missing.push('la clave');
        if (view.needsConsent && !view.consented) missing.push('aceptar la política de datos');
        if (wantsOn && !granted) missing.push('los permisos que Chrome pidió');
        if (view.provider.adapter === 'anthropic-sdk') missing.push('un proveedor disponible');
        const enabled = wantsOn && missing.length === 0;
        await api.saveSettings({ enabled });
        settings.enabled = enabled;
        status.className = 'note';
        status.textContent = saveMessage({ wantsOn, enabled, missing, model: parseModelRef(ref).model ?? ref, confirm: typed.confirmBeforeMove });
        await show();
      },
    }).catch(fail);
  });

  return { refresh: showState, hostPermissionFor };
}
