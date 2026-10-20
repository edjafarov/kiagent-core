import type { Credentials, Session } from '@shared/contracts';

import { bearerFetch } from './bearer-fetch';
import type { GmailApiMessage } from './parser';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Gmail's per-user quota is 250 quota units/sec; threads.get is 10 units.
// Concurrency 4 stays comfortably under that even with the shorter batches
// this port uses (~25 threads/batch vs legacy's 500-thread pages).
const THREAD_FETCH_CONCURRENCY = 4;

// Loosened beyond `Session`: the outbound Sender that calls sendGmailMessage
// is not a pull Session (no `account`/`signal`/`log`) — it only ever needs
// the credentials verb.
async function tokenFor(auth: {
  credentials(): Promise<Credentials | null>;
}): Promise<string> {
  const creds = await auth.credentials();
  if (!creds?.accessToken)
    throw new Error('gmail: no credentials available for account');
  return creds.accessToken;
}

function fetchGmail<T>(session: Session, url: string): Promise<T> {
  return bearerFetch<T>(url, () => tokenFor(session), {
    errorPrefix: 'gmail',
    logTag: '[gmail]',
    signal: session.signal,
  });
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
  threadsTotal?: number;
  messagesTotal?: number;
}

export function fetchProfile(session: Session): Promise<GmailProfile> {
  return fetchGmail<GmailProfile>(session, `${BASE}/profile`);
}

/** Used only during `connect()`, before an Account/Session exists — takes a
 *  bare access token instead of a Session. */
export function fetchProfileWithToken(
  accessToken: string,
): Promise<GmailProfile> {
  return bearerFetch<GmailProfile>(`${BASE}/profile`, async () => accessToken, {
    errorPrefix: 'gmail',
  });
}

export interface ThreadsListPage {
  threads?: { id: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

const THREADS_PAGE_SIZE = 100;

/** `q` is a bucket query (`in:trash` / `in:spam`); Gmail returns nothing
 *  for it unless `includeSpamTrash` is set too, so one implies the other.
 *  No `q` lists the full scope — everything outside Trash and Spam. */
export function listThreadsPage(
  session: Session,
  pageToken: string | null,
  q?: string | null,
): Promise<ThreadsListPage> {
  const url = new URL(`${BASE}/threads`);
  url.searchParams.set('maxResults', String(THREADS_PAGE_SIZE));
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  if (q) {
    url.searchParams.set('q', q);
    url.searchParams.set('includeSpamTrash', 'true');
  }
  return fetchGmail<ThreadsListPage>(session, url.toString());
}

export interface RawThread {
  id: string;
  messages?: GmailApiMessage[];
}

export function getThread(
  session: Session,
  threadId: string,
): Promise<RawThread> {
  return fetchGmail<RawThread>(
    session,
    `${BASE}/threads/${threadId}?format=full`,
  );
}

export interface HistoryEntry {
  messagesAdded?: { message: { threadId: string } }[];
  messagesDeleted?: { message: { threadId: string } }[];
  labelsAdded?: { message: { threadId: string } }[];
  labelsRemoved?: { message: { threadId: string } }[];
}

export interface HistoryListPage {
  history?: HistoryEntry[];
  historyId?: string;
  nextPageToken?: string;
}

export function listHistoryPage(
  session: Session,
  startHistoryId: string,
  pageToken?: string,
): Promise<HistoryListPage> {
  const url = new URL(`${BASE}/history`);
  url.searchParams.set('startHistoryId', startHistoryId);
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return fetchGmail<HistoryListPage>(session, url.toString());
}

/** Bounded-concurrency map, preserving input order in the result array.
 *  Ported in spirit from legacy shared/pool.ts `runInPool`. */
export async function mapPool<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number = THREAD_FETCH_CONCURRENCY,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export interface AttachmentBody {
  size: number;
  data?: string; // base64url
}

export function getAttachment(
  session: Session,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentBody> {
  return fetchGmail(
    session,
    `${BASE}/messages/${messageId}/attachments/${encodeURIComponent(attachmentId)}`,
  );
}

export function getMessage(
  session: Session,
  id: string,
): Promise<GmailApiMessage> {
  return fetchGmail(session, `${BASE}/messages/${id}?format=full`);
}

/** One page of `users.messages.list` for a search query, Spam and Trash
 *  included. */
export function listMessagesPage(
  session: Session,
  q: string,
  pageToken?: string,
): Promise<{ messages?: Array<{ id: string }>; nextPageToken?: string }> {
  const u = new URL(`${BASE}/messages`);
  u.searchParams.set('q', q);
  u.searchParams.set('includeSpamTrash', 'true');
  u.searchParams.set('maxResults', '100');
  if (pageToken) u.searchParams.set('pageToken', pageToken);
  return fetchGmail(session, u.toString());
}

export function getMessageMetadata(
  session: Session,
  id: string,
  headers: readonly string[],
): Promise<GmailApiMessage> {
  const u = new URL(`${BASE}/messages/${encodeURIComponent(id)}`);
  u.searchParams.set('format', 'metadata');
  for (const h of headers) u.searchParams.append('metadataHeaders', h);
  return fetchGmail(session, u.toString());
}

export interface GmailSendResult {
  id: string;
  threadId: string;
}

const SEND_RETRY_MARKERS =
  /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i;

/** Send-safe retry predicate: ONLY proven request-rejections. A 429 or a
 *  quota-403 means Google refused the request — nothing was sent, so a
 *  retry can never double-deliver. Everything else (5xx, other 403s,
 *  network errors, timeouts) is ambiguous and must fail fast. */
export function isSendSafeRetry(status: number, body: string): boolean {
  return status === 429 || (status === 403 && SEND_RETRY_MARKERS.test(body));
}

/** POST users/me/messages/send. `raw` is the full RFC822 message; `threadId`
 *  (the Gmail API thread id, NOT an RFC Message-ID) threads the reply.
 *  Retried ONLY via isSendSafeRetry (quota/rate rejections, with backoff +
 *  Retry-After via bearerFetch, capped at 10s/wait via maxRetryDelayMs so a
 *  large Retry-After can't stall the confirm page for minutes/hours); never
 *  on ambiguous failures — a retried timeout/5xx could double-deliver.
 *  Worst case across the 4 attempts: a 30s per-attempt timeout plus up to
 *  10s per backoff wait. */
/** Above this the message goes through the media-upload endpoint (35 MB
 *  limit) instead of a base64 JSON body. */
const SEND_UPLOAD_ABOVE = 4 * 1024 * 1024;

/** One RFC822 message to a Gmail endpoint that takes it either as a base64
 *  JSON field or (large) through the media-upload twin of the same path.
 *  `wrap` places `raw` into the JSON body; `meta` is the JSON part of the
 *  upload form. */
function rawRequest<T>(
  auth: { credentials(): Promise<Credentials | null> },
  req: {
    path: string;
    method: 'POST' | 'PUT';
    raw: Buffer;
    meta: Record<string, unknown>;
    wrap: (raw: string) => Record<string, unknown>;
    nonIdempotent: boolean;
  },
): Promise<T> {
  const upload = req.raw.length > SEND_UPLOAD_ABOVE;
  const boundary = `kia-${Date.now().toString(36)}`;
  return bearerFetch<T>(
    upload
      ? `${BASE.replace('/gmail/v1/', '/upload/gmail/v1/')}${req.path}?uploadType=multipart`
      : `${BASE}${req.path}`,
    () => tokenFor(auth),
    {
      errorPrefix: 'gmail',
      logTag: '[gmail]',
      method: req.method,
      contentType: upload
        ? `multipart/related; boundary=${boundary}`
        : 'application/json',
      body: upload
        ? Buffer.concat([
            Buffer.from(
              `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(req.meta)}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
            ),
            req.raw,
            Buffer.from(`\r\n--${boundary}--`),
          ])
        : JSON.stringify(req.wrap(req.raw.toString('base64url'))),
      maxAttempts: 4,
      timeoutMs: upload ? 180_000 : 30_000,
      ...(req.nonIdempotent
        ? { retryNetErrors: false, retryOn: isSendSafeRetry }
        : {}),
      maxRetryDelayMs: 10_000,
    },
  );
}

export function sendGmailMessage(
  auth: { credentials(): Promise<Credentials | null> },
  raw: Buffer,
  threadId?: string,
): Promise<GmailSendResult> {
  const meta = threadId ? { threadId } : {};
  return rawRequest(auth, {
    path: '/messages/send',
    method: 'POST',
    raw,
    meta,
    wrap: (r) => ({ raw: r, ...meta }),
    nonIdempotent: true,
  });
}

// ── Drafts (the Outbox mirror) ────────────────────────────────────────────

export interface GmailDraft {
  id: string;
  message: GmailApiMessage & { raw?: string };
}

type Auth = { credentials(): Promise<Credentials | null> };

/** drafts.create. Retried only on proven rejections — a retried timeout
 *  could leave two drafts. */
export function createGmailDraft(
  auth: Auth,
  raw: Buffer,
  threadId?: string,
): Promise<GmailDraft> {
  const message = threadId ? { threadId } : {};
  return rawRequest(auth, {
    path: '/drafts',
    method: 'POST',
    raw,
    meta: { message },
    wrap: (r) => ({ message: { raw: r, ...message } }),
    nonIdempotent: true,
  });
}

/** drafts.update replaces the whole draft message (idempotent). */
export function updateGmailDraft(
  auth: Auth,
  id: string,
  raw: Buffer,
  threadId?: string,
): Promise<GmailDraft> {
  const message = threadId ? { threadId } : {};
  return rawRequest(auth, {
    path: `/drafts/${encodeURIComponent(id)}`,
    method: 'PUT',
    raw,
    meta: { id, message },
    wrap: (r) => ({ id, message: { raw: r, ...message } }),
    nonIdempotent: false,
  });
}

/** drafts.get; null when the draft no longer exists (sent or deleted). */
export async function getGmailDraft(
  auth: Auth,
  id: string,
  format: 'full' | 'raw',
): Promise<GmailDraft | null> {
  try {
    return await bearerFetch<GmailDraft>(
      `${BASE}/drafts/${encodeURIComponent(id)}?format=${format}`,
      () => tokenFor(auth),
      {
        errorPrefix: 'gmail',
        logTag: '[gmail]',
        maxAttempts: 3,
        timeoutMs: 30_000,
        maxRetryDelayMs: 5_000,
      },
    );
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** drafts.delete; an already-missing draft counts as deleted. */
export async function deleteGmailDraft(auth: Auth, id: string): Promise<void> {
  try {
    await bearerFetch<unknown>(
      `${BASE}/drafts/${encodeURIComponent(id)}`,
      () => tokenFor(auth),
      {
        errorPrefix: 'gmail',
        logTag: '[gmail]',
        method: 'DELETE',
        responseType: 'text',
        maxAttempts: 3,
        timeoutMs: 30_000,
        maxRetryDelayMs: 5_000,
      },
    );
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}

/** drafts.send — the same retry rule as messages.send. */
export function sendGmailDraft(
  auth: Auth,
  id: string,
): Promise<GmailSendResult> {
  return bearerFetch<GmailSendResult>(
    `${BASE}/drafts/send`,
    () => tokenFor(auth),
    {
      errorPrefix: 'gmail',
      logTag: '[gmail]',
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ id }),
      maxAttempts: 4,
      timeoutMs: 60_000,
      retryNetErrors: false,
      retryOn: isSendSafeRetry,
      maxRetryDelayMs: 10_000,
    },
  );
}

function isNotFound(e: unknown): boolean {
  return e instanceof Error && /^gmail 404 /.test(e.message);
}
