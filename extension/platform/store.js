/**
 * Journal and snapshots in `chrome.storage.local`. The `unlimitedStorage` permission lifts its
 * 10 MB quota ("This value will be ignored if the extension has the unlimitedStorage
 * permission", https://developer.chrome.com/docs/extensions/reference/api/storage). The data is
 * "cleared when the extension is removed": the downloaded files are the copy that survives.
 *
 * Keys:
 *   `journal`               headers of the applied changes, oldest first, at most KEEP_CHANGES
 *   `change:<id>`           the body of one change: `origins`, `planned`, `skipped`, `undo`
 *   `change:<id>:m<k>`      its moves, in chunks of CHUNK_SIZE, each chunk written once it is full
 *   `snapshots`             keys of the snapshots, oldest first; `snapshotKinds` maps key to kind
 *   `snapshot:<createdAt>:<n>`  one `backup@1` object each, written in a single `set`
 *
 * Why this layout: the 0.3.0 journal was one array rewritten whole after every move, which costs
 * O(n^2) bytes for n moves. Here a move is written once, in a chunk, and the small headers are
 * rewritten only when a change opens, closes, is undone, and every FLUSH_EVERY moves.
 *
 * Every operation that reads and then writes takes the `journal` lock (`withLock`), so the worker
 * and the pages of the extension cannot lose each other's update. The lock is not reentrant:
 * nothing in this file calls another locked operation while holding it.
 *
 * A change does not need a snapshot to be undone: it carries the order of its origin folders.
 * A change from 0.3.0 (one object with its moves inline, no `v`) is converted on first touch.
 *
 * @typedef {import('../core/backup.js').Backup} Backup
 * @typedef {import('../core/plan.js').JournalMove} JournalMove
 * @typedef {import('../core/plan.js').Move} Move
 * @typedef {{id: string, title?: string, reason: string, message?: string}} Skipped
 * @typedef {{at: string, restored: string[], skipped: Skipped[], removedFolders: string[], keptFolders: {id: string, items: number}[]}} UndoRecord
 * @typedef {{
 *   v: 2,
 *   id: string,
 *   kind: string,
 *   label: string,
 *   createdAt: string,
 *   finishedAt: string | null,
 *   touchedAt: string,
 *   status: 'running' | 'done' | 'interrupted',
 *   planned: number,
 *   done: number,
 *   skipped: number,
 *   createdFolders: string[],
 *   snapshotKey: string | null,
 *   chunks: number,
 *   undone: boolean,
 *   undoAt: string | null,
 *   undoing: string | null,
 *   undoable: boolean,
 * }} ChangeHeader
 *   `undoing`: when a Deshacer claimed it, until it ends (or expires). `undoable`: derived.
 * @typedef {Omit<ChangeHeader, 'skipped'> & {
 *   skippedCount: number,
 *   origins: Record<string, string[]>,
 *   moves: JournalMove[],
 *   skipped: Skipped[],
 *   plan: Move[],
 *   undo: UndoRecord | null,
 * }} Change
 *   what `getChange` returns: the header (with `skippedCount`) and the body. In a header
 *   `skipped` is a count; here it is the list.
 * @typedef {{request(name: string, options: {mode: 'exclusive'}, callback: () => Promise<any>): Promise<any>}} LockManager
 * @typedef {{
 *   saveSnapshot(backup: Backup, options?: {kind?: SnapshotKind}): Promise<string>,
 *   readSnapshot(key: string): Promise<Backup | null>,
 *   listSnapshots(): Promise<string[]>,
 *   beginChange(details: {kind?: string, label?: string, createdAt: string, origins: Record<string, string[]>, plan: Move[], createdFolders?: string[], snapshotKey?: string | null}): Promise<string>,
 *   appendMoves(id: string, moves: JournalMove[], at: string): Promise<void>,
 *   endChange(id: string, details: {skipped: Skipped[], finishedAt: string, status?: 'done' | 'interrupted'}): Promise<void>,
 *   removeChange(id: string): Promise<void>,
 *   claimUndo(id: string, at: string): Promise<boolean>,
 *   finishUndo(id: string, undo: UndoRecord | null): Promise<void>,
 *   listChanges(n?: number): Promise<(ChangeHeader & {undo: {at: string} | null})[]>,
 *   getChange(id: string): Promise<Change | null>,
 *   lastChange(): Promise<Change | null>,
 *   readJournal(): Promise<Change[]>,
 *   reconcileChange(id: string, moves: JournalMove[], finishedAt: string): Promise<void>,
 *   sweepOrphans(): Promise<number>,
 * }} Store
 * @typedef {'manual' | 'bulk'} SnapshotKind
 */

/** Snapshots kept per kind: a bulk one must outlive the ordinary traffic of Ctrl+D. */
export const KEEP_SNAPSHOTS = 3;
export const KEEP_CHANGES = 20;
export const CHUNK_SIZE = 200;
/** How many moves `applyPlan` buffers before it writes them. */
export const FLUSH_EVERY = 25;
/** A claim to undo, or a running change, older than this is taken as abandoned. */
export const STALE_MS = 60_000;

const SNAPSHOTS_KEY = 'snapshots';
const SNAPSHOT_KINDS_KEY = 'snapshotKinds';
const JOURNAL_KEY = 'journal';
const bodyKey = (/** @type {string} */ id) => id;
const chunkKey = (/** @type {string} */ id, /** @type {number} */ k) => `${id}:m${k}`;

/** @type {Map<string, Promise<unknown>>} the fallback queues, one per lock name */
const queues = new Map();

/**
 * Runs `task` holding the exclusive lock `name`. Between the service worker and the extension's
 * pages it is `navigator.locks`; where that does not exist (Node), a queue per name inside the
 * process. Not reentrant: a task must not ask for the lock it holds.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} task
 * @param {{locks?: LockManager | null}} [options]
 *   `locks`: replaces `navigator.locks`, for tests
 * @returns {Promise<T>}
 */
export function withLock(name, task, options = {}) {
  const locks = options.locks === undefined ? /** @type {any} */ (globalThis.navigator)?.locks : options.locks;
  if (locks && typeof locks.request === 'function') return locks.request(`bookmark-genie:${name}`, { mode: 'exclusive' }, task);
  const previous = queues.get(name) ?? Promise.resolve();
  const run = previous.then(task, task);
  queues.set(
    name,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {chrome.storage.StorageArea} [area]
 * @param {{locks?: LockManager | null}} [options]
 * @returns {Store}
 */
export function createStore(area = chrome.storage.local, options = {}) {
  /** @template T @param {() => Promise<T>} task */
  const locked = (task) => withLock('journal', task, options);

  /** @param {string} key */
  const readList = async (key) => {
    const value = (await area.get(key))[key];
    return Array.isArray(value) ? value : [];
  };

  /** @returns {Promise<any[]>} */
  const readHeaders = () => readList(JOURNAL_KEY);

  /**
   * Converts the 0.3.0 entries (a whole change in one object) to headers, bodies and chunks.
   * Idempotent: an entry with `v: 2` is left alone. Call it holding the lock.
   *
   * @returns {Promise<ChangeHeader[]>}
   */
  const headersMigrated = async () => {
    const entries = await readHeaders();
    if (entries.every((entry) => isObject(entry) && entry.v === 2)) return entries;
    /** @type {Record<string, unknown>} */
    const writes = {};
    /** @type {ChangeHeader[]} */
    const headers = [];
    for (const entry of entries) {
      if (!isObject(entry)) continue;
      if (entry.v === 2) {
        headers.push(/** @type {ChangeHeader} */ (/** @type {unknown} */ (entry)));
        continue;
      }
      const old = /** @type {any} */ (entry);
      const id = String(old.id);
      const moves = Array.isArray(old.moves) ? old.moves : [];
      const skipped = Array.isArray(old.skipped) ? old.skipped : [];
      const chunks = Math.ceil(moves.length / CHUNK_SIZE);
      for (let k = 0; k < chunks; k += 1) writes[chunkKey(id, k)] = moves.slice(k * CHUNK_SIZE, (k + 1) * CHUNK_SIZE);
      const createdAt = String(old.createdAt ?? '');
      /** @type {ChangeHeader} */
      const header = {
        v: 2,
        id,
        kind: 'sort',
        label: '',
        createdAt,
        finishedAt: typeof old.finishedAt === 'string' ? old.finishedAt : null,
        touchedAt: createdAt,
        status: typeof old.finishedAt === 'string' ? 'done' : 'interrupted',
        planned: moves.length + skipped.length,
        done: moves.length,
        skipped: skipped.length,
        createdFolders: Array.isArray(old.createdFolders) ? old.createdFolders : [],
        snapshotKey: typeof old.snapshotKey === 'string' ? old.snapshotKey : null,
        chunks,
        undone: Boolean(old.undo),
        undoAt: old.undo?.at ?? null,
        undoing: null,
        undoable: !old.undo && moves.length > 0,
      };
      writes[bodyKey(id)] = { origins: isObject(old.origins) ? old.origins : {}, planned: [], skipped, undo: old.undo ?? null };
      headers.push(header);
    }
    await area.set({ ...writes, [JOURNAL_KEY]: headers });
    return headers;
  };

  /**
   * @param {ChangeHeader} header
   * @returns {Promise<Change>}
   */
  const assemble = async (header) => {
    const keys = [bodyKey(header.id), ...Array.from({ length: header.chunks }, (_, k) => chunkKey(header.id, k))];
    const stored = await area.get(keys);
    const body = /** @type {any} */ (stored[bodyKey(header.id)]) ?? {};
    /** @type {JournalMove[]} */
    const moves = [];
    for (let k = 0; k < header.chunks; k += 1) {
      const chunk = stored[chunkKey(header.id, k)];
      if (Array.isArray(chunk)) moves.push(...chunk);
    }
    return {
      ...header,
      skippedCount: header.skipped,
      origins: isObject(body.origins) ? body.origins : {},
      moves,
      skipped: Array.isArray(body.skipped) ? body.skipped : [],
      plan: Array.isArray(body.planned) ? body.planned : [],
      undo: body.undo ?? null,
    };
  };

  /** @param {string} id @param {number} chunks */
  const keysOf = (id, chunks) => [bodyKey(id), ...Array.from({ length: chunks }, (_, k) => chunkKey(id, k))];

  /**
   * Updates one header in the list. Call it holding the lock.
   *
   * @param {string} id
   * @param {(header: ChangeHeader) => void} edit
   * @param {Record<string, unknown>} [extra] more keys to write in the same `set`
   */
  const patchHeader = async (id, edit, extra = {}) => {
    const headers = await headersMigrated();
    const header = headers.find((entry) => entry.id === id);
    if (!header) return false;
    edit(header);
    header.undoable = !header.undone && header.done > 0;
    await area.set({ ...extra, [JOURNAL_KEY]: headers });
    return true;
  };

  /** @param {ChangeHeader[]} headers */
  const expireOld = async (headers) => {
    const dropped = headers.splice(0, Math.max(0, headers.length - KEEP_CHANGES));
    const keys = dropped.flatMap((header) => keysOf(header.id, header.chunks));
    if (keys.length > 0) await area.remove(keys);
  };

  /** @type {Store} */
  const store = {
    saveSnapshot(backup, { kind = 'manual' } = {}) {
      return locked(async () => {
        const keys = /** @type {string[]} */ (await readList(SNAPSHOTS_KEY));
        const kinds = /** @type {Record<string, SnapshotKind>} */ ((await area.get(SNAPSHOT_KINDS_KEY))[SNAPSHOT_KINDS_KEY] ?? {});
        let key = `snapshot:${backup.createdAt}:1`;
        for (let n = 2; keys.includes(key); n += 1) key = `snapshot:${backup.createdAt}:${n}`;
        keys.push(key);
        kinds[key] = kind;
        // Retention counts each kind apart: ordinary snapshots never push out a bulk one.
        /** @type {string[]} */
        const expired = [];
        const kept = [];
        const seen = { manual: 0, bulk: 0 };
        for (const candidate of keys.toReversed()) {
          const own = kinds[candidate] === 'bulk' ? 'bulk' : 'manual';
          seen[own] += 1;
          if (seen[own] > KEEP_SNAPSHOTS) expired.push(candidate);
          else kept.unshift(candidate);
        }
        for (const gone of expired) delete kinds[gone];
        await area.set({ [key]: backup, [SNAPSHOTS_KEY]: kept, [SNAPSHOT_KINDS_KEY]: kinds });
        if (expired.length > 0) await area.remove(expired);
        return key;
      });
    },

    async readSnapshot(key) {
      const value = (await area.get(key))[key];
      return value === undefined ? null : /** @type {Backup} */ (value);
    },

    listSnapshots() {
      return readList(SNAPSHOTS_KEY);
    },

    beginChange({ kind = 'sort', label = '', createdAt, origins, plan, createdFolders = [], snapshotKey = null }) {
      return locked(async () => {
        const headers = await headersMigrated();
        let id = `change:${createdAt}:1`;
        for (let n = 2; headers.some((header) => header.id === id); n += 1) id = `change:${createdAt}:${n}`;
        /** @type {ChangeHeader} */
        const header = {
          v: 2,
          id,
          kind,
          label,
          createdAt,
          finishedAt: null,
          touchedAt: createdAt,
          status: 'running',
          planned: plan.length,
          done: 0,
          skipped: 0,
          createdFolders,
          snapshotKey,
          chunks: 0,
          undone: false,
          undoAt: null,
          undoing: null,
          undoable: false,
        };
        headers.push(header);
        await expireOld(headers);
        // The intent goes first, in one write with the header: a worker that dies after this
        // can be reconciled against the real tree.
        await area.set({ [bodyKey(id)]: { origins, planned: plan, skipped: [], undo: null }, [JOURNAL_KEY]: headers });
        return id;
      });
    },

    appendMoves(id, moves, at) {
      return locked(async () => {
        if (moves.length === 0) return;
        const headers = await headersMigrated();
        const header = headers.find((entry) => entry.id === id);
        if (!header) return;
        /** @type {Record<string, unknown>} */
        const writes = {};
        let rest = moves;
        let k = Math.max(0, header.chunks - 1);
        if (header.chunks > 0) {
          const last = /** @type {JournalMove[]} */ ((await area.get(chunkKey(id, k)))[chunkKey(id, k)] ?? []);
          if (last.length < CHUNK_SIZE) {
            const room = CHUNK_SIZE - last.length;
            writes[chunkKey(id, k)] = [...last, ...rest.slice(0, room)];
            rest = rest.slice(room);
            k += 1;
          } else {
            k = header.chunks;
          }
        }
        while (rest.length > 0) {
          writes[chunkKey(id, k)] = rest.slice(0, CHUNK_SIZE);
          rest = rest.slice(CHUNK_SIZE);
          k += 1;
        }
        header.chunks = Math.max(header.chunks, k);
        header.done += moves.length;
        header.touchedAt = at;
        header.undoable = !header.undone && header.done > 0;
        await area.set({ ...writes, [JOURNAL_KEY]: headers });
      });
    },

    endChange(id, { skipped, finishedAt, status = 'done' }) {
      return locked(async () => {
        const headers = await headersMigrated();
        const header = headers.find((entry) => entry.id === id);
        if (!header) return;
        if (header.done === 0) {
          // Nothing moved: an empty change would only hide the real one before it.
          await area.set({ [JOURNAL_KEY]: headers.filter((entry) => entry.id !== id) });
          await area.remove(keysOf(id, header.chunks));
          return;
        }
        const body = /** @type {any} */ ((await area.get(bodyKey(id)))[bodyKey(id)] ?? {});
        header.status = status;
        header.finishedAt = finishedAt;
        header.touchedAt = finishedAt;
        header.skipped = skipped.length;
        header.undoable = !header.undone && header.done > 0;
        await area.set({ [bodyKey(id)]: { ...body, skipped }, [JOURNAL_KEY]: headers });
      });
    },

    removeChange(id) {
      return locked(async () => {
        const headers = await headersMigrated();
        const header = headers.find((entry) => entry.id === id);
        if (!header) return;
        await area.set({ [JOURNAL_KEY]: headers.filter((entry) => entry.id !== id) });
        await area.remove(keysOf(id, header.chunks));
      });
    },

    claimUndo(id, at) {
      return locked(async () => {
        let claimed = false;
        await patchHeader(id, (header) => {
          if (header.undone || header.done === 0) return;
          if (header.undoing && Date.parse(at) - Date.parse(header.undoing) < STALE_MS) return;
          header.undoing = at;
          claimed = true;
        });
        return claimed;
      });
    },

    finishUndo(id, undo) {
      return locked(async () => {
        const body = /** @type {any} */ ((await area.get(bodyKey(id)))[bodyKey(id)] ?? {});
        await patchHeader(
          id,
          (header) => {
            header.undoing = null;
            if (undo) {
              header.undone = true;
              header.undoAt = undo.at;
            }
          },
          undo ? { [bodyKey(id)]: { ...body, undo } } : {},
        );
      });
    },

    reconcileChange(id, moves, finishedAt) {
      return locked(async () => {
        const headers = await headersMigrated();
        const header = headers.find((entry) => entry.id === id);
        if (!header) return;
        if (moves.length === 0 && header.done === 0) {
          await area.set({ [JOURNAL_KEY]: headers.filter((entry) => entry.id !== id) });
          await area.remove(keysOf(id, header.chunks));
          return;
        }
        // Rewrite the chunks from scratch with every move now known.
        /** @type {Record<string, unknown>} */
        const writes = {};
        const chunks = Math.ceil(moves.length / CHUNK_SIZE);
        for (let k = 0; k < chunks; k += 1) writes[chunkKey(id, k)] = moves.slice(k * CHUNK_SIZE, (k + 1) * CHUNK_SIZE);
        const stale = [];
        for (let k = chunks; k < header.chunks; k += 1) stale.push(chunkKey(id, k));
        header.chunks = chunks;
        header.done = moves.length;
        header.status = 'interrupted';
        header.finishedAt = finishedAt;
        header.touchedAt = finishedAt;
        header.undoable = !header.undone && header.done > 0;
        await area.set({ ...writes, [JOURNAL_KEY]: headers });
        if (stale.length > 0) await area.remove(stale);
      });
    },

    listChanges(n = KEEP_CHANGES) {
      return locked(async () => {
        const headers = await headersMigrated();
        // `undo` mirrors what `getChange` returns, so code that reads a header as a change (`if
        // (change.undo)`) does not take an undone change for one still to undo.
        return headers
          .map((header) => ({ ...header, undoable: !header.undone && header.done > 0, undo: header.undone ? { at: /** @type {string} */ (header.undoAt) } : null }))
          .reverse()
          .slice(0, n);
      });
    },

    getChange(id) {
      return locked(async () => {
        const header = (await headersMigrated()).find((entry) => entry.id === id);
        return header ? assemble({ ...header, undoable: !header.undone && header.done > 0 }) : null;
      });
    },

    async lastChange() {
      const [latest] = (await store.listChanges(KEEP_CHANGES)).filter((header) => header.done > 0);
      return latest ? store.getChange(latest.id) : null;
    },

    readJournal() {
      return locked(async () => {
        const headers = await headersMigrated();
        return Promise.all(headers.map((header) => assemble({ ...header, undoable: !header.undone && header.done > 0 })));
      });
    },

    /** Removes `change:*` and `snapshot:*` keys no header or list refers to; returns how many. */
    sweepOrphans() {
      return locked(async () => {
        const headers = await headersMigrated();
        const live = new Set(headers.flatMap((header) => keysOf(header.id, header.chunks)));
        for (const key of await readList(SNAPSHOTS_KEY)) live.add(key);
        const orphans = Object.keys(await area.get(null)).filter((key) => (key.startsWith('change:') || key.startsWith('snapshot:')) && !live.has(key));
        if (orphans.length > 0) await area.remove(orphans);
        return orphans.length;
      });
    },
  };
  return store;
}
