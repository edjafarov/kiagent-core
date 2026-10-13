import fs from 'node:fs';
import path from 'node:path';

import chokidar from 'chokidar';

import { DEFAULT_EXCLUDE_GLOBS } from './exclude-globs';
import { isIngestible } from './ingestible';

export type FsEvent =
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
 *  here: it is a startWatcher concern, and the parity check needs the initial
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
 * updates (kiagent-ref instance.ts:86-105). One watcher covers every
 * configured root (chokidar takes an array of paths natively).
 *
 * The watcher only QUEUES events; `pull()` drains them (see its driving
 * loop) one at a time, alternating with container expansion steps. It is
 * started BEFORE the backfill/rescan: it runs with `ignoreInitial`, so one
 * started after a long expansion would miss everything changed meanwhile.
 * Events that arrive during the scan re-emit a file the scan may already
 * have emitted — harmless, the store's same-hash short-circuit absorbs it.
 */
export interface Watcher {
  /** The oldest queued event, or undefined. */
  take(): FsEvent | undefined;
  /** Resolves on the next event, after `ms` (when given), or on abort. */
  wait(ms?: number): Promise<void>;
  close(): Promise<void>;
}

export function startWatcher(
  rootPaths: string[],
  signal: AbortSignal,
): Watcher {
  const watcher = chokidar.watch(rootPaths, {
    ...WATCH_ENUMERATION_OPTIONS,
    ignoreInitial: true,
  });
  const queue: FsEvent[] = [];
  let wake: (() => void) | null = null;
  const fire = (): void => {
    const w = wake;
    wake = null;
    w?.();
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
  // to the scanner's (`walkPaths`), which is the invariant reconcile depends on.
  const onEvent = (kind: FsEvent['kind']) => (p: string) => {
    // A Thunderbird mailbox is admitted by its `.msf` sibling. If the
    // mailbox was written first, its own event was filtered; the index's
    // arrival is what admits it.
    if (kind === 'add' && p.endsWith('.msf')) {
      const mailbox = p.slice(0, -'.msf'.length);
      if (
        !path.extname(mailbox) &&
        fs.existsSync(mailbox) &&
        isIngestible(mailbox)
      )
        queue.push({ kind: 'add', absPath: mailbox });
    }
    if (isIngestible(p)) queue.push({ kind, absPath: p });
    fire();
  };
  watcher.on('add', onEvent('add'));
  watcher.on('change', onEvent('change'));
  watcher.on('unlink', onEvent('unlink'));
  signal.addEventListener('abort', fire, { once: true });

  return {
    take: () => queue.shift(),
    wait: (ms) =>
      queue.length > 0 || signal.aborted
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer =
              ms === undefined ? undefined : setTimeout(fire, Math.max(0, ms));
            wake = () => {
              if (timer) clearTimeout(timer);
              resolve();
            };
          }),
    close: async () => {
      signal.removeEventListener('abort', fire);
      fire();
      await watcher.close();
    },
  };
}
