import type { FolderCursorEntry, ImapCursor } from './types';

/** Split an array into fixed-size chunks, preserving order. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk: size must be > 0, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface MailboxSyncPlan {
  /** true if UIDVALIDITY changed vs the persisted cursor — a full resync of
   *  this mailbox is required (its previously-recorded UIDs no longer mean
   *  anything). */
  reset: boolean;
  /** UIDs still to fetch this pass, ascending. */
  uidsToFetch: number[];
}

/**
 * Pure planning step: given the persisted cursor entry for a mailbox, its
 * CURRENT UIDVALIDITY, and the UIDs currently present, decide what (if
 * anything) needs fetching and whether this is a fresh backfill (no prior
 * cursor), steady-state delta (cursor matches), or a forced resync
 * (UIDVALIDITY rolled over server-side).
 */
export function planMailboxSync(
  prev: FolderCursorEntry | undefined,
  currentUidValidity: number,
  presentUids: number[],
): MailboxSyncPlan {
  const uidValidityStr = String(currentUidValidity);
  const reset = prev !== undefined && prev.uidValidity !== uidValidityStr;
  const resumeFrom = prev && !reset ? prev.lastUid : 0;
  const uidsToFetch = presentUids.filter((uid) => uid > resumeFrom).sort((a, b) => a - b);
  return { reset, uidsToFetch };
}

/** Return a new cursor with one mailbox's entry replaced — every other
 *  mailbox's entry is carried over unchanged (each Batch.cursor is a full,
 *  self-consistent snapshot, per the Source contract). */
export function advanceCursor(
  cur: ImapCursor,
  mailbox: string,
  uidValidity: number,
  lastUid: number,
): ImapCursor {
  return {
    mailboxes: {
      ...cur.mailboxes,
      [mailbox]: { uidValidity: String(uidValidity), lastUid },
    },
  };
}

export function emptyCursor(): ImapCursor {
  return { mailboxes: {} };
}
