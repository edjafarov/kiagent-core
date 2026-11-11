/** Whether a shared root may be trusted right now. A root is "really here"
 *  only while its directory lists and holds the marker file this Mac wrote
 *  into it (`.kia-sync/root`, a random id also kept in the `meta` table). An
 *  unmounted volume, which can leave an empty mount point behind, or another
 *  folder at that path, has no such marker: the root is then paused, and
 *  nothing is tombstoned, marked, dropped, sent, applied, fetched or accepted
 *  for it. With the marker present an empty listing is believed.
 *
 *  Deliberately no volume identity (device numbers are not stable across
 *  mounts on macOS, and a root's location is fixed in this phase): a folder
 *  the user replaced at the same path by a full copy that includes
 *  `.kia-sync` is accepted. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AppDb } from '../../db/app-db';
import { STAGING_DIR, type SharedRoot } from './paths';

/** The marker inside a root, relative to it. */
export const MARKER_REL = path.join(STAGING_DIR, 'root');

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

/** Why a root is not trusted: its directory is not there, not readable, or
 *  was never initialised on this Mac; or it lists but the marker is absent or
 *  another id. `ok` is the only state in which anything is done to the root. */
export type Gate = 'ok' | 'missing' | 'marker';

/** What the passes need to judge a root; `gateChanged` tells the service. */
export interface GateDeps {
  db: AppDb;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
  gateChanged?(root: SharedRoot, gate: Gate): void;
}

export async function readable(rootAbs: string): Promise<boolean> {
  try {
    if (!(await fs.promises.stat(rootAbs)).isDirectory()) return false;
    await fs.promises.readdir(rootAbs);
    return true;
  } catch {
    return false;
  }
}

/** This Mac initialised `root` at `path` with `id`. Local; one per (root, path). */
export const INITIALISED_KEY = 'shared-folders:initialised';
interface Initialised {
  root: SharedRoot;
  path: string;
  id: string;
}

async function loadInitialised(db: AppDb): Promise<Initialised[]> {
  try {
    const row = (await db.all(`SELECT value FROM meta WHERE key = ?`, [INITIALISED_KEY]))[0];
    const j: unknown = JSON.parse(String(row?.value ?? '[]'));
    if (Array.isArray(j)) return j.filter((e) => e && isRoot(e.root) && typeof e.path === 'string' && typeof e.id === 'string');
  } catch {
    // an unreadable note is the same as none: the root is uninitialised, so paused
  }
  return [];
}

const saveInitialised = (db: AppDb, list: readonly Initialised[]): Promise<unknown> =>
  db.run(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [
    INITIALISED_KEY,
    JSON.stringify(list),
  ]);

const markerIdIn = async (base: string): Promise<string | null> => {
  try {
    return (await fs.promises.readFile(path.join(base, MARKER_REL), 'utf8')).trim() || null;
  } catch {
    return null;
  }
};

async function writeMarker(base: string, id: string): Promise<void> {
  await fs.promises.mkdir(path.join(base, STAGING_DIR), { recursive: true });
  await fs.promises.writeFile(path.join(base, MARKER_REL), `${id}\n`);
}

/** Written exactly once per (root, absolute path): the first time this Mac is
 *  told to use `base` for `root`. The directory must exist and list; otherwise
 *  the root stays uninitialised (paused) and a later call tries again. A
 *  marker already in the folder (a database that was wiped) is adopted, not
 *  rewritten. Called only from `setRoots` and the start of a pass, never while
 *  scanning, mirroring, receiving or serving. */
export async function initialiseRoot(d: GateDeps, root: SharedRoot, base: string): Promise<void> {
  const list = await loadInitialised(d.db);
  if (list.some((e) => e.root === root && e.path === base)) return;
  if (!(await readable(base))) return;
  let id = await markerIdIn(base);
  if (!id) {
    id = randomUUID();
    await writeMarker(base, id);
  }
  await saveInitialised(d.db, [...list.filter((e) => e.root !== root), { root, path: base, id }]);
}

/** The user confirmed that the folder now at `base` is the one to use: a new
 *  marker and id replace whatever was there. Throws when it does not list. */
export async function reinitialiseRoot(d: GateDeps, root: SharedRoot, base: string): Promise<void> {
  if (!(await readable(base))) throw new Error(`shared-folders: the ${root} folder is not there`);
  const id = randomUUID();
  await writeMarker(base, id);
  const list = await loadInitialised(d.db);
  await saveInitialised(d.db, [...list.filter((e) => e.root !== root), { root, path: base, id }]);
}

/** THE judgement of one root, used by the leader's scan, the copy's mirror,
 *  the promotion reconcile and every request served: only `ok` allows a
 *  change. Reads only; never writes the marker. */
export async function checkRoot(d: GateDeps, root: SharedRoot, base: string): Promise<Gate> {
  const rec = (await loadInitialised(d.db)).find((e) => e.root === root && e.path === base);
  let gate: Gate;
  if (!rec || !(await readable(base))) gate = 'missing';
  else gate = (await markerIdIn(base)) === rec.id ? 'ok' : 'marker';
  d.gateChanged?.(root, gate);
  return gate;
}
