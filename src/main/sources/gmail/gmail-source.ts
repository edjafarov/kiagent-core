import type {
  AuthChannel,
  Batch,
  ExternalRef,
  Session,
  Source,
  SourceDescriptor,
} from '@shared/contracts';

import { type GmailCursor, isGmailNotFoundError } from './cursor';
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
import { attachmentsOf } from './parser';
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
): Promise<{ identifier: string }> {
  auth.status('Waiting for Google sign-in…');
  // The platform (connect broker + engine) runs the OAuth window, performs
  // the code exchange via googleOAuthProfile, and PERSISTS the resulting
  // Credentials to the vault — this source never stores a token itself.
  const creds = await auth.oauth(GMAIL_SCOPES);
  if (!creds.accessToken)
    throw new Error('gmail connect: oauth did not return an access token');
  auth.status('Fetching account profile…');
  const profile = await fetchProfileWithToken(creds.accessToken);
  return { identifier: profile.emailAddress };
}

async function fetchThreadItems(
  session: Session,
  threadIds: string[],
  accountEmail: string,
): Promise<GmailThreadItem[]> {
  const raw = await mapPool(threadIds, (id) => getThread(session, id));
  return raw.map((t, i) => ({
    id: t.id ?? threadIds[i],
    messages: t.messages ?? [],
    accountEmail,
  }));
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
  state: Extract<GmailCursor, { mode: 'delta' }>,
  accountEmail: string,
): AsyncGenerator<Batch<GmailCursor, GmailThreadItem>> {
  const affected = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId: string | undefined;
  do {
    if (session.signal.aborted) return;
    // eslint-disable-next-line no-await-in-loop
    const page = await listHistoryPage(session, state.historyId, pageToken);
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
    mode: 'delta',
    historyId: latestHistoryId ?? state.historyId,
  };
  const ids = [...affected];
  const deletions: ExternalRef[] = [];
  for (let i = 0; i < ids.length; i += THREAD_CHUNK_SIZE) {
    if (session.signal.aborted) return;
    const chunk = ids.slice(i, i + THREAD_CHUNK_SIZE);
    const items: GmailThreadItem[] = [];
    // The 404→deletion catch lives INSIDE the pooled worker: one
    // hard-deleted thread must not reject the whole chunk.
    // eslint-disable-next-line no-await-in-loop
    await mapPool(chunk, async (threadId) => {
      try {
        const raw = await getThread(session, threadId);
        items.push({
          id: threadId,
          messages: raw.messages ?? [],
          accountEmail,
        });
      } catch (err) {
        if (!isGmailNotFoundError(err)) throw err;
        deletions.push({
          externalId: threadId,
          type: GMAIL_THREAD_DOCUMENT_TYPE,
        });
      }
    });
    const isLastChunk = i + THREAD_CHUNK_SIZE >= ids.length;
    yield isLastChunk
      ? {
          phase: 'live',
          items,
          deletions: deletions.length ? deletions : undefined,
          cursor: finalCursor,
        }
      : { phase: 'live', items, cursor: state };
  }
  // No affected threads: still advance the watermark so the next sweep
  // doesn't replay the same (empty) history window.
  if (ids.length === 0) {
    yield { phase: 'live', items: [], cursor: finalCursor };
  }
}

/**
 * `null` cursor (or a resumed `backfill` cursor) drives threads.list
 * pagination; once exhausted the cursor flips to `delta` and this generator
 * runs exactly ONE history.list sweep before ending.
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
  const accountEmail = session.account.identifier;
  let state: GmailCursor;
  // threads.list's resultSizeEstimate is a per-PAGE guess (routinely ~200
  // for a 20k-thread mailbox) — useless as a backfill total. The profile's
  // threadsTotal is the mailbox-wide figure, so that's what progress is
  // measured against; fetched once per backfill run (a resumed backfill
  // re-fetches it, since only the null-cursor path needs the historyId).
  let estimateTotal: number | undefined;
  if (cursor === null) {
    const profile = await fetchProfile(session);
    state = { mode: 'backfill', pageToken: null, historyId: profile.historyId };
    estimateTotal = profile.threadsTotal;
  } else {
    state = cursor;
    if (state.mode === 'backfill') {
      estimateTotal = (await fetchProfile(session)).threadsTotal;
    }
  }

  if (state.mode === 'backfill') {
    const { historyId } = state;
    let { pageToken } = state;
    do {
      if (session.signal.aborted) return;
      // eslint-disable-next-line no-await-in-loop
      const page = await listThreadsPage(session, pageToken);
      const ids = (page.threads ?? []).map((t) => t.id);
      for (let i = 0; i < ids.length; i += THREAD_CHUNK_SIZE) {
        if (session.signal.aborted) return;
        const chunk = ids.slice(i, i + THREAD_CHUNK_SIZE);
        const isLastChunkOfPage = i + THREAD_CHUNK_SIZE >= ids.length;
        // eslint-disable-next-line no-await-in-loop
        const items = await fetchThreadItems(session, chunk, accountEmail);
        state = {
          mode: 'backfill',
          // Only advance the persisted pageToken once the WHOLE page's
          // chunks are done — a restart mid-page re-fetches that page from
          // its start (idempotent re-commits by externalId), never skips.
          pageToken: isLastChunkOfPage
            ? (page.nextPageToken ?? null)
            : pageToken,
          historyId,
        };
        yield {
          phase: 'backfill',
          items,
          cursor: state,
          estimateTotal,
        };
      }
      pageToken = page.nextPageToken ?? null;
    } while (pageToken);
    state = { mode: 'delta', historyId };
  }

  if (session.signal.aborted) return;

  try {
    // The only 404 that can escape the sweep is history.list's (per-thread
    // 404s become deletions inside it), so the catch below still means
    // exactly "history watermark expired".
    yield* runDeltaSweep(session, state, accountEmail);
  } catch (err) {
    if (!isGmailNotFoundError(err)) throw err;
    // History watermark expired: fall back to a fresh backfill. Re-capture
    // the historyId now and persist the reset cursor; the actual
    // re-pagination happens on the NEXT pull() call (cadence-driven),
    // reusing the backfill branch above instead of duplicating it here.
    session.log(
      'warn',
      'gmail delta history expired — resetting to a fresh backfill',
    );
    const { historyId } = await fetchProfile(session);
    yield {
      phase: 'backfill',
      items: [],
      cursor: { mode: 'backfill', pageToken: null, historyId },
    };
  }
}

export const gmailSource: Source<GmailCursor, GmailThreadItem> = {
  descriptor,
  connect,
  pull,
  toDocument,
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
