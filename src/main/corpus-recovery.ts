/**
 * Boot recovery for a refused corpus (alpha-cent#93).
 *
 * `migrate()` refuses a corpus written by a newer build rather than corrupt
 * it, and until now that left the app dead: an error box, exit, and a
 * terminal session to move `kiagent.db` aside by hand. The corpus is a
 * rebuildable cache of the user's sources, so the app offers that move
 * itself: Quit (to update the app, which keeps everything), or back the index
 * up into a timestamped folder next to it and restart on a fresh one.
 * Accounts and credentials live in the same file, so a rebuild means
 * connecting them again; extension data lives in its own files and stays.
 *
 * Every other boot failure keeps `reportBootFailure`'s plain error box.
 */
import fs from 'fs';
import path from 'path';

import { isCorpusRefusal } from './core/store/corpus-refusal';
import { recordCrash, reportBootFailure } from './crash-handlers';
import type { CrashDeps } from './crash-handlers';

const CORPUS_FILES = ['kiagent.db', 'kiagent.db-wal', 'kiagent.db-shm'];

export interface BootFailureDeps {
  crash: CrashDeps;
  /** Where `kiagent.db` lives — `<userData>/data`. */
  dataDir: string;
  productName: string;
  now: () => Date;
  /** Shows the choice; true = back up & rebuild. */
  confirmRebuild(backupDir: string): Promise<boolean>;
  /** Restart the app (app.relaunch() + app.exit(0)). */
  relaunch(): void;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Renames with a short retry: on Windows a handle the DB worker has not
 *  released yet (or the stdio MCP server's reader) fails the rename with
 *  EBUSY/EPERM for a moment. */
async function moveFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const { code } = err as NodeJS.ErrnoException;
      if ((code !== 'EBUSY' && code !== 'EPERM') || attempt >= 10) throw err;
      // eslint-disable-next-line no-await-in-loop
      await sleep(200);
    }
  }
}

/** Moves the corpus and its WAL pair into `backupDir`, names intact so the
 *  backup opens as-is. Returns the new paths; [] when there was no corpus. */
export async function backupCorpus(
  dataDir: string,
  backupDir: string,
): Promise<string[]> {
  const present = CORPUS_FILES.filter((f) =>
    fs.existsSync(path.join(dataDir, f)),
  );
  if (present.length === 0) return [];
  fs.mkdirSync(backupDir, { recursive: true });
  const moved: string[] = [];
  // The database first: once it is gone a stray -wal/-shm cannot be replayed
  // into anything, and a fresh database never opens the old pair.
  for (const f of present) {
    const to = path.join(backupDir, f);
    // eslint-disable-next-line no-await-in-loop
    await moveFile(path.join(dataDir, f), to);
    moved.push(to);
  }
  return moved;
}

export function backupDirFor(dataDir: string, now: Date): string {
  return path.join(
    dataDir,
    `corpus-backup-${now.toISOString().replace(/[:.]/g, '-')}`,
  );
}

/** The boot IIFE's terminal handler. Never throws. */
export async function handleBootFailure(
  deps: BootFailureDeps,
  err: unknown,
): Promise<void> {
  if (!isCorpusRefusal(err)) {
    reportBootFailure(deps.crash, err);
    return;
  }
  recordCrash(deps.crash, 'main.boot', 'corpus refused', err);
  const backupDir = backupDirFor(deps.dataDir, deps.now());
  let rebuild: boolean;
  try {
    rebuild = await deps.confirmRebuild(backupDir);
  } catch {
    reportBootFailure(deps.crash, err);
    return;
  }
  if (!rebuild) {
    deps.crash.exit(1);
    return;
  }
  try {
    const moved = await backupCorpus(deps.dataDir, backupDir);
    // Nothing moved means the refusal did not come from this file: a restart
    // would only refuse again, forever.
    if (moved.length === 0) {
      throw new Error(`no corpus to back up in ${deps.dataDir}`);
    }
  } catch (backupErr) {
    reportBootFailure(deps.crash, backupErr);
    return;
  }
  deps.relaunch();
}

/** The dialog's words, kept beside the policy they describe. */
export function corpusRefusalDialog(productName: string, backupDir: string) {
  return {
    type: 'warning' as const,
    title: `${productName} can't open its index`,
    message: `This search index was created by a newer version of ${productName}.`,
    detail:
      `Update ${productName} to the latest version to keep using it — nothing is lost that way.\n\n` +
      `Or start over with a fresh index: ${productName} moves the current one to\n${backupDir}\nand restarts. ` +
      `Your files and messages at their sources are not affected, and your meetings and other extension data stay, ` +
      `but you will need to connect your accounts again and they will sync from the start.`,
    buttons: ['Quit', 'Back up & rebuild'],
    defaultId: 0,
    cancelId: 0,
  };
}
