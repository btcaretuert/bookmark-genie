/**
 * The order of the Save button in the settings page. Chrome's permission dialog can close the
 * page that asked for it, so what the person typed (key, consent, settings) is written in the
 * same turn as the request, never in its `.then`; "on" is written last, and only if granted.
 *
 * `request` runs first and synchronously, inside the click's user gesture: any `await` before
 * it would lose the gesture.
 *
 * @template T
 * @param {{
 *   wantsOn: boolean,
 *   request: () => Promise<boolean>,
 *   persist: () => Promise<void>,
 *   finalize: (granted: boolean) => Promise<T>,
 * }} steps
 * @returns {Promise<T>}
 */
export function runSave({ wantsOn, request, persist, finalize }) {
  const asking = wantsOn ? request() : Promise.resolve(true);
  const persisted = persist();
  return Promise.all([asking, persisted]).then(([granted]) => finalize(granted));
}
