/**
 * Pure presentation logic of the popup and the settings page: what to show, in which words, with
 * which actions. No DOM and no `chrome.*`, so each decision is tested on its own. Numbers, dates
 * and plurals are in Latin American Spanish (es-419).
 *
 * @typedef {{state: string, exclusionWarnings?: {path: string, status: string}[], reason?: string, provider?: string, model?: string, usage?: {calls: number, max: number, spentUsd?: number, capUsd?: number}, errorMessage?: string, action?: string}} Status
 * @typedef {{at: string, kind: string, title: string, host?: string, folder?: string, newFolder?: boolean, reason?: string, messageEs?: string, detail?: string, truncation?: {sent: number, total: number}, message?: string, changeId?: string, bookmarkId?: string, actions?: string[]}} ActivityEntry
 * @typedef {{id: string, kind: string, createdAt: string, bookmark: {id: string, title: string, host?: string}, folder?: {id: string, name: string}, newFolder?: {name: string, parentTitle?: string, parentId?: string, description?: string}, together?: {id: string, title: string, host?: string}[]}} ProposalLike
 */

const LOCALE = 'es-419';

/** @param {number} count @param {string} one @param {string} other */
export const plural = (count, one, other) => `${formatInt(count)} ${count === 1 ? one : other}`;

/** @param {number} value */
export const formatInt = (value) => new Intl.NumberFormat(LOCALE).format(value);

/** @param {number} usd */
export const formatMoney = (usd) =>
  `US$${new Intl.NumberFormat(LOCALE, { minimumFractionDigits: usd < 1 ? 4 : 2, maximumFractionDigits: usd < 1 ? 4 : 2 }).format(usd)}`;

/**
 * "hoy 19:47" for the same calendar day, "ayer 19:47", else "5 nov, 19:47".
 *
 * @param {string} iso
 * @param {Date} now
 */
export function formatWhen(iso, now) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  const day = (/** @type {Date} */ date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const gap = Math.round((day(now) - day(at)) / 86_400_000);
  if (gap === 0) return `hoy ${time}`;
  if (gap === 1) return `ayer ${time}`;
  return `${new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' }).format(at).replace('.', '')}, ${time}`;
}

/** Why a bookmark was left where it is, for the activity rows; the sort lane may send its own `messageEs`. */
const LEFT_REASONS = {
  'no-permission': 'falta un permiso de Chrome',
  'unknown-model': 'el modelo elegido no está disponible',
  'provider-pending': 'ese proveedor aún no funciona',
  'no-key': 'no hay clave guardada',
  'no-consent': 'falta aceptar la política de datos',
  gone: 'lo borraste antes de clasificarlo',
  'chosen-by-person': 'elegiste la carpeta tú',
  'saved-in-folder': 'lo guardaste en una carpeta: se respeta tu elección',
  'private-host': 'es un host privado: no se envía',
  'unsupported-scheme': 'no es una página web',
  'invalid-url': 'su URL no se puede enviar',
  'no-folders': 'no hay carpetas donde ubicarlo',
  'daily-calls': 'se alcanzó el tope diario de llamadas',
  'daily-budget': 'se alcanzó el tope diario de gasto',
  refused: 'el modelo se negó a clasificarlo',
  truncated: 'la respuesta llegó cortada',
  'invalid-answer': 'la respuesta no fue válida',
  'no-topic': 'no tiene un tema claro',
  'low-confidence': 'la IA no estaba segura',
  'already-there': 'ya estaba en la carpeta indicada',
  duplicate: 'ya lo tenías guardado',
  discarded: 'lo dejaste como estaba',
  expired: 'la propuesta caducó',
  'excluded-folder': 'está en una carpeta excluida',
  timeout: 'la IA tardó demasiado',
  error: 'falló la llamada',
};

/** Reasons for which asking the IA again would only repeat the answer. */
const NO_RETRY = new Set(['no-topic', 'low-confidence', 'saved-in-folder', 'private-host', 'unsupported-scheme', 'invalid-url', 'excluded-folder', 'already-there', 'duplicate', 'no-folders', 'chosen-by-person', 'discarded', 'expired', 'gone']);

/** Why the sort is not working, in words, with the one action that fixes it. */
const PAUSE_REASONS = {
  'no-permission': { text: 'falta un permiso de Chrome', action: 'repair-permission' },
  'no-key': { text: 'no hay clave guardada', action: 'open-settings' },
  'no-consent': { text: 'falta aceptar la política de datos', action: 'open-settings' },
  'daily-calls': { text: 'se alcanzó el tope diario de llamadas; sigue mañana', action: undefined },
  'daily-budget': { text: 'se alcanzó el tope diario de gasto; sigue mañana', action: undefined },
  'provider-pending': { text: 'ese proveedor aún no funciona', action: 'open-settings' },
  'unknown-model': { text: 'el modelo elegido ya no está disponible', action: 'open-settings' },
  error: { text: 'la última llamada falló', action: 'open-settings' },
};

/**
 * The status line at the top of the popup.
 *
 * @param {Status | null} status
 * @returns {{tone: 'ok' | 'warn' | 'error' | 'off', text: string, action?: 'open-settings' | 'repair-permission', actionLabel?: string}}
 */
export function statusView(status) {
  if (!status || status.state === 'off') return { tone: 'off', text: 'Orden automático apagado', action: 'open-settings', actionLabel: 'Activar' };
  const model = status.model ? ` · ${status.model}` : '';
  const usage = status.usage ? ` · ${formatInt(status.usage.calls)}/${formatInt(status.usage.max)} hoy` : '';
  if (status.state === 'paused') {
    const known = PAUSE_REASONS[/** @type {keyof typeof PAUSE_REASONS} */ (status.reason ?? 'error')] ?? PAUSE_REASONS.error;
    const action = /** @type {'open-settings' | 'repair-permission' | undefined} */ (status.action ?? known.action);
    const tone = status.reason === 'daily-calls' || status.reason === 'daily-budget' ? 'warn' : 'error';
    // The Repair button asks for the permission itself: the lane's «abre Ajustes» wording would contradict it.
    const ownText = action === 'repair-permission' || !status.errorMessage;
    const detail = ownText ? `: ${known.text}` : `: ${status.errorMessage?.charAt(0).toLowerCase()}${status.errorMessage?.slice(1)}`;
    return { tone, text: `Pausado${detail}`, action, actionLabel: action === 'repair-permission' ? 'Reparar' : action ? 'Ajustes' : undefined };
  }
  const mode = status.state === 'confirm' ? 'Orden con confirmación' : 'Orden automático activo';
  if ((status.exclusionWarnings ?? []).length > 0) {
    return { tone: 'warn', text: `${mode}${model}${usage} · Una carpeta excluida cambió: revísala en Ajustes.`, action: 'open-settings', actionLabel: 'Ajustes' };
  }
  return { tone: 'ok', text: `${mode}${model}${usage}` };
}

/**
 * One row of "Actividad reciente".
 *
 * @param {ActivityEntry} entry
 * @param {Date} now
 * @returns {{icon: string, tone: 'ok' | 'neutral' | 'error' | 'pending', when: string, text: string, note: string | null, detail: string | null, actions: {id: string, label: string}[]}}
 */
export function activityView(entry, now) {
  const title = entry.title || '(sin título)';
  const host = entry.host ? ` (${entry.host})` : '';
  const where = entry.folder ? ` → ${entry.folder}${entry.newFolder ? ' (carpeta nueva)' : ''}` : '';
  const why = entry.messageEs ?? (entry.reason ? (LEFT_REASONS[/** @type {keyof typeof LEFT_REASONS} */ (entry.reason)] ?? entry.reason) : undefined);
  /** @type {Record<string, [string, 'ok' | 'neutral' | 'error' | 'pending']>} */
  const kinds = { moved: ['✓', 'ok'], proposed: ['…', 'pending'], left: ['–', 'neutral'], error: ['✗', 'error'], expired: ['–', 'neutral'], duplicate: ['=', 'neutral'], sorted: ['≡', 'pending'] };
  const [icon, tone] = kinds[entry.kind] ?? ['–', 'neutral'];
  const text = entry.kind === 'expired' ? `${title}: la propuesta caducó` : entry.kind === 'duplicate' ? `${title}${host}: ya lo tenías${entry.folder ? ` en «${entry.folder}»` : ''}` : entry.kind === 'moved' ? `${title}${where}` : entry.kind === 'proposed' ? `${title}${where}: espera tu respuesta` : `${title}${host}${where}${why ? `: ${why}` : ''}`;
  /** @type {Record<string, string>} */
  const labels = { undo: 'Deshacer', 'choose-folder': 'Elegir carpeta', retry: 'Reintentar', 'remove-duplicate': 'Quitar el duplicado nuevo' };
  const repeats = entry.kind === 'left' && NO_RETRY.has(entry.reason ?? '');
  const actions = (entry.actions ?? [])
    .filter((id) => id in labels)
    // Retrying a "no clear topic" asks the same question again; a proposal has its own card with a folder picker.
    .filter((id) => !(id === 'retry' && repeats))
    .filter((id) => !(id === 'choose-folder' && (entry.kind === 'proposed' || entry.kind === 'duplicate')))
    .map((id) => ({ id, label: labels[id] }));
  // `messageEs` of an error row already ends with this sentence; other rows show it apart.
  const note = entry.truncation && !(entry.messageEs ?? '').includes('Se enviaron') ? `Contexto recortado: se enviaron ${formatInt(entry.truncation.sent)} de ${formatInt(entry.truncation.total)} carpetas.` : null;
  return { icon, tone, when: formatWhen(entry.at, now), text, note, detail: entry.detail ?? null, actions };
}

/**
 * The strip that keeps the outcome of the last action until the next one.
 *
 * @param {{moved: number, skipped?: {title?: string, id?: string, reason?: string}[], stale?: boolean, createdFolder?: string, reusedFolder?: string, changeId?: string | null}} result
 * @returns {{tone: 'ok' | 'warn', text: string, changeId: string | null}}
 */
export function resultView(result) {
  if (result.stale) return { tone: 'warn', text: 'El marcador ya no estaba donde lo dejó Ctrl+D: la propuesta se descartó.', changeId: null };
  const created = result.createdFolder ? `Carpeta «${result.createdFolder}» creada. ` : result.reusedFolder ? `Se usó la carpeta «${result.reusedFolder}», que ya existía. ` : '';
  const skipped = result.skipped ?? [];
  const omitted = skipped.length > 0 ? ` ${plural(skipped.length, 'omitido', 'omitidos')}: ${skipped.map((entry) => `«${entry.title || entry.id}»`).join(', ')}.` : '';
  const moved = result.moved === 0 ? 'No se movió nada.' : `${plural(result.moved, 'marcador movido', 'marcadores movidos')}.`;
  return { tone: result.moved === 0 ? 'warn' : 'ok', text: `${created}${moved}${omitted}`, changeId: result.moved > 0 ? (result.changeId ?? null) : null };
}

/** @param {string} name */
const groupKey = (name) => name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Cards for the pending proposals: `create` ones with the same folder name sit together, so one
 * click accepts them all. Newest first.
 *
 * @template {ProposalLike} T
 * @param {T[]} proposals
 * @returns {{key: string, name: string, proposals: T[], acceptAllLabel: string | null}[]}
 */
export function groupProposals(proposals) {
  /** @type {Map<string, {key: string, name: string, proposals: T[], acceptAllLabel: string | null}>} */
  const groups = new Map();
  const ordered = [...proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const proposal of ordered) {
    const name = proposal.kind === 'create' ? (proposal.newFolder?.name ?? '') : '';
    const key = proposal.kind === 'create' ? `create:${groupKey(name)}` : `move:${proposal.id}`;
    const group = groups.get(key) ?? { key, name, proposals: [], acceptAllLabel: null };
    group.proposals.push(proposal);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    // The oldest proposal's spelling names the folder: it is the one the person saw first.
    if (group.proposals.length > 1) group.name = group.proposals.at(-1)?.newFolder?.name ?? group.name;
  }
  for (const group of groups.values()) if (group.proposals.length > 1) group.acceptAllLabel = `Aceptar las ${group.proposals.length} de «${group.name}»`;
  return [...groups.values()];
}

/**
 * Sanitizes the folder name typed in a proposal card: trimmed, one line, not empty.
 *
 * @param {string} typed
 * @param {string} fallback
 * @param {number} [max]
 */
export function cleanFolderName(typed, fallback, max = 40) {
  const name = typed.replace(/\s+/gu, ' ').trim().slice(0, max).trim();
  return name === '' ? fallback : name;
}

/**
 * The weekly line. "Ubicados" counts every bookmark filed in a folder this week, by any route;
 * the rest says how.
 *
 * @param {{week?: string, filed?: number, moved: number, accepted: number, discarded: number, undone: number, undoneBookmarks?: number, corrected?: number, expired?: number, looseInBar?: number, looseFiled?: number} | null} metrics
 */
export function metricsLine(metrics) {
  if (!metrics) return null;
  const filed = metrics.filed ?? metrics.moved;
  /** @type {string[]} */
  const how = [];
  if (metrics.moved > 0) how.push(plural(metrics.moved, 'automático', 'automáticos'));
  if (metrics.accepted > 0) how.push(plural(metrics.accepted, 'propuesta aceptada', 'propuestas aceptadas'));
  if ((metrics.corrected ?? 0) > 0) how.push(plural(metrics.corrected ?? 0, 'corregido por ti', 'corregidos por ti'));
  const detail = how.length > 0 ? ` (${how.join(', ')})` : '';
  /** @type {string[]} */
  const rest = [];
  if ((metrics.undoneBookmarks ?? 0) > 0) rest.push(`${plural(metrics.undoneBookmarks ?? 0, 'devuelto', 'devueltos')} con Deshacer`);
  if (metrics.discarded > 0) rest.push(plural(metrics.discarded, 'propuesta descartada', 'propuestas descartadas'));
  const sorted = (metrics.looseFiled ?? 0) > 0 ? ` Con «Ordenar sueltos»: ${plural(metrics.looseFiled ?? 0, 'marcador ubicado', 'marcadores ubicados')}.` : '';
  const loose = `${sorted}${metrics.looseInBar === undefined ? '' : ` Sueltos en la barra: ${formatInt(metrics.looseInBar)}.`}`;
  return `Esta semana: ${plural(filed, 'marcador ubicado', 'marcadores ubicados')}${detail}${rest.length > 0 ? `; ${rest.join(', ')}` : ''}.${loose}`;
}

/**
 * @param {string | null} lastBackupAt ISO or null if never
 * @param {Date} now
 * @param {number} [staleDays]
 */
export function backupReminder(lastBackupAt, now, staleDays = 14) {
  if (!lastBackupAt) return { stale: true, text: 'Todavía no has hecho un respaldo.' };
  const days = Math.floor((now.getTime() - new Date(lastBackupAt).getTime()) / 86_400_000);
  if (!(days >= 0)) return { stale: false, text: 'Respaldo reciente.' };
  const text = days === 0 ? 'Último respaldo: hoy.' : `Último respaldo: hace ${plural(days, 'día', 'días')}.`;
  return { stale: days >= staleDays, text };
}

/**
 * The usage sentence of the settings page.
 *
 * @param {{calls: number, max: number, spentUsd?: number, capUsd?: number}} usage
 * @param {boolean} capped
 */
export function usageLine(usage, capped) {
  const money = usage.spentUsd === undefined || usage.capUsd === undefined ? '' : `, ${formatMoney(usage.spentUsd)} de ${formatMoney(usage.capUsd)} calculado a tarifa de pago`;
  return `Hoy: ${formatInt(usage.calls)} de ${formatInt(usage.max)} llamadas${money}.${capped ? ' Tope alcanzado: no clasifica hasta mañana.' : ''}`;
}

/**
 * Validates the daily call cap typed in the settings page.
 *
 * @param {string} typed
 * @param {number} max
 * @returns {{ok: true, value: number} | {ok: false, message: string}}
 */
export function parseMaxCalls(typed, max = 1000) {
  const text = typed.trim();
  const value = Number(text);
  if (text === '' || !Number.isInteger(value) || value < 1 || value > max) return { ok: false, message: `El tope diario debe ser un entero entre 1 y ${formatInt(max)}.` };
  return { ok: true, value };
}

/**
 * What the Save button decided, as one sentence. `model` is the model id, not the stored reference.
 *
 * @param {{wantsOn: boolean, enabled: boolean, missing: string[], model: string, confirm?: boolean}} outcome
 */
export function saveMessage({ wantsOn, enabled, missing, model, confirm = true }) {
  if (enabled) return `Guardado. Orden automático activado con ${model}: ${confirm ? 'te pide confirmar antes de mover' : 'mueve sin preguntar cuando la IA está segura'}.`;
  if (wantsOn) return `Guardado, pero sigue apagado: falta ${missing.join(', ')}.`;
  return 'Guardado. Orden automático apagado.';
}

/**
 * Folders for a <select>: "Barra de marcadores / DBT / dbt-core", skipping roots and managed ones.
 *
 * @param {{id: string, title: string, url?: string, children?: any[], folderType?: string, unmodifiable?: string}[]} tree
 * @param {number} [limit]
 * @returns {{id: string, path: string, depth: number}[]}
 */
export function folderOptions(tree, limit = 500) {
  /** @type {{id: string, path: string, depth: number}[]} */
  const out = [];
  /** @param {any} node @param {string[]} trail */
  const visit = (node, trail) => {
    if (out.length >= limit) return;
    for (const child of node.children ?? []) {
      if (child.url !== undefined || child.unmodifiable === 'managed') continue;
      const path = [...trail, child.title || '(sin nombre)'];
      out.push({ id: child.id, path: path.join(' / '), depth: path.length - 1 });
      visit(child, path);
    }
  };
  for (const root of tree) for (const top of root.children ?? []) {
    if (top.unmodifiable === 'managed') continue;
    out.push({ id: top.id, path: top.title, depth: 0 });
    visit(top, [top.title]);
  }
  return out.slice(0, limit);
}

/**
 * The question on a `move` proposal's card. The reason says why it is a proposal: the IA was
 * sure and "Confirmar antes de mover" is on, or the IA doubted.
 *
 * @param {{reason?: string, confidence?: string, folder?: {name: string}}} proposal
 */
export function moveQuestion(proposal) {
  const name = proposal.folder?.name ?? '';
  const doubt = proposal.reason === 'low-confidence' || (proposal.reason === undefined && proposal.confidence === 'low');
  return doubt ? `La IA no estaba segura: ¿mover a «${name}»?` : `¿Mover a «${name}»?`;
}

/**
 * The persisted outcome of the last action, as the strip shows it.
 *
 * @param {{messageEs: string, changeId?: string, undoable?: boolean, kind?: string} | null} last
 * @returns {{tone: 'ok' | 'warn', text: string, changeId: string | null} | null}
 */
export function lastResultView(last) {
  if (!last) return null;
  return { tone: 'ok', text: last.messageEs, changeId: last.undoable && last.changeId ? last.changeId : null };
}

/**
 * "Ver qué se envió": what left in the last call, as lines of plain text. Titles and hosts only.
 *
 * @param {{at?: string, folders?: number, examples?: number, loose?: number, truncatedFolders?: number, sent?: {bookmark: {title: string, host: string}, folders: {name: string, examples: string[]}[], loose: {title: string, host: string}[]}} | null} preview
 * @returns {{summary: string, lines: string[]} | null}
 */
export function sentView(preview) {
  if (!preview) return null;
  const sent = preview.sent;
  const folders = sent?.folders.length ?? preview.folders ?? 0;
  const examples = sent ? sent.folders.reduce((sum, folder) => sum + folder.examples.length, 0) : (preview.examples ?? 0);
  const loose = sent?.loose.length ?? preview.loose ?? 0;
  const cut = (preview.truncatedFolders ?? 0) > 0 ? ` (${plural(preview.truncatedFolders ?? 0, 'carpeta no cupo', 'carpetas no cupieron')})` : '';
  const summary = `Lo último que se envió: el marcador, ${plural(folders, 'carpeta', 'carpetas')}, ${plural(examples, 'ejemplo', 'ejemplos')} y ${plural(loose, 'suelto', 'sueltos')}${cut}. Sin URL completas ni clave.`;
  if (!sent) return { summary, lines: [] };
  /** @type {string[]} */
  const lines = [`Marcador: ${sent.bookmark.title || '(sin título)'} · ${sent.bookmark.host}`];
  for (const folder of sent.folders) lines.push(`Carpeta «${folder.name}»${folder.examples.length > 0 ? `: ${folder.examples.join('; ')}` : ''}`);
  for (const item of sent.loose) lines.push(`Suelto: ${item.title || '(sin título)'} · ${item.host}`);
  return { summary, lines };
}

/**
 * The sentence after «Probar la clave».
 *
 * @param {{ok: boolean, messageEs: string, ms?: number, servedModel?: string}} result
 */
export function testResultText(result) {
  const extra = result.ok ? ` (${result.servedModel ? `${result.servedModel}, ` : ''}${formatInt(result.ms ?? 0)} ms)` : '';
  return `${result.ok ? 'La clave funciona.' : result.messageEs}${extra} Esta prueba cuenta en el tope diario.`;
}

/**
 * The confirmation of «Ordenar sueltos»: exactly what will leave, where to, what stays out and
 * why. It is the consent for this action, so it names everything that goes.
 *
 * @param {{
 *   folder: {title: string} | null, providerName: string, model: string, sendable: number,
 *   omitted: {title: string, host: string, reasonEs: string}[], folderNames: number, foldersLeftOut?: number, calls: number,
 *   callsLeft: number, batches: number, blocked: {messageEs: string} | null,
 * }} preview
 * @returns {{ok: boolean, lines: string[], omitted: string[], confirmLabel: string}}
 */
export function sortPreviewView(preview) {
  const omitted = preview.omitted.map((item) => `«${item.title || '(sin título)'}»${item.host ? ` · ${item.host}` : ''}: ${item.reasonEs}`);
  if (preview.blocked) return { ok: false, lines: [preview.blocked.messageEs], omitted, confirmLabel: '' };
  const where = preview.folder ? ` de «${preview.folder.title}»` : '';
  const batches = preview.batches > 1 ? ` (${formatInt(preview.batches)} lotes de hasta 50)` : '';
  const short = preview.callsLeft < preview.calls ? ' El tope diario puede cortarlo a medias.' : '';
  return {
    ok: true,
    lines: [
      `Se enviarán a ${preview.providerName} (${preview.model}) los títulos limpios y las URL reducidas de ${plural(preview.sendable, 'marcador suelto', 'marcadores sueltos')}${where}, con los nombres de tus ${plural(preview.folderNames, 'carpeta', 'carpetas')}.${(preview.foldersLeftOut ?? 0) > 0 ? ` Quedan fuera ${plural(preview.foldersLeftOut ?? 0, 'carpeta', 'carpetas')} (pasan el tope de 100 o su ruta es muy larga): no se ofrecen como destino.` : ''}`,
      `Hará unas ${plural(preview.calls, 'llamada', 'llamadas')}${batches}; te quedan ${formatInt(preview.callsLeft)} hoy.${short}`,
      omitted.length > 0 ? `${omitted.length === 1 ? 'No se envía' : 'No se envían'} ${plural(omitted.length, 'marcador', 'marcadores')}:` : 'No se deja fuera ninguno.',
      'Después revisas las propuestas: nada se mueve sin tu confirmación.',
    ],
    omitted,
    confirmLabel: `Enviar ${formatInt(preview.sendable)} y proponer`,
  };
}
