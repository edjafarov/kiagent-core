/** Shared folders (phone phase 3): the Incoming and Sorted folders belong to
 *  the account. The leader lists them in `shared_files`; a copy mirrors them.
 *  This is the service shell and its API surface; the passes live beside it. */
import type { AppDb } from '../../db/app-db';
import { SyncReadOnly } from '../sync/role';
import type { SyncService } from '../sync/service';
import { scanRoot } from './leader-scan';
import { listSortable, reconcileAtPromotion } from './promote';
import { normalizeRel, toAbs, toRel, type SharedRoot } from './paths';
import { watchRoot, type RootWatcher } from './watch';

export type { SharedRoot } from './paths';

export type Roots = { incoming: string | null; sorted: string | null };
export type SharedRef = { accountId: string; externalId: string; root: SharedRoot; relPath: string };
export type OfferMeta = {
  root: SharedRoot;
  relPath: string;
  sha256: string;
  base: string | null;
  captureId: string | null;
};
export type OfferAnswer = 'same' | 'written' | 'kept-both' | 'have-it' | 'filled';
export type FileQuery = { root: SharedRoot; relPath: string; sha256: string };

/** The network, supplied by the app (remote-mcp). Core never opens a socket. */
export interface SharedTransport {
  /** Streams the leader's file into `dest` from `offset`. 'gone' when the leader no longer has that hash there. */
  fetch(q: FileQuery, dest: string, offset: number): Promise<'ok' | 'gone'>;
  offer(meta: OfferMeta, file: string): Promise<OfferAnswer>;
  remove(q: FileQuery): Promise<void>;
}

/** What the device is doing for the shared folders right now.
 *  `leader`: writable leader, including a lone Mac. `copy`: a follower.
 *  `idle`: neither (fenced, waiting for the lease): nothing is written. */
export type SharedMode = 'leader' | 'copy' | 'idle';

export interface SharedFoldersApi {
  setRoots(roots: Roots): Promise<void>;
  roots(): Roots;
  setTransport(t: SharedTransport | null): void;
  kick(): void;
  resolve(absPath: string): Promise<SharedRef | null>;
  pathOf(doc: { accountId: string; externalId: string }): Promise<string | null>;
  parked(absPath: string): Promise<boolean>;
  listForSorting(): Promise<string[]>;
  moved(fromAbs: string, toAbs: string): Promise<void>;
  registerCapture(captureId: string, sha256: string): Promise<void>;
  noteCapture(captureId: string, absPath: string, sha256: string): Promise<boolean>;
  fileOfCapture(
    captureId: string,
  ): Promise<{ ref: SharedRef; absPath: string | null; missingHere: boolean } | null>;
  serve: {
    open(q: FileQuery): Promise<{ path: string; bytes: number } | null>;
    stagingFile(root: SharedRoot): Promise<string>;
    offer(meta: OfferMeta, tmpFile: string, fromDeviceName: string): Promise<OfferAnswer>;
    remove(q: FileQuery): Promise<boolean>;
  };
}

export interface SharedFoldersDeps {
  db: AppDb;
  /** `onApplied` is the hook that says rows from the leader were applied. */
  sync: Pick<SyncService, 'readOnly' | 'role' | 'onRole' | 'onApplied'>;
  hashFile(abs: string): Promise<string>;
  /** Moves a file to the system Trash. The only way this module removes a user's file. */
  trash(abs: string): Promise<void>;
  now(): number;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
  /** One watcher for one root; every event is `onEvent()`. Defaults to chokidar. */
  watch?(rootAbs: string, onEvent: () => void): RootWatcher;
  /** How long a burst of file events is gathered before a pass. Default 750. */
  debounceMs?: number;
}

export interface SharedFolders extends SharedFoldersApi {
  mode(): SharedMode;
  /** Resolves when no pass is running or waiting. For tests and shutdown. */
  settled(): Promise<void>;
  /** Stops the watchers and timers. */
  close(): Promise<void>;
  /** Tells `cb` when the mode changes. Core-internal (the passes use it). */
  onMode(cb: (next: SharedMode, prev: SharedMode) => void): void;
}

export const ROOTS_META_KEY = 'shared-folders:roots';
/** Set while this device is, or was last, a copy: the next time it leads it
 *  reconciles first. Local, so it survives a restart between the two. */
export const RECONCILE_PENDING_KEY = 'shared-folders:reconcile-pending';
export const SHARED_SOURCE = 'shared-folder';

const isRoot = (s: string): s is SharedRoot => s === 'incoming' || s === 'sorted';
const notYet = (what: string) => (): never => {
  throw new Error(`shared-folders: ${what} is not built yet`);
};

async function loadRoots(db: AppDb): Promise<Roots> {
  const rows = await db.all(`SELECT value FROM meta WHERE key = ?`, [ROOTS_META_KEY]);
  const out: Roots = { incoming: null, sorted: null };
  try {
    const j = JSON.parse(String(rows[0]?.value ?? '{}')) as Partial<Roots>;
    if (typeof j.incoming === 'string') out.incoming = j.incoming;
    if (typeof j.sorted === 'string') out.sorted = j.sorted;
  } catch {
    // an unreadable note is the same as none
  }
  return out;
}

export async function createSharedFolders(deps: SharedFoldersDeps): Promise<SharedFolders> {
  let roots = await loadRoots(deps.db);
  let transport: SharedTransport | null = null;

  const mode = (): SharedMode => {
    const r = deps.sync.role();
    if (r.leader) return 'leader';
    return r.follower ? 'copy' : 'idle';
  };
  const modeListeners: ((next: SharedMode, prev: SharedMode) => void)[] = [];
  let lastMode = mode();
  let starting: Promise<void> = Promise.resolve();
  deps.sync.onRole(() => {
    const next = mode();
    if (next === lastMode) return;
    const prev = lastMode;
    lastMode = next;
    if (next === 'copy') void markPending().catch((err) => deps.log('warn', `${String(err)}`));
    for (const cb of modeListeners) cb(next, prev);
    starting = rewatch().then(kick);
  });

  const watchers: RootWatcher[] = [];
  const debounceMs = deps.debounceMs ?? 750;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let closed = false;

  let pending =
    (await deps.db.all(`SELECT 1 FROM meta WHERE key = ?`, [RECONCILE_PENDING_KEY])).length > 0;
  let pendingGen = 0;
  const markPending = async (): Promise<void> => {
    pendingGen += 1;
    pending = true;
    await deps.db.run(`INSERT OR IGNORE INTO meta(key, value) VALUES(?, '1')`, [RECONCILE_PENDING_KEY]);
  };
  let reconciling: Promise<void> | null = null;
  /** Runs the promotion reconcile if one is owed; every caller waits for the same run. */
  const reconcileIfPending = async (): Promise<void> => {
    if (!pending) return;
    reconciling ??= (async () => {
      const gen = pendingGen;
      await reconcileAtPromotion({ ...deps, roots });
      if (gen !== pendingGen) return; // became a copy again meanwhile: still owed
      pending = false;
      await deps.db.run(`DELETE FROM meta WHERE key = ?`, [RECONCILE_PENDING_KEY]);
    })().finally(() => {
      reconciling = null;
    });
    await reconciling;
  };

  const pass = async (): Promise<void> => {
    if (mode() !== 'leader') return;
    await reconcileIfPending();
    for (const root of ['incoming', 'sorted'] as const) {
      const base = roots[root];
      // eslint-disable-next-line no-await-in-loop
      if (base) await scanRoot(deps, root, base);
    }
  };
  const run = (): void => {
    if (running || closed) return;
    running = (async () => {
      do {
        again = false;
        try {
          // eslint-disable-next-line no-await-in-loop
          await pass();
        } catch (err) {
          deps.log('warn', `a pass failed: ${String(err)}`);
        }
      } while (again && !closed);
    })().finally(() => {
      running = null;
    });
  };
  const kick = (): void => {
    if (running) again = true;
    else run();
  };
  const onFileEvent = (): void => {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      kick();
    }, debounceMs);
  };
  const rewatch = async (): Promise<void> => {
    const old = watchers.splice(0);
    await Promise.all(old.map((w) => w.close().catch(() => {})));
    if (closed || mode() === 'idle') return;
    const watch = deps.watch ?? watchRoot;
    for (const root of ['incoming', 'sorted'] as const) {
      const base = roots[root];
      if (base) watchers.push(watch(base, onFileEvent));
    }
  };

  const accountId = async (): Promise<string | null> => {
    const rows = await deps.db.all(`SELECT id FROM accounts WHERE source = ? ORDER BY created_at LIMIT 1`, [
      SHARED_SOURCE,
    ]);
    return rows[0] ? String(rows[0].id) : null;
  };

  const api: SharedFolders = {
    mode,
    settled: async () => {
      await starting;
      while (timer || running) {
        // eslint-disable-next-line no-await-in-loop
        await (running ?? new Promise((r) => setTimeout(r, debounceMs + 1)));
      }
    },
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
      await rewatch();
    },
    onMode: (cb) => void modeListeners.push(cb),
    roots: () => ({ ...roots }),
    setRoots: async (next) => {
      const clean: Roots = { incoming: next.incoming ?? null, sorted: next.sorted ?? null };
      await deps.db.run(
        `INSERT INTO meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [ROOTS_META_KEY, JSON.stringify(clean)],
      );
      roots = clean;
      await rewatch();
      kick();
    },
    setTransport: (t) => {
      transport = t;
      void transport;
    },
    kick,
    resolve: async (absPath) => {
      const id = await accountId();
      if (!id) return null;
      for (const root of ['incoming', 'sorted'] as const) {
        const base = roots[root];
        const rel = base ? toRel(base, absPath) : null;
        if (rel) return { accountId: id, externalId: `${root}/${rel}`, root, relPath: rel };
      }
      return null;
    },
    pathOf: async (doc) => {
      if (doc.accountId !== (await accountId())) return null;
      const cut = doc.externalId.indexOf('/');
      const root = doc.externalId.slice(0, cut);
      const base = cut > 0 && isRoot(root) ? roots[root] : null;
      if (!base) return null;
      try {
        return toAbs(base, normalizeRel(doc.externalId.slice(cut + 1)));
      } catch {
        return null;
      }
    },
    registerCapture: async (captureId, sha256) => {
      if (deps.sync.readOnly()) throw new SyncReadOnly('registerCapture');
      await deps.db.run(
        `INSERT INTO shared_capture_files(capture_id, sha256) VALUES(?, ?)
         ON CONFLICT(capture_id) DO UPDATE SET sha256 = excluded.sha256`,
        [captureId, sha256],
      );
    },
    parked: async (absPath) => {
      for (const root of ['incoming', 'sorted'] as const) {
        const base = roots[root];
        const rel = base ? toRel(base, absPath) : null;
        if (!rel) continue;
        const rows = await deps.db.all(`SELECT parked FROM shared_files WHERE root = ? AND rel_path = ?`, [
          root,
          rel,
        ]);
        return rows[0]?.parked === 1;
      }
      return false;
    },
    listForSorting: async () => {
      if (mode() !== 'leader' || !roots.incoming) return [];
      await reconcileIfPending();
      if (mode() !== 'leader') return [];
      return listSortable(deps, roots.incoming);
    },
    moved: notYet('moved'),
    noteCapture: notYet('noteCapture'),
    fileOfCapture: notYet('fileOfCapture'),
    serve: {
      open: notYet('serve.open'),
      stagingFile: notYet('serve.stagingFile'),
      offer: notYet('serve.offer'),
      remove: notYet('serve.remove'),
    },
  };
  if (mode() === 'copy') await markPending();
  await rewatch();
  kick();
  return api;
}
