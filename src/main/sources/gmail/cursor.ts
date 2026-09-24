import { GMAIL_BUCKETS, type GmailBucket } from './bucket';

/**
 * One threads.list pagination still to finish. `q: null` is the full scope
 * (everything outside Trash and Spam); a bucket task lists `in:trash` or
 * `in:spam`. The query — and so the `includeSpamTrash` flag derived from it
 * — never changes over a task's life, so its `pageToken` always belongs to
 * the listing it resumes. `pageToken: null` means the task's first page.
 */
export interface GmailTask {
  q: string | null;
  pageToken: string | null;
}

/**
 * Gmail's persisted Cursor shape (spec §4). `tasks` are listings to finish,
 * worked in order; `historyId` is the ONE watermark they share, captured
 * before the first of them started, so the history sweep that follows the
 * queue covers every change made while it ran. An empty queue is steady
 * state: each pull is one history.list sweep. Widening the scope appends a
 * bucket task; the watermark never moves back.
 */
export interface GmailCursor {
  v: 2;
  historyId: string;
  tasks: GmailTask[];
}

/** v1 shapes persisted before task queues. */
type LegacyGmailCursor =
  | { mode: 'backfill'; pageToken: string | null; historyId: string }
  | { mode: 'delta'; historyId: string };

export function migrateGmailCursor(
  c: GmailCursor | LegacyGmailCursor | null,
): GmailCursor | null {
  if (c === null || 'v' in c) return c;
  return c.mode === 'backfill'
    ? {
        v: 2,
        historyId: c.historyId,
        tasks: [{ q: null, pageToken: c.pageToken }],
      }
    : { v: 2, historyId: c.historyId, tasks: [] };
}

export function bucketTask(bucket: Exclude<GmailBucket, 'mail'>): GmailTask {
  return {
    q: bucket === 'TRASH' ? 'in:trash' : 'in:spam',
    pageToken: null,
  };
}

/** A fresh backfill: the full scope, then each selected opt-in bucket. */
export function initialTasks(selected: ReadonlySet<GmailBucket>): GmailTask[] {
  const tasks: GmailTask[] = [{ q: null, pageToken: null }];
  for (const b of GMAIL_BUCKETS) {
    if (b !== 'mail' && selected.has(b)) tasks.push(bucketTask(b));
  }
  return tasks;
}

/**
 * Detects Gmail's 404 "Requested entity was not found" failure — thrown by
 * bearerFetch in the load-bearing `${errorPrefix} ${status} ${url} ${body}`
 * format. This is the SAME message Gmail returns both when a history
 * watermark has expired (history.list) and when an individual thread has
 * been deleted upstream (threads.get) — legacy regexed the identical text
 * for both cases (gmail/delta.ts). Callers disambiguate by which call this
 * followed, not by the message itself.
 */
export function isGmailNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /^gmail 404\b/.test(msg) && /Requested entity was not found/i.test(msg)
  );
}
