/** Shared folders (phone phase 3): the Incoming and Sorted folders belong to
 *  the account. The leader lists them in `shared_files`; a copy mirrors them.
 *  This is the service shell and its API surface; the passes live beside it. */
import type { AppDb } from '../../db/app-db';
import { SyncReadOnly } from '../sync/role';
import type { SyncService } from '../sync/service';
import { normalizeRel, toAbs, toRel, type SharedRoot } from './paths';

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
}

export interface SharedFolders extends SharedFoldersApi {
  mode(): SharedMode;
  /** Tells `cb` when the mode changes. Core-internal (the passes use it). */
  onMode(cb: (next: SharedMode, prev: SharedMode) => void): void;
}

export const ROOTS_META_KEY = 'shared-folders:roots';
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
  deps.sync.onRole(() => {
    const next = mode();
    if (next === lastMode) return;
    const prev = lastMode;
    lastMode = next;
    for (const cb of modeListeners) cb(next, prev);
  });

  const accountId = async (): Promise<string | null> => {
    const rows = await deps.db.all(`SELECT id FROM accounts WHERE source = ? ORDER BY created_at LIMIT 1`, [
      SHARED_SOURCE,
    ]);
    return rows[0] ? String(rows[0].id) : null;
  };

  const api: SharedFolders = {
    mode,
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
    },
    setTransport: (t) => {
      transport = t;
      void transport;
    },
    kick: () => {},
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
    parked: notYet('parked'),
    listForSorting: notYet('listForSorting'),
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
  return api;
}
