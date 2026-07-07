import fs from 'node:fs';

import chokidar from 'chokidar';

import type { Batch, ExternalRef, Session } from '@shared/contracts';
import { isUnder } from '@shared/folder-paths';

import { DEFAULT_EXCLUDE_GLOBS } from './exclude-globs';
import { buildItem, toAbsPosix } from './scanner';
import { advanceCursor, type LocalFolderCursor } from './cursor';
import type { LocalFolderItem } from './to-document';

type FsEvent =
  | { kind: 'add' | 'change'; absPath: string }
  | { kind: 'unlink'; absPath: string };

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
    ignored: DEFAULT_EXCLUDE_GLOBS,
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
  watcher.on('add', (p: string) => enqueue({ kind: 'add', absPath: p }));
  watcher.on('change', (p: string) => enqueue({ kind: 'change', absPath: p }));
  watcher.on('unlink', (p: string) => enqueue({ kind: 'unlink', absPath: p }));

  const aborted = new Promise<void>((resolve) => {
    if (session.signal.aborted) resolve();
    else session.signal.addEventListener('abort', () => resolve(), { once: true });
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
        const deletions: ExternalRef[] = [{ externalId: toAbsPosix(ev.absPath), type: 'file' }];
        const root = rootOf(ev.absPath);
        if (root) cursor = advanceCursor(cursor, root, new Date().toISOString());
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
        if (root) cursor = advanceCursor(cursor, root, new Date().toISOString());
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
