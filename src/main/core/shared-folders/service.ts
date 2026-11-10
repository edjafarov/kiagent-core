/** Shared folders (phone phase 3): the Incoming and Sorted folders belong to
 *  the account. The leader lists them in `shared_files`; a copy mirrors them.
 *  This is the service shell and its API surface; the passes live beside it. */
import fs from 'node:fs';

import type { AppDb } from '../../db/app-db';
import type { SyncService } from '../sync/service';
import { createCaptures } from './captures';
import { migrateLocalFolders, type LocalFolderAccess } from './migrate';
import { scanRoot } from './leader-scan';
import { mirrorPass } from './mirror';
import { listSortable, reconcileAtPromotion } from './promote';
import { rowAt } from './row-lookup';
import { nameKey, normalizeRel, safeAbs, toRel, type SharedRoot } from './paths';
import {
  checkRoot,
  initialiseRoot,
  loadRootSet,
  OWED_KEY,
  reinitialiseRoot,
  ROOT_NAMES,
  saveRootSet,
  SharedRootPaused,
  type Gate,
} from './root-state';
import { createServe } from './serve';
import { loadUnparsed, reportUnparsed, restamp, type Unparsed } from './unparsed';
import { watchRoot, type RootWatcher } from './watch';

export type { SharedRoot } from './paths';

export type Roots = { incoming: string | null; sorted: string | null };
/** Why a root is (not) in use on this Mac: `unset` no folder chosen; `paused-missing`
 *  the folder is not there, not readable, or not initialised yet; `paused-marker`
 *  the folder is there but its marker is absent or another id; `owed` a
 *  reconcile (a new leader's, or after `reattach`) has not finished. */
export type RootStatus = 'ok' | 'unset' | 'paused-missing' | 'paused-marker' | 'owed';
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
  /** Remembers the roots. Nothing else happens until `enabled()`. */
  setRoots(roots: Roots): Promise<void>;
  roots(): Roots;
  /** True once this device belongs to an account with at least one other
   *  computer and roots are set: only then are the folders shared (marker,
   *  scans, mirror, `shared-folder` account, `local-folder` exclusion and its
   *  migration). Kept for good once true, also if the other computer leaves.
   *  Until then every other member answers "nothing is shared" and
   *  `rootStatus` is `'unset'`. Synchronous. `onChange` fires when it turns
   *  true. */
  enabled(): boolean;
  setTransport(t: SharedTransport | null): void;
  kick(): void;
  resolve(absPath: string): Promise<SharedRef | null>;
  /** The local path of a document's original, only while the root is usable,
   *  the row is live, and the file here holds the row's bytes. */
  pathOf(doc: { accountId: string; externalId: string }): Promise<string | null>;
  parked(absPath: string): Promise<boolean>;
  /** Tells `cb` when `shared_files` changed on this device or a promotion
   *  reconcile finished (the sorter asks `listForSorting` again). */
  onChange(cb: () => void): () => void;
  /** The Incoming files the sorter may start on by itself: live, present
   *  here and not parked. */
  listForSorting(): Promise<string[]>;
  /** The absolute paths of every Incoming file that is live and present here
   *  (what `listForSorting` checks), parked ones included: the files whose
   *  bytes are safe to sort when the user asks for it. Same gating as
   *  `listForSorting`: the root usable, its reconcile done, shared folders on,
   *  this device the leader. */
  listPresent(): Promise<string[]>;
  /** The source could not turn these rows into documents (the file was not
   *  readable, or not the bytes the row names). They get a new revision, so
   *  the source sees them again, once the file can be opened and the file's
   *  stat has changed or a minute has passed since they were reported. */
  reportUnparsed(refs: { root: SharedRoot; relPath: string }[]): Promise<void>;
  /** False while the root is unset, paused (its folder is not really here: see
   *  `rootStatus`) or owed its reconcile: nothing is scanned, sorted, served or
   *  indexed for it. Synchronous: the source reads it per row. */
  usable(root: SharedRoot): boolean;
  /** `usable(root)` is `rootStatus(root) === 'ok'`. Synchronous. */
  rootStatus(root: SharedRoot): RootStatus;
  /** For Settings, once the user confirms that the folder now at this root's
   *  path should be used (after a volume came back different, say). It must
   *  exist and list. This Mac forgets its mirror entries for the root, so
   *  nothing on disk can be read as a deletion and every file is compared
   *  afresh; a new marker is written; a leader owes the root a reconcile.
   *  Deletes and trashes nothing. */
  reattach(root: SharedRoot): Promise<void>;
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
  /** Called with the service before its start-up work (the migration restarts
   *  local-folder scans, and they must already see what the folders exclude). */
  publish?(api: SharedFolders): void;
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
  /** The platform whose file-name rules apply; default `process.platform`.
   *  On macOS and Windows, names that differ only in case (or Unicode
   *  normalisation) are one file. Injected so tests cover both rules. */
  platform?: NodeJS.Platform;
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
/** Set locally, once, the first time the device is in an account with a peer
 *  while roots are set. Never cleared. */
export const ENABLED_META_KEY = 'shared-folders:enabled';
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
  let closed = false;
  let roots = await loadRoots(deps.db);
  let transport: SharedTransport | null = null;
  let enabled = (await deps.db.all(`SELECT 1 FROM meta WHERE key = ?`, [ENABLED_META_KEY])).length > 0;
  /** Another computer is in this device's account: a follower always has one
   *  (its leader), a leader has one when the lease says `multiDevice`. */
  const hasPeer = (): boolean => {
    const r = deps.sync.role();
    return r.multiDevice || r.follower;
  };
  /** Enabling is due: roots are set and a peer is there. */
  const due = (): boolean => !enabled && !closed && !!(roots.incoming || roots.sorted) && hasPeer();

  const mode = (): SharedMode => {
    const r = deps.sync.role();
    if (r.leader) return 'leader';
    return r.follower ? 'copy' : 'idle';
  };
  let roleGen = 0;
  const key = nameKey(deps.platform);
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
    if (due()) {
      enabled = true;
      starting = starting.then(enableNow).catch((err) => deps.log('warn', `could not start the shared folders: ${String(err)}`));
    }
    const next = mode();
    if (next === lastMode) return;
    const prev = lastMode;
    lastMode = next;
    roleGen += 1; // every pass and request that started under the old role must stop writing
    if (next === 'copy') void markPending().catch((err) => deps.log('warn', `${String(err)}`));
    for (const cb of modeListeners) cb(next, prev);
    starting = starting.then(rewatch).then(kick);
  });

  /** What happens when roots are set on a device that shares folders. */
  const startUp = async (): Promise<void> => {
    await enqueue(lookAtRoots); // the marker, written once, before anything scans
    // Before the first scan: the exclusion in `local-folder` is already in force.
    if (deps.localFolders) {
      for (const base of [roots.incoming, roots.sorted]) {
        // eslint-disable-next-line no-await-in-loop
        if (base) await migrateLocalFolders({ db: deps.db, localFolders: deps.localFolders, log: deps.log }, base);
      }
    }
    await rewatch();
    kick();
  };
  /** The device has just become one that shares folders (`enabled` is already
   *  true in memory): remembered for good, then started as if the roots had
   *  just been set. */
  const enableNow = async (): Promise<void> => {
    await deps.db.run(
      `INSERT INTO meta(key, value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [ENABLED_META_KEY],
    );
    deps.log('info', 'shared folders are on: this device has another computer in its account');
    await startUp();
    fire();
  };
  const watchers: RootWatcher[] = [];
  const debounceMs = deps.debounceMs ?? 750;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  // The roots whose reconcile at promotion is owed. Persisted, so a restart
  // (or a volume that is not mounted yet) does not forget it.
  const owed = await loadRootSet(deps.db, OWED_KEY);
  // What the last look at each root's folder and marker found (see `checkRoot`).
  const gates = new Map<SharedRoot, Gate>();
  const gateChanged = (root: SharedRoot, gate: Gate): void => {
    const was = gates.get(root);
    if (was === gate) return;
    gates.set(root, gate);
    if (gate === 'ok') deps.log('info', `${root} folder is back; resumed`);
    else deps.log('warn', `${root} folder ${gate === 'marker' ? 'is not the one this Mac set up' : 'is missing or unreadable'}; paused until it is back`);
    fire();
  };
  const gated = { ...deps, gateChanged };
  /** Initialises a root this Mac has not initialised yet, and looks at both. */
  const lookAtRoots = async (): Promise<void> => {
    for (const root of ROOT_NAMES) {
      const base = roots[root];
      if (!base) {
        gates.delete(root);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await initialiseRoot(gated, root, base);
      // eslint-disable-next-line no-await-in-loop
      await checkRoot(gated, root, base);
    }
  };
  const rootStatus = (root: SharedRoot): RootStatus => {
    if (!enabled || !roots[root]) return 'unset';
    const g = gates.get(root);
    if (g !== 'ok') return g === 'marker' ? 'paused-marker' : 'paused-missing';
    return owed.has(root) ? 'owed' : 'ok';
  };
  // Rows the source could not parse; see `reportUnparsed`. Local, persisted.
  const unparsed: Unparsed = await loadUnparsed(deps.db);
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
  /** Runs the promotion reconcile if one is owed. Only from inside the queue. */
  const reconcileIfPending = async (still: () => boolean): Promise<void> => {
    if (owed.size === 0) return;
    const gen = pendingGen;
    const result = await reconcileAtPromotion({ ...deps, roots, gateChanged, still, only: owed });
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
    if (!enabled) return;
    const now = mode();
    await lookAtRoots();
    if (mode() !== now) return; // the role changed meanwhile: the pass its change asked for follows
    if (now === 'copy') {
      // A device that is still joining has not finished receiving its copy.
      if (!transport || (await joining())) return;
      await mirrorPass({ ...gated, roots, still: stillAs('copy') }, transport);
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
        await scanRoot({ ...gated, still }, root, base);
      }
    }
    if (still()) await restamp({ ...deps, roots, usable: (r) => api.usable(r), still }, unparsed);
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
    if (closed) return;
    if (transport && mode() === 'copy') kick();
    else if (mode() === 'leader' && (unparsed.size > 0 || ROOT_NAMES.some((r) => roots[r] && (gates.get(r) !== 'ok' || owed.has(r))))) kick();
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
    if (closed || !enabled || mode() === 'idle') return;
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

  const captures = createCaptures({
    deps,
    roots: () => (enabled ? roots : { incoming: null, sorted: null }),
    accountId: async () => (enabled ? accountId() : null),
    kick,
  });
  const serve = createServe({
    deps,
    roots: () => roots,
    leader: () => mode() === 'leader',
    run: (fn) => enqueue(() => fn(stillAs('leader'))),
    ready: () => reconcileIfPending(stillAs('leader')),
    refuse: (root) => {
      if (!enabled) throw new SharedRootPaused(root, 'paused');
      if (owed.has(root)) throw new SharedRootPaused(root, 'owed');
      if (roots[root] && gates.get(root) !== 'ok') throw new SharedRootPaused(root, 'paused');
    },
    quick: async (root) => {
      const base = roots[root];
      if (base && (await checkRoot(gated, root, base)) !== 'ok') throw new SharedRootPaused(root, 'paused');
    },
    kick,
  });
  const listIncoming = async (parkedToo: boolean): Promise<string[]> => {
    if (!enabled || mode() !== 'leader' || !roots.incoming) return [];
    return enqueue(async () => {
      const still = stillAs('leader');
      await reconcileIfPending(still);
      const base = roots.incoming;
      if (!still() || !base || (await checkRoot(gated, 'incoming', base)) !== 'ok' || !api.usable('incoming')) return [];
      return listSortable(deps, base, parkedToo);
    });
  };
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
      if (due()) {
        enabled = true;
        await enableNow();
      } else if (enabled) await startUp();
      // else: remembered, and used once a peer is there
    },
    enabled: () => enabled,
    setTransport: (t) => {
      transport = t;
      if (t) kick();
    },
    kick,
    resolve: async (absPath) => {
      if (!enabled) return null;
      const id = await accountId();
      if (!id) return null;
      for (const root of ['incoming', 'sorted'] as const) {
        const base = roots[root];
        const rel = base ? toRel(base, absPath) : null;
        if (!rel) continue;
        const row = await rowAt(deps.db, key, root, rel); // the manifest's spelling is the identity
        const relPath = row?.rel_path ?? rel;
        return { accountId: id, externalId: `${root}/${relPath}`, root, relPath };
      }
      return null;
    },
    pathOf: async (doc) => {
      if (!enabled) return null;
      if (doc.accountId !== (await accountId())) return null;
      const cut = doc.externalId.indexOf('/');
      const root = doc.externalId.slice(0, cut);
      const base = cut > 0 && isRoot(root) ? roots[root] : null;
      // A copy is never owed a reconcile (that is for a new leader), so it is
      // only a paused root that withholds the path there.
      if (!base) return null;
      const status = rootStatus(root as SharedRoot);
      if (status !== 'ok' && !(status === 'owed' && mode() === 'copy')) return null;
      try {
        const rel = normalizeRel(doc.externalId.slice(cut + 1));
        // Only for the version the manifest names: after a promotion the disk
        // may hold an older one (the row is `missing_here`), and that is not
        // the document's original. `missing_here` describes the leader's disk;
        // a copy that holds the right bytes still gets its path.
        const row = await rowAt(deps.db, key, root as SharedRoot, rel);
        if (!row || row.deleted) return null;
        const abs = await safeAbs(base, row.rel_path);
        const st = await fs.promises.stat(abs);
        if (!st.isFile()) return null;
        const m = (await deps.db.all(`SELECT sha256, bytes, mtime_ms FROM shared_mirror WHERE root = ? AND rel_path = ?`, [
          root,
          row.rel_path,
        ]))[0];
        const sha =
          m && Number(m.bytes) === st.size && Number(m.mtime_ms) === Math.floor(st.mtimeMs)
            ? String(m.sha256)
            : await deps.hashFile(abs);
        return sha === row.sha256 ? abs : null;
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
        return (await rowAt(deps.db, key, root, rel))?.parked === 1;
      }
      return false;
    },
    usable: (root) => rootStatus(root) === 'ok',
    rootStatus,
    reattach: (root) =>
      enqueue(async () => {
        const base = roots[root];
        if (!enabled) throw new Error('shared-folders: folders are shared only once another computer is in the account');
        if (!base) throw new Error(`shared-folders: the ${root} folder is not set on this Mac`);
        await reinitialiseRoot(gated, root, base);
        // Every file is compared afresh: nothing on disk can be read as a deletion.
        await deps.db.run(`DELETE FROM shared_mirror WHERE root = ?`, [root]);
        if (mode() === 'leader') {
          pendingGen += 1;
          owed.add(root);
          await saveRootSet(deps.db, OWED_KEY, owed);
        }
        await checkRoot(gated, root, base);
        kick();
      }),
    reportUnparsed: (refs) => reportUnparsed({ ...deps, roots }, unparsed, refs),
    listForSorting: () => listIncoming(false),
    listPresent: () => listIncoming(true),
    serve,
  };
  deps.publish?.(api);
  if (mode() === 'copy') await markPending();
  if (due()) {
    enabled = true;
    await enableNow();
  } else if (enabled) {
    await lookAtRoots();
    await rewatch();
    kick();
  }
  return api;
}
