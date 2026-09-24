import type {
  AuthChannel,
  Batch,
  ExternalRef,
  FolderNode,
  FolderScopeUpdate,
  FolderSelectionChannel,
  Session,
  Source,
  SourceDescriptor,
} from '@shared/contracts';

import {
  BUCKET_COPY,
  GMAIL_BUCKETS,
  type GmailBucket,
  bucketRoots,
  selectedBuckets,
} from './bucket';
import {
  type GmailCursor,
  initialTasks,
  isGmailNotFoundError,
  type LegacyGmailCursor,
  migrateGmailCursor,
  rescopeCursor,
} from './cursor';
import {
  fetchProfile,
  fetchProfileWithToken,
  getAttachment,
  getMessage,
  getThread,
  listHistoryPage,
  listThreadsPage,
  mapPool,
} from './gmail-api';
import { attachmentsOf, parseGmailMessage } from './parser';
import { normalizeAuthor } from '../email-evidence';
import { GMAIL_SCOPES } from './oauth';
import {
  GMAIL_THREAD_DOCUMENT_TYPE,
  toDocument,
  type GmailThreadItem,
} from './to-document';

export const descriptor: SourceDescriptor = {
  id: 'gmail',
  name: 'Gmail',
  // Legacy stored one row per whole thread (`email_thread`) and a separate
  // row per attachment (`attachment`); there was never a per-message type.
  // This port emits the thread-level document plus one child document per
  // attachment, so there is no `email.message` type to declare.
  documentTypes: [GMAIL_THREAD_DOCUMENT_TYPE, 'attachment'],
  auth: 'oauth',
  multiAccount: true,
  cadence: { every: '15m' },
  /** Spec §4: the buckets are the picker's folders — `mail` always, Trash
   *  and Spam as opt-ins. Gmail has no `reconcile`; a narrowed bucket is
   *  archived by its `scope_root_id` stamp. */
  folderScope: true,
};

/** Threads fetched per yielded Batch — matches the task brief's "~25
 *  threads/batch". Backfill chunks a 100-thread threads.list page (Gmail API
 *  page size) into ~4 batches; the delta sweep chunks its affected-thread
 *  re-fetch the same way, so a bulk Gmail action (select-all archive touches
 *  thousands of threads in one history window) neither buffers everything in
 *  memory nor loses all progress to a mid-sweep failure. */
const THREAD_CHUNK_SIZE = 25;

export async function connect(
  auth: AuthChannel,
): Promise<{ identifier: string; config: Record<string, unknown> }> {
  auth.status('Waiting for Google sign-in…');
  // The platform (connect broker + engine) runs the OAuth window, performs
  // the code exchange via googleOAuthProfile, and PERSISTS the resulting
  // Credentials to the vault — this source never stores a token itself.
  const creds = await auth.oauth(GMAIL_SCOPES);
  if (!creds.accessToken)
    throw new Error('gmail connect: oauth did not return an access token');
  auth.status('Fetching account profile…');
  const profile = await fetchProfileWithToken(creds.accessToken);
  return {
    identifier: profile.emailAddress,
    config: { folderRoots: bucketRoots(new Set(['mail'])) },
  };
}

type OptInBucket = Exclude<GmailBucket, 'mail'>;

/** Spec §4: Trash and Spam checkboxes in the Tracked folders picker. */
export async function manageFolders(
  session: Session,
  channel: FolderSelectionChannel,
): Promise<FolderScopeUpdate<GmailCursor>> {
  const config = session.account.config ?? {};
  const current = selectedBuckets(config);
  const nodes: FolderNode[] = GMAIL_BUCKETS.map((b) => ({
    id: b,
    name: BUCKET_COPY[b].label,
    hasChildren: false,
  }));
  const picked = await channel.pickFolders({
    modes: [{ key: 'mail', label: 'Mail' }],
    multiSelect: true,
    purpose: 'manage',
    selected: nodes.filter((n) => current.has(n.id as GmailBucket)),
    roots: async () => nodes,
    children: async () => [],
  });
  const next = new Set(
    picked
      .map((n) => n.id as GmailBucket)
      .filter((id) => GMAIL_BUCKETS.includes(id)),
  );
  if (!next.has('mail')) throw new Error('gmail: All mail must stay selected');
  const optIns = GMAIL_BUCKETS.filter((b): b is OptInBucket => b !== 'mail');
  const added = optIns.filter((b) => next.has(b) && !current.has(b));
  const removed = optIns.filter((b) => current.has(b) && !next.has(b));
  return {
    config: { ...config, folderRoots: bucketRoots(next) },
    cursor: rescopeCursor(
      session.account.cursor as GmailCursor | LegacyGmailCursor | null,
      added,
      removed,
    ),
    archiveScopeRootIds: removed,
    reattributeScopeRoots: [],
  };
}

/** Re-fetches `threadIds` through the bounded pool. A 404 means the thread
 *  is gone upstream (Trash/Spam expunged, hard-deleted — routine for an
 *  `in:trash` listing) → a deletion. The catch lives INSIDE the pooled
 *  worker: one purged thread must not reject the whole chunk. */
async function fetchThreads(
  session: Session,
  threadIds: string[],
  stamp: Pick<GmailThreadItem, 'accountEmail' | 'selectedBuckets'>,
): Promise<{ items: GmailThreadItem[]; deletions: ExternalRef[] }> {
  const items: GmailThreadItem[] = [];
  const deletions: ExternalRef[] = [];
  await mapPool(threadIds, async (id) => {
    try {
      const raw = await getThread(session, id);
      items.push({ id, messages: raw.messages ?? [], ...stamp });
    } catch (err) {
      if (!isGmailNotFoundError(err)) throw err;
      deletions.push({ externalId: id, type: GMAIL_THREAD_DOCUMENT_TYPE });
    }
  });
  return { items, deletions };
}

/** One history.list sweep: pages until exhausted, collects every thread id
 *  touched by messagesAdded/messagesDeleted/labelsAdded/labelsRemoved (union
 *  — matches legacy delta.ts exactly), then re-fetches the affected threads
 *  through the same bounded pool the backfill uses, in ~25-thread chunks.
 *  A 404 on re-fetch means the thread is genuinely gone upstream (Trash/Spam
 *  expunged, hard-deleted) → reported as a deletion; anything else becomes
 *  an updated item so its document gets re-indexed.
 *
 *  Cursor discipline mirrors the backfill's hold-back rule: every
 *  intermediate chunk batch carries the OLD historyId, and only the FINAL
 *  batch (which also carries the accumulated deletions) advances to
 *  latestHistoryId. Advancing early would permanently skip the changes of
 *  threads not yet re-fetched; holding back means a mid-sweep failure just
 *  re-sweeps from the old watermark, and the re-fetch is idempotent
 *  (upserts key on externalId, archiveByRef no-ops on archived rows). */
async function* runDeltaSweep(
  session: Session,
  historyId: string,
  stamp: Pick<GmailThreadItem, 'accountEmail' | 'selectedBuckets'>,
): AsyncGenerator<Batch<GmailCursor, GmailThreadItem>> {
  const affected = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId: string | undefined;
  do {
    if (session.signal.aborted) return;
    // eslint-disable-next-line no-await-in-loop
    const page = await listHistoryPage(session, historyId, pageToken);
    for (const entry of page.history ?? []) {
      for (const arr of [
        entry.messagesAdded,
        entry.messagesDeleted,
        entry.labelsAdded,
        entry.labelsRemoved,
      ]) {
        for (const e of arr ?? []) affected.add(e.message.threadId);
      }
    }
    latestHistoryId = page.historyId ?? latestHistoryId;
    pageToken = page.nextPageToken;
  } while (pageToken);

  const finalCursor: GmailCursor = {
    v: 2,
    historyId: latestHistoryId ?? historyId,
    tasks: [],
  };
  const ids = [...affected];
  const deletions: ExternalRef[] = [];
  for (let i = 0; i < ids.length; i += THREAD_CHUNK_SIZE) {
    if (session.signal.aborted) return;
    const chunk = ids.slice(i, i + THREAD_CHUNK_SIZE);
    // eslint-disable-next-line no-await-in-loop
    const got = await fetchThreads(session, chunk, stamp);
    const { items } = got;
    deletions.push(...got.deletions);
    const isLastChunk = i + THREAD_CHUNK_SIZE >= ids.length;
    yield isLastChunk
      ? {
          phase: 'live',
          items,
          deletions: deletions.length ? deletions : undefined,
          cursor: finalCursor,
        }
      : { phase: 'live', items, cursor: { v: 2, historyId, tasks: [] } };
  }
  // No affected threads: still advance the watermark so the next sweep
  // doesn't replay the same (empty) history window.
  if (ids.length === 0) {
    yield { phase: 'live', items: [], cursor: finalCursor };
  }
}

/**
 * Works the cursor's task queue (spec §4) — each task a threads.list
 * pagination, in order — then runs exactly ONE history.list sweep from the
 * shared watermark before ending. A `null` cursor captures the watermark
 * and queues `initialTasks` for the selected buckets.
 *
 * Ending after one delta sweep (rather than polling on an internal timer
 * until `session.signal` aborts) is the deliberate choice here: legacy's
 * `runDelta()` was itself a single pass invoked once per Scheduler tick —
 * the tiered polling (30s/120s/600s by window focus) lived ENTIRELY in the
 * Scheduler, not inside runDelta. The new engine's Cadence (`every: '15m'`
 * on the descriptor) plays that same external-timer role, so ending the
 * stream here reproduces legacy's call pattern faithfully and avoids
 * building a second, redundant polling loop inside the source.
 */
export async function* pull(
  session: Session,
  cursor: GmailCursor | null,
): AsyncIterable<Batch<GmailCursor, GmailThreadItem>> {
  const selected = selectedBuckets(session.account.config ?? {});
  const stamp = {
    accountEmail: session.account.identifier,
    selectedBuckets: [...selected],
  };
  let cur = migrateGmailCursor(cursor);
  // threads.list's resultSizeEstimate is a per-PAGE guess (routinely ~200
  // for a 20k-thread mailbox) — useless as a backfill total. The profile's
  // threadsTotal is the mailbox-wide figure, so that's what progress is
  // measured against; fetched once per run that has listings to work.
  let estimateTotal: number | undefined;
  if (cur === null) {
    const profile = await fetchProfile(session);
    cur = {
      v: 2,
      historyId: profile.historyId,
      tasks: initialTasks(selected),
    };
    estimateTotal = profile.threadsTotal;
  } else if (cur.tasks.length > 0) {
    estimateTotal = (await fetchProfile(session)).threadsTotal;
  }

  while (cur.tasks.length > 0) {
    const [task, ...rest] = cur.tasks;
    let { pageToken } = task;
    do {
      if (session.signal.aborted) return;
      // eslint-disable-next-line no-await-in-loop
      const page = await listThreadsPage(session, pageToken, task.q);
      const ids = (page.threads ?? []).map((t) => t.id);
      const next = page.nextPageToken ?? null;
      // Only advance the persisted pageToken once the WHOLE page's chunks
      // are done — a restart mid-page re-fetches that page from its start
      // (idempotent re-commits by externalId), never skips. The page that
      // ends a task drops it from the queue. An empty page still yields
      // once, so a finished task is persisted even when it listed nothing.
      const pageDone: GmailCursor = {
        ...cur,
        tasks: next ? [{ ...task, pageToken: next }, ...rest] : rest,
      };
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += THREAD_CHUNK_SIZE)
        chunks.push(ids.slice(i, i + THREAD_CHUNK_SIZE));
      if (chunks.length === 0) chunks.push([]);
      for (const [i, chunk] of chunks.entries()) {
        if (session.signal.aborted) return;
        // eslint-disable-next-line no-await-in-loop
        const { items, deletions } = await fetchThreads(session, chunk, stamp);
        if (i === chunks.length - 1) cur = pageDone;
        yield {
          phase: 'backfill',
          items,
          ...(deletions.length ? { deletions } : {}),
          cursor: cur,
          estimateTotal,
        };
      }
      pageToken = next;
    } while (pageToken);
  }

  if (session.signal.aborted) return;

  try {
    // The only 404 that can escape the sweep is history.list's (per-thread
    // 404s become deletions inside it), so the catch below still means
    // exactly "history watermark expired".
    yield* runDeltaSweep(session, cur.historyId, stamp);
  } catch (err) {
    if (!isGmailNotFoundError(err)) throw err;
    // History watermark expired: fall back to a fresh backfill. Re-capture
    // the historyId now and persist the reset cursor; the listings run on
    // the NEXT pull() call (cadence-driven), through the queue above.
    session.log(
      'warn',
      'gmail delta history expired — resetting to a fresh backfill',
    );
    const { historyId } = await fetchProfile(session);
    yield {
      phase: 'backfill',
      items: [],
      cursor: { v: 2, historyId, tasks: initialTasks(selected) },
    };
  }
}

export const gmailSource: Source<GmailCursor, GmailThreadItem> = {
  descriptor,
  connect,
  pull,
  toDocument,
  manageFolders,
  async readMessageEvidence(session, doc, options) {
    if (doc.type !== GMAIL_THREAD_DOCUMENT_TYPE) return [];
    const wanted = new Set(
      options.authors
        .map(normalizeAuthor)
        .filter((author) => author.length > 0),
    );
    const limit = Math.max(0, Math.min(3, Math.floor(options.limit)));
    if (wanted.size === 0 || limit === 0) return [];

    let thread;
    try {
      thread = await getThread(session, doc.externalId);
    } catch (error) {
      if (isGmailNotFoundError(error)) return [];
      throw error;
    }
    return (
      thread.messages
        ?.map((message) => {
          const parsed = parseGmailMessage(message);
          return parsed.evidence;
        })
        .filter((evidence) => wanted.has(evidence.author))
        .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
        .slice(0, limit) ?? []
    );
  },
  async fetchBytes(session, doc) {
    const meta = doc.metadata as {
      messageId?: string;
      partId?: string;
      attachmentId?: string;
    };
    if (!meta.messageId || !meta.attachmentId) return null;
    const decode = (data: string) =>
      new Uint8Array(Buffer.from(data, 'base64url'));
    try {
      const res = await getAttachment(
        session,
        meta.messageId,
        meta.attachmentId,
      );
      if (res.data) return decode(res.data);
    } catch (err) {
      if (!isGmailNotFoundError(err)) throw err;
      // attachment ids rotate between API sessions — fall through and re-resolve
    }
    const msg = await getMessage(session, meta.messageId);
    const fresh = attachmentsOf(msg).find((a) => a.partId === meta.partId);
    if (!fresh) return null;
    const res = await getAttachment(
      session,
      meta.messageId,
      fresh.attachmentId,
    );
    return res.data ? decode(res.data) : null;
  },
};
