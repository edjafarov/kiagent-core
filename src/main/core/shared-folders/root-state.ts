/** Whether a shared root may be trusted right now. A root that is not there,
 *  not readable, or that suddenly lists nothing while the manifest holds live
 *  files (an unmounted volume leaves an empty mount point) is not an empty
 *  folder: nothing is tombstoned, marked, dropped, sent or accepted for it. */
import fs from 'node:fs';

import type { AppDb } from '../../db/app-db';
import { STAGING_DIR, type SharedRoot } from './paths';

export const ROOT_NAMES: readonly SharedRoot[] = ['incoming', 'sorted'];

/** The roots whose reconcile at promotion has not run yet. Local. A value of
 *  `1` (older builds) means both. */
export const OWED_KEY = 'shared-folders:reconcile-pending';

/** Thrown by `serve.*` for a root that is owed its reconcile or paused: the
 *  route turns it into "try again later" (HTTP 503 with `Retry-After`). */
export class SharedRootPaused extends Error {
  readonly code = 'SHARED_ROOT_PAUSED';

  constructor(
    readonly root: SharedRoot,
    readonly reason: 'owed' | 'paused',
  ) {
    super(
      `shared-folders: the ${root} folder is ${reason === 'owed' ? 'waiting for its first check' : 'paused'}; try again later`,
    );
  }
}

const isRoot = (s: unknown): s is SharedRoot => s === 'incoming' || s === 'sorted';

export async function loadRootSet(db: AppDb, key: string): Promise<Set<SharedRoot>> {
  const row = (await db.all(`SELECT value FROM meta WHERE key = ?`, [key]))[0];
  if (!row) return new Set();
  try {
    const j: unknown = JSON.parse(String(row.value));
    if (Array.isArray(j)) return new Set(j.filter(isRoot));
  } catch {
    // an unreadable note is the strictest one
  }
  return new Set(ROOT_NAMES);
}

export async function saveRootSet(db: AppDb, key: string, set: ReadonlySet<SharedRoot>): Promise<void> {
  if (set.size === 0) {
    await db.run(`DELETE FROM meta WHERE key = ?`, [key]);
    return;
  }
  await db.run(
    `INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify([...set].sort())],
  );
}

/** The roots that are paused: not there, not readable, or suddenly empty. Local. */
export const PAUSED_KEY = 'shared-folders:paused';

/** What the passes need to judge a root; `gateChanged` tells the service. */
export interface GateDeps {
  db: AppDb;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
  gateChanged?(root: SharedRoot, paused: boolean): void;
}

export interface LiveRow {
  rel_path: string;
  sha256: string;
  bytes: number;
  deleted: number;
  missing_here: number;
}

/** What a walk listed, as `readDisk` returns it. */
export interface Listing {
  files: ReadonlyMap<string, { sha: string; stats: { size: number } }>;
  seen: ReadonlySet<string>;
  incomplete: boolean;
}

const told = new WeakMap<object, Set<string>>();
const tellOnce = (d: GateDeps, key: string, msg: string): void => {
  const set = told.get(d.db) ?? told.set(d.db, new Set()).get(d.db)!;
  if (set.has(key)) return;
  set.add(key);
  d.log('warn', msg);
};

async function setPaused(d: GateDeps, root: SharedRoot, on: boolean, why: string): Promise<void> {
  const set = await loadRootSet(d.db, PAUSED_KEY);
  if (set.has(root) === on) return;
  if (on) set.add(root);
  else set.delete(root);
  await saveRootSet(d.db, PAUSED_KEY, set);
  const key = `paused:${root}`;
  if (on) tellOnce(d, key, `${root} folder ${why}; paused until its files are back`);
  else {
    told.get(d.db)?.delete(key);
    d.log('info', `${root} folder is back; resumed`);
  }
  d.gateChanged?.(root, on);
}

const isLive = (r: LiveRow): boolean => !r.deleted && !r.missing_here;

/** THE judgement of one root, used by the leader's scan, the copy's mirror
 *  and the promotion reconcile. `paused` means: change nothing for this root
 *  (no tombstone, no `missing_here`, no mirror change, nothing sent or applied).
 *
 *  A root is paused when it is not readable, or when it lists no file at all
 *  while the manifest holds live files here, unless every one of them left
 *  through this device's own hands (`explained`) or this Mac never had files
 *  here (`evidence` false: a new copy fetches into an empty folder). It is
 *  released only by a listing that holds at least one file of a live row (same
 *  path and size, or same hash), or when the emptiness is fully explained. */
export async function judgeRoot(
  d: GateDeps,
  root: SharedRoot,
  input: {
    readable: boolean;
    rows: Iterable<LiveRow>;
    disk?: Listing;
    explained: (rel: string) => boolean;
    evidence: boolean;
  },
): Promise<'ok' | 'paused'> {
  const was = (await loadRootSet(d.db, PAUSED_KEY)).has(root);
  if (!input.readable || !input.disk) {
    await setPaused(d, root, true, 'is missing or unreadable');
    return 'paused';
  }
  const live = [...input.rows].filter(isLive);
  if (live.length === 0) {
    await setPaused(d, root, false, '');
    return 'ok';
  }
  const disk = input.disk;
  if (disk.incomplete) return was ? 'paused' : 'ok'; // a walk that missed folders proves nothing
  const shas = new Set<string>();
  for (const f of disk.files.values()) shas.add(f.sha);
  const matches = live.some((r) => disk.files.get(r.rel_path)?.stats.size === r.bytes || shas.has(r.sha256));
  if (matches) {
    await setPaused(d, root, false, '');
    return 'ok';
  }
  if (disk.seen.size === 0) {
    if (live.every((r) => input.explained(r.rel_path))) {
      await setPaused(d, root, false, '');
      return 'ok';
    }
    if (input.evidence || was) {
      await setPaused(d, root, true, 'lists no file at all');
      return 'paused';
    }
  }
  return was ? 'paused' : 'ok';
}

/** The cheap check a request from another Mac gets before anything is written
 *  or read (after the service has refused a root it already knows is owed or
 *  paused): is the root there, and does it list anything at its top? Pauses
 *  the root if not; releases nothing. */
export async function quickCheck(
  d: GateDeps,
  root: SharedRoot,
  base: string,
  explained: (rel: string) => boolean,
): Promise<'ok' | 'paused'> {
  let top: string[];
  try {
    top = await fs.promises.readdir(base);
  } catch {
    await setPaused(d, root, true, 'is missing or unreadable');
    return 'paused';
  }
  if (top.some((n) => n !== STAGING_DIR)) return 'ok';
  const rows = (await d.db.all(
    `SELECT rel_path FROM shared_files WHERE root = ? AND deleted = 0 AND missing_here = 0`,
    [root],
  )) as unknown as { rel_path: string }[];
  if (rows.every((r) => explained(r.rel_path))) return 'ok';
  await setPaused(d, root, true, 'lists no file at all');
  return 'paused';
}
