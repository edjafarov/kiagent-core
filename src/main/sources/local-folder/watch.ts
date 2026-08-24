import fs from 'node:fs';

import chokidar from 'chokidar';

import type { Batch, ExternalRef, Session } from '@shared/contracts';
import { isUnder } from '@shared/folder-paths';

import { DEFAULT_EXCLUDE_GLOBS } from './exclude-globs';
import { isIngestible } from './ingestible';
import { buildItem, toAbsPosix } from './scanner';
import { advanceCursor, type LocalFolderCursor } from './cursor';
import type { LocalFolderItem } from './to-document';

type FsEvent =
  | { kind: 'add' | 'change'; absPath: string }
  | { kind: 'unlink'; absPath: string };

/**
 * Symlink guard — the watcher's half of "watcher and scanner enumerate the
 * same set".
 *
 * The scanner walks with fast-glob's `followSymbolicLinks: false` + `onlyFiles`,
 * which drops EVERY symlink, to a directory or a file. chokidar does not have
 * an equivalent: its `followSymlinks: false` only makes it report the link
 * itself instead of its target — readdirp still descends through a symlinked
 * directory either way (measured: a self-referential link yields 17 phantom
 * adds with the option on and 32 with it off, the walk ending only when macOS
 * returns ELOOP). So the exclusion has to be ours.
 *
 * This is not hypothetical. A CrossOver bottle under a user's Documents root
 * symlinked `…/crossover/Documents` back to `~/Documents`; the watcher walked
 * the cycle and turned ~9.9k real files into 3.7M documents, each a distinct
 * `externalId` under a different nesting of the same loop. Reconcile then saw
 * millions of docs the scanner would never list again — which is how a
 * symlink became two out-of-memory crashes.
 *
 * `lstat` (never `stat`): the whole point is to see the link, not its target.
 * An unreadable/vanished path is ignored — chokidar will fail it anyway, and
 * this must never throw inside the matcher.
 */
export function isSymlink(absPath: string): boolean {
  try {
    return fs.lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The watcher's enumeration rules. Exported so the parity test can drive a
 *  real chokidar with the SAME object this ships — a test that restated the
 *  options would pass while the shipped ones drifted. `ignoreInitial` is NOT
 *  here: it is a watchLoop concern, and the parity check needs the initial
 *  walk it suppresses. */
export const WATCH_ENUMERATION_OPTIONS: chokidar.WatchOptions = {
  ignored: [...DEFAULT_EXCLUDE_GLOBS, isSymlink],
  // Belt to the braces above: keeps chokidar from RESOLVING a link it somehow
  // still reaches. It is not sufficient on its own — see isSymlink.
  followSymlinks: false,
};

/**
 * The ongoing "delta" for local-folder: kiagent-ref has
 * `supportsDelta: false` and relies entirely on a chokidar watcher for live
 * updates (kiagent-ref instance.ts:86-105); this translates the same
 * add/change/unlink events into per-event Batches. Runs until
 * `session.signal` aborts, at which point the watcher is closed and the
 * generator returns cleanly — the engine drives this via its `abortable()`
 * wrapper, which calls the generator's `return()` the moment the signal
 * fires (src/main/core/engine/engine.ts).
 *
 * One watcher instance covers every configured root — chokidar accepts an
 * array of paths natively, so multi-root add/change/unlink is a single
 * subscription rather than N.
 *
 * `startCursor` is the fully-caught-up snapshot handed off by `pull()` once
 * every root's backfill/incremental pass has completed. Each live event
 * advances ONLY the entry for the root the changed path falls under (via
 * `advanceCursor`) — every other root's watermark is carried over untouched,
 * so a restart mid-watch resumes each root from its own last-known-good
 * point instead of re-backfilling everything (which a naive `cursor: null`
 * here would force, by erasing every root's state at once).
 */
export async function* watchLoop(
  rootPaths: string[],
  session: Session,
  startCursor: LocalFolderCursor,
): AsyncGenerator<Batch<LocalFolderCursor, LocalFolderItem>> {
  const watcher = chokidar.watch(rootPaths, {
    ...WATCH_ENUMERATION_OPTIONS,
    ignoreInitial: true,
  });
  let cursor = startCursor;
  const rootOf = (absPath: string): string | undefined =>
    rootPaths.find((root) => isUnder(absPath, root));

  const queue: FsEvent[] = [];
  let wake: (() => void) | null = null;
  const enqueue = (e: FsEvent): void => {
    queue.push(e);
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  // The type allowlist is applied HERE, at the event, not in chokidar's
  // `ignored`: `ignored` is consulted for directories too, and a directory has
  // no ingestible extension — putting it there would prune the entire tree on
  // the first subdirectory. `isSymlink` can live in `ignored` precisely
  // because pruning a symlinked directory is the intent.
  //
  // `unlink` is filtered on the same rule: emitting a deletion for a file that
  // was never ingested would ask the store to archive a document that does not
  // exist. Filtering all three keeps the watcher's view of the tree identical
  // to `listEntries`', which is the invariant reconcile depends on.
  const onEvent = (kind: FsEvent['kind']) => (p: string) => {
    if (!isIngestible(p)) return;
    enqueue({ kind, absPath: p } as FsEvent);
  };
  watcher.on('add', onEvent('add'));
  watcher.on('change', onEvent('change'));
  watcher.on('unlink', onEvent('unlink'));

  const aborted = new Promise<void>((resolve) => {
    if (session.signal.aborted) resolve();
    else
      session.signal.addEventListener('abort', () => resolve(), { once: true });
  });

  try {
    for (;;) {
      if (session.signal.aborted) return;
      if (queue.length === 0) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          aborted,
        ]);
        if (session.signal.aborted) return;
        continue;
      }
      const ev = queue.shift();
      if (!ev) continue;

      if (ev.kind === 'unlink') {
        const deletions: ExternalRef[] = [
          { externalId: toAbsPosix(ev.absPath), type: 'file' },
        ];
        const root = rootOf(ev.absPath);
        if (root)
          cursor = advanceCursor(cursor, root, new Date().toISOString());
        yield {
          phase: 'live',
          items: [],
          deletions,
          cursor,
        };
        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        const stats = await fs.promises.stat(ev.absPath);
        // eslint-disable-next-line no-await-in-loop
        const item = await buildItem(ev.absPath, stats);
        const root = rootOf(ev.absPath);
        if (root)
          cursor = advanceCursor(cursor, root, new Date().toISOString());
        yield {
          phase: 'live',
          items: [item],
          cursor,
        };
      } catch {
        // File vanished between the fs event and the stat — a matching
        // unlink event will follow if it was really removed; skip for now.
      }
    }
  } finally {
    await watcher.close();
  }
}
