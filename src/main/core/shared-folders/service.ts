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
import { loadRootSet, OWED_KEY, PAUSED_KEY, quickCheck, ROOT_NAMES, saveRootSet, SharedRootPaused } from './root-state';
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
  /** False while the root is owed its reconcile (a new leader that has not
   *  checked it yet, or whose folder is not there, or lists nothing): nothing is scanned,
   *  sorted, served or indexed for it. Synchronous: the source reads it per row. */
  usable(root: SharedRoot): boolean;
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
export const RECONCILE_PENDING_KEY = OWED_KEY;
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
  let roleGen = 0;
  let closed = false;
  /** `() => true` while this device is still in `expected` mode and the role
   *  has not changed since this was made (not even to something else and back). */
  const stillAs = (expected: SharedMode): (() => boolean) => {
    const gen = roleGen;
    return () => !closed && gen === roleGen && mode() === expected;
  };
  // ONE queue: scans, the promotion reconcile, mirror passes and every
  // request served to another Mac run one after the other.
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    queued += 1;
    const p = tail.then(fn);
    tail = p.then(
      () => {},
      () => {},
    ).finally(() => {
      queued -= 1;
    });
    return p;
  };
  const modeListeners: ((next: SharedMode, prev: SharedMode) => void)[] = [];
  let lastMode = mode();
  let starting: Promise<void> = Promise.resolve();
  deps.sync.onRole(() => {
    const next = mode();
    if (next === lastMode) return;
    const prev = lastMode;
    lastMode = next;
    roleGen += 1; // every pass and request that started under the old role must stop writing
    if (next === 'copy') void markPending().catch((err) => deps.log('warn', `${String(err)}`));
    for (const cb of modeListeners) cb(next, prev);
    starting = rewatch().then(kick);
  });

  const watchers: RootWatcher[] = [];
  const debounceMs = deps.debounceMs ?? 750;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  // The roots whose reconcile at promotion is owed. Persisted, so a restart
  // (or a volume that is not mounted yet) does not forget it.
  const owed = await loadRootSet(deps.db, OWED_KEY);
  // The roots that are paused (not there, unreadable, suddenly empty).
  const paused = await loadRootSet(deps.db, PAUSED_KEY);
  const gateChanged = (root: SharedRoot, on: boolean): void => {
    if (on) paused.add(root);
    else paused.delete(root);
    fire();
  };
  let pendingGen = 0;
  const markPending = async (): Promise<void> => {
    pendingGen += 1;
    for (const r of ROOT_NAMES) owed.add(r);
    await saveRootSet(deps.db, OWED_KEY, owed);
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
  const isExplained = (root: SharedRoot, rel: string): boolean => explained.has(`${root}/${rel}`);
  const takeNote = (sha: string): string | null => {
    const note = pendingNotes.get(sha) ?? null;
    pendingNotes.delete(sha);
    return note;
  };
  /** Runs the promotion reconcile if one is owed. Only from inside the queue. */
  const reconcileIfPending = async (still: () => boolean): Promise<void> => {
    if (owed.size === 0) return;
    const gen = pendingGen;
    const result = await reconcileAtPromotion({ ...deps, roots, explained: isExplained, gateChanged, still });
    if (gen !== pendingGen || !still()) return; // became a copy again meanwhile: still owed
    let changed = false;
    for (const r of ROOT_NAMES) if (result[r] === 'done' && owed.delete(r)) changed = true;
    if (!changed) return;
    await saveRootSet(deps.db, OWED_KEY, owed);
    fire();
  };

  const joining = async (): Promise<boolean> =>
    (await deps.db.all(`SELECT joining FROM sync_state`))[0]?.joining === 1;

  const pass = async (): Promise<void> => {
    const now = mode();
    if (now === 'copy') {
      // A device that is still joining has not finished receiving its copy.
      if (!transport || (await joining())) return;
      await mirrorPass({ ...deps, roots, gateChanged, still: stillAs('copy') }, transport);
      return;
    }
    if (now !== 'leader') return;
    const still = stillAs('leader');
    await reconcileIfPending(still);
    if (!still()) return;
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
      if (!still()) break;
      // eslint-disable-next-line no-await-in-loop
      if (base && !owed.has(root)) {
        // eslint-disable-next-line no-await-in-loop
        await scanRoot({ ...deps, takeNote, explained: isExplained, gateChanged, still }, root, base);
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
          await enqueue(pass);
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
    run: (fn) => enqueue(() => fn(stillAs('leader'))),
    ready: () => reconcileIfPending(stillAs('leader')),
    refuse: (root) => {
      if (owed.has(root)) throw new SharedRootPaused(root, 'owed');
      if (paused.has(root)) throw new SharedRootPaused(root, 'paused');
    },
    quick: async (root) => {
      const base = roots[root];
      if (base && (await quickCheck({ ...deps, gateChanged }, root, base, (rel) => isExplained(root, rel))) === 'paused')
        throw new SharedRootPaused(root, 'paused');
    },
    kick,
    explained,
  });
  const api: SharedFolders = {
    mode,
    settled: async () => {
      await starting;
      while (timer || running || queued > 0) {
        // eslint-disable-next-line no-await-in-loop
        await (running ?? (queued > 0 ? tail : new Promise((r) => setTimeout(r, debounceMs + 1))));
      }
    },
    close: async () => {
      closed = true;
      clearInterval(retry);
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
      await tail;
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
    usable: (root) => !owed.has(root) && !paused.has(root),
    listForSorting: async () => {
      if (mode() !== 'leader' || !roots.incoming) return [];
      return enqueue(async () => {
        const still = stillAs('leader');
        await reconcileIfPending(still);
        if (!still() || !api.usable('incoming') || !roots.incoming) return [];
        return listSortable(deps, roots.incoming);
      });
    },
    serve,
  };
  if (mode() === 'copy') await markPending();
  await rewatch();
  kick();
  return api;
}
