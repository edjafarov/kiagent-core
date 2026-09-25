/**
 * "A Reset all is under way" — alpha-cent#192. Recorded before the reset
 * pauses or deletes anything and removed only once it has finished (the core
 * wipe committed and the app state describing the old data is cleared). A
 * record still there at the next start means the last reset stopped
 * part-way — it failed, or the app quit or crashed during it — leaving some
 * data deleted and some not. Boot asks the user whether to finish it before
 * any extension runs on that half-deleted data (see factory-reset.ts
 * `startAfterInterruptedReset`).
 *
 * One flag is enough because every step of the reset is safe to repeat: an
 * extension namespace that is already empty resets again to empty, and so
 * does the core store.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ResetJournal {
  /** A reset was begun and has not finished. */
  pending(): boolean;
  /** Durable before it returns: the reset may be cut off right after. */
  begin(): void;
  end(): void;
}

export const RESET_JOURNAL_FILE = 'reset-in-progress.json';

export function createResetJournal(dir: string): ResetJournal {
  const file = path.join(dir, RESET_JOURNAL_FILE);
  return {
    pending: () => fs.existsSync(file),
    begin() {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(
          fd,
          JSON.stringify({ startedAt: new Date().toISOString() }),
        );
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
      syncDir(dir);
    },
    end() {
      fs.rmSync(file, { force: true });
      // A record that comes back after a power cut would ask to delete
      // whatever was made since the reset finished.
      syncDir(dir);
    },
  };
}

/** Makes a rename or removal in `dir` survive a power cut. Windows cannot
 *  open a directory to sync it; NTFS journals the change on its own. */
function syncDir(dir: string): void {
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // see above
  }
}
