/** Shared folders (phone phase 3): the Incoming and Sorted folders belong to
 *  the account. The leader lists them in `shared_files`; a copy mirrors them.
 *  This is the service shell and its API surface; the passes live beside it. */
import type { AppDb } from '../../db/app-db';
import type { SyncService } from '../sync/service';
import { createCaptures } from './captures';
import { migrateLocalFolders, type LocalFolderAccess } from './migrate';
import { scanRoot } from './leader-scan';
import { mirrorPass } from './mirror';
import { listSortable, reconcileAtPromotion } from './promote';
import { normalizeRel, toAbs, toRel, type SharedRoot } from './paths';
import { createServe } from './serve';
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
  /** Tells `cb` when `shared_files` changed on this device or a promotion
   *  reconcile finished (the sorter asks `listForSorting` again). */
  onChange(cb: () => void): () => void;
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
  /** Creates the one `shared-folder` account and starts it (the host does
   *  `store.createAccount` + `runAccount`). Absent in hosts without an engine. */
  ensureAccount?(): Promise<void>;
  /** The Mac's `local-folder` accounts, for the one-time move of the
   *  documents they hold under a folder that has become a shared root. */
  localFolders?: LocalFolderAccess;
  /** How often a copy tries again without being told to (a failed transport,
   *  a join that finished). Default 60 000. */
  retryMs?: number;
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
  const changeListeners = new Set<() => void>();
  const fire = (): void => {
    for (const cb of [...changeListeners]) {
      try {
        cb();
      } catch (err) {
        deps.log('warn', `a change listener failed: ${String(err)}`);
      }
    }
  };
  const maxRev = async (): Promise<number> =>
    Number((await deps.db.all(`SELECT coalesce(max(rev), 0) AS m FROM shared_files`))[0]?.m ?? 0);
  const pendingNotes = new Map<string, string>();
  const explained = new Set<string>();
  const takeNote = (sha: string): string | null => {
    const note = pendingNotes.get(sha) ?? null;
    pendingNotes.delete(sha);
    return note;
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
      fire();
    })().finally(() => {
      reconciling = null;
    });
    await reconciling;
  };

  const joining = async (): Promise<boolean> =>
    (await deps.db.all(`SELECT joining FROM sync_state`))[0]?.joining === 1;

  const pass = async (): Promise<void> => {
    if (mode() === 'copy') {
      // A device that is still joining has not finished receiving its copy.
      if (!transport || (await joining())) return;
      await mirrorPass({ ...deps, roots }, transport);
      return;
    }
    if (mode() !== 'leader') return;
    await reconcileIfPending();
    if (deps.ensureAccount && (roots.incoming || roots.sorted) && !(await accountId())) {
      try {
        await deps.ensureAccount();
      } catch (err) {
        deps.log('warn', `could not create the shared-folder account: ${String(err)}`);
      }
    }
    const before = await maxRev();
    for (const root of ['incoming', 'sorted'] as const) {
      const base = roots[root];
      // eslint-disable-next-line no-await-in-loop
      if (base) {
        // eslint-disable-next-line no-await-in-loop
        await scanRoot({ ...deps, takeNote, explained }, root, base);
        for (const key of [...explained]) if (key.startsWith(`${root}/`)) explained.delete(key);
      }
    }
    if ((await maxRev()) !== before) fire();
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
  // A copy tries again now and then: the transport may have failed, or a join finished.
  const retry = setInterval(() => {
    if (!closed && transport && mode() === 'copy') kick();
  }, deps.retryMs ?? 60_000);
  retry.unref?.();
  deps.sync.onApplied((tables) => {
    if (tables.includes('shared_files')) kick();
  });
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

  const captures = createCaptures({ deps, roots: () => roots, accountId, kick, pendingNotes, explained });
  const serve = createServe({
    deps,
    roots: () => roots,
    leader: () => mode() === 'leader',
    ready: reconcileIfPending,
    kick,
    explained,
  });
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
      clearInterval(retry);
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
      // Before the first scan: the exclusion in `local-folder` is already in force.
      if (deps.localFolders) {
        for (const base of [clean.incoming, clean.sorted]) {
          // eslint-disable-next-line no-await-in-loop
          if (base) await migrateLocalFolders({ db: deps.db, localFolders: deps.localFolders, log: deps.log }, base);
        }
      }
      await rewatch();
      kick();
    },
    setTransport: (t) => {
      transport = t;
      if (t) kick();
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
    ...captures,
    onChange: (cb) => {
      changeListeners.add(cb);
      return () => void changeListeners.delete(cb);
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
    serve,
  };
  if (mode() === 'copy') await markPending();
  await rewatch();
  kick();
  return api;
}
