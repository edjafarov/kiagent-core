import path from 'node:path';

import chokidar from 'chokidar';

import { WATCH_ENUMERATION_OPTIONS } from '../../sources/local-folder/watch';
import { STAGING_DIR } from './paths';

export interface RootWatcher {
  close(): Promise<void>;
}

/** One watcher for one root, with `local-folder`'s own enumeration rules, minus
 *  the staging directory. Every event only says "look again". */
export function watchRoot(rootAbs: string, onEvent: () => void): RootWatcher {
  const inStaging = (p: string): boolean => {
    const rel = path.relative(rootAbs, p);
    return rel === STAGING_DIR || rel.startsWith(`${STAGING_DIR}${path.sep}`);
  };
  const base = WATCH_ENUMERATION_OPTIONS.ignored;
  const watcher = chokidar.watch(rootAbs, {
    ...WATCH_ENUMERATION_OPTIONS,
    ignored: [...(Array.isArray(base) ? base : base ? [base] : []), inStaging],
    ignoreInitial: true,
  });
  watcher.on('all', () => onEvent());
  // A root that vanishes is the scan's business; the watcher only needs to not throw.
  watcher.on('error', () => {});
  return { close: () => watcher.close() };
}
