import type { Session } from '@shared/contracts';

import { bearerFetch } from './bearer-fetch';
import type { GmailApiMessage } from './parser';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Gmail's per-user quota is 250 quota units/sec; threads.get is 10 units.
// Concurrency 4 stays comfortably under that even with the shorter batches
// this port uses (~25 threads/batch vs legacy's 500-thread pages).
const THREAD_FETCH_CONCURRENCY = 4;

async function tokenFor(session: Session): Promise<string> {
  const creds = await session.credentials();
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

export function listThreadsPage(
  session: Session,
  pageToken: string | null,
): Promise<ThreadsListPage> {
  const url = new URL(`${BASE}/threads`);
  url.searchParams.set('maxResults', String(THREADS_PAGE_SIZE));
  if (pageToken) url.searchParams.set('pageToken', pageToken);
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
