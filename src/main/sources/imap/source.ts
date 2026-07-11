import type {
  AuthChannel,
  Batch,
  DocumentInput,
  ExternalRef,
  PullPhase,
  Session,
  Source,
} from '@shared/contracts';
import { SourceAuthError } from '@shared/source-errors';

import { connectImapClient } from './client';
import { advanceCursor, chunk, planMailboxSync } from './cursor';
import { describeConnectError } from './errors';
import { isAutomatedMessage } from './filter';
import { resolveMailboxes } from './folders';
import { buildExternalId } from './ids';
import { parseImapMessage } from './parse';
import type {
  ImapAccountConfig,
  ImapClient,
  ImapCursor,
  ImapMessageItem,
} from './types';

/** UIDs fetched (parsed, yielded) per chunk — bounds peak memory and advances
 *  the resumable per-mailbox cursor every chunk, matching the legacy
 *  connector's BATCH constant (kiagent-ref backfill.ts). */
const BATCH_SIZE = 50;

/**
 * How often the live phase re-checks each mailbox for new mail. The legacy
 * connector never held a connection open between polls — a fresh client was
 * created and closed on every scheduler tick (kiagent-ref client.ts: "no
 * long-lived connection (no IDLE)"). The Source contract here instead expects
 * pull()'s live phase to keep yielding "until session.signal aborts" (see
 * contracts.ts), so this source holds ONE connection open for the account's
 * whole live run and polls it on an interval, rather than using imapflow's
 * idle() (which needs its own reconnect/refresh bookkeeping to run
 * indefinitely). See createImapSource's ImapSourceDeps for how tests override
 * this interval.
 */
const LIVE_POLL_INTERVAL_MS = 60_000;

export type ConnectFn = (
  config: ImapAccountConfig,
  password: string,
) => Promise<ImapClient>;
export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export interface ImapSourceDeps {
  /** Overridable for tests — fakes the imapflow-backed client entirely. */
  connect?: ConnectFn;
  /** Overridable for tests — avoids real waiting in the live poll loop. */
  sleep?: SleepFn;
  pollIntervalMs?: number;
}

/**
 * The IMAP email Source. Per-mailbox UIDVALIDITY+UID cursor; flat
 * `email.message` documents (one per message — see the module doc in
 * types.ts for why this differs from legacy's per-thread documents).
 */
export function createImapSource(
  deps: ImapSourceDeps = {},
): Source<ImapCursor, ImapMessageItem> {
  const connectFn = deps.connect ?? connectImapClient;
  const sleepFn = deps.sleep ?? defaultSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? LIVE_POLL_INTERVAL_MS;

  return {
    descriptor: {
      id: 'imap',
      name: 'Email (IMAP)',
      documentTypes: ['email.message'],
      auth: 'password',
      multiAccount: true,
      cadence: { every: '15m' },
    },

    async connect(auth: AuthChannel) {
      const answers = await auth.prompt({
        type: 'object',
        required: ['host', 'user', 'password'],
        description:
          'Connect any IMAP mailbox. Read-only; the password is stored in your OS keychain.',
        properties: {
          host: {
            type: 'string',
            title: 'IMAP server hostname',
            examples: ['imap.example.com'],
            description: 'Ask your email provider if unsure.',
          },
          port: {
            type: 'number',
            title: 'Port (defaults to 993 for TLS, 143 for STARTTLS)',
            examples: ['993'],
          },
          secure: { type: 'boolean', title: 'Use TLS', default: true },
          user: {
            type: 'string',
            title: 'Username / email address',
            examples: ['you@example.com'],
          },
          password: {
            type: 'string',
            title: 'Password or app-password',
            format: 'password',
            description:
              'Providers with 2FA (Gmail, Fastmail, iCloud) require an app-password, not your login password.',
          },
        },
      });

      const host = typeof answers.host === 'string' ? answers.host.trim() : '';
      const user = typeof answers.user === 'string' ? answers.user.trim() : '';
      const password =
        typeof answers.password === 'string' ? answers.password : '';
      if (!host || !user || !password) {
        throw new Error('imap: host, user and password are required');
      }
      const secure =
        answers.secure === undefined ? true : Boolean(answers.secure);
      const port =
        typeof answers.port === 'number' && answers.port > 0
          ? answers.port
          : secure
            ? 993
            : 143;

      const config: ImapAccountConfig = { host, port, secure, user };

      let client: ImapClient | undefined;
      try {
        client = await connectFn(config, password);
        const folders = await client.listFolders();
        if (resolveMailboxes(folders).length === 0) {
          throw new Error(
            'imap: connected, but found no mail folders to sync (expected INBOX or an All-Mail folder)',
          );
        }
      } catch (e) {
        throw new Error(describeConnectError(e));
      } finally {
        await client?.close().catch(() => {});
      }

      return {
        identifier: `${user}@${host}`,
        config: config as unknown as Record<string, unknown>,
      };
    },

    async *pull(session: Session, cursor: ImapCursor | null) {
      const config = session.account.config as unknown as ImapAccountConfig;
      const creds = await session.credentials();
      if (!creds?.password) {
        // Retrying can't conjure a credential — reauth is the only fix.
        throw new SourceAuthError(
          'imap: account has no stored password credential',
        );
      }

      let client: ImapClient;
      try {
        client = await connectFn(config, creds.password);
      } catch (e) {
        // imapflow reports auth failures in a structured field, not the
        // message (see describeConnectError). But it sets authenticationFailed
        // on EVERY rejected LOGIN — including temporary server conditions
        // (RFC 5530 [UNAVAILABLE]/[INUSE]/[LIMIT]: auth backend down, too many
        // connections). Only a genuine credential rejection is 'needsReauth'
        // (which nothing auto-retries); the transient codes must keep the
        // plain-Error path so the retry+supervisor machinery self-heals once
        // the throttle lifts. imapflow puts the bracketed code on
        // serverResponseCode (uppercased).
        const err = e as {
          authenticationFailed?: boolean;
          serverResponseCode?: string;
        };
        const respCode = err.serverResponseCode?.toUpperCase();
        const transient =
          respCode === 'UNAVAILABLE' ||
          respCode === 'INUSE' ||
          respCode === 'LIMIT';
        if (err.authenticationFailed === true && !transient) {
          throw new SourceAuthError(describeConnectError(e));
        }
        throw new Error(describeConnectError(e));
      }
      try {
        const folders = await client.listFolders();
        const mailboxes = resolveMailboxes(folders).map((f) => f.path);
        if (mailboxes.length === 0) {
          throw new Error(
            'imap: no syncable mailboxes found (expected INBOX/All Mail and/or Sent)',
          );
        }

        let cur: ImapCursor = cursor ?? { mailboxes: {} };
        const isFreshAccount = cursor === null;

        // A brand-new account backfills; combine every mailbox's message
        // count into one account-wide progress estimate, matching legacy's
        // single progress bar (kiagent-ref backfill.ts) rather than one that
        // resets per mailbox.
        let combinedTotal: number | undefined;
        if (isFreshAccount) {
          combinedTotal = 0;
          for (const path of mailboxes) {
            if (session.signal.aborted) return;
            combinedTotal += (await client.status(path)).exists;
          }
        }

        // First pass: bring every mailbox forward from its persisted cursor.
        // On a fresh account this IS the backfill; on a returning account
        // it's a (usually empty) catch-up; a UIDVALIDITY change forces a
        // from-scratch resync regardless (planMailboxSync.reset).
        for (const path of mailboxes) {
          if (session.signal.aborted) return;
          for await (const batch of syncMailboxOnce(
            client,
            path,
            cur,
            isFreshAccount ? 'backfill' : 'live',
            session,
            combinedTotal,
          )) {
            cur = batch.cursor;
            yield batch;
            if (session.signal.aborted) return;
          }
        }

        // Live phase: poll each mailbox for new mail until the engine aborts
        // this session (see LIVE_POLL_INTERVAL_MS doc above for why poll
        // instead of imapflow idle()).
        for (;;) {
          if (session.signal.aborted) return;
          for (const path of mailboxes) {
            if (session.signal.aborted) return;
            for await (const batch of syncMailboxOnce(
              client,
              path,
              cur,
              'live',
              session,
            )) {
              cur = batch.cursor;
              yield batch;
              if (session.signal.aborted) return;
            }
          }
          await sleepFn(pollIntervalMs, session.signal);
        }
      } finally {
        await client.close().catch(() => {});
      }
    },

    toDocument(item: ImapMessageItem): DocumentInput | null {
      const filt = isAutomatedMessage(item.headers, item.from ?? '');
      if (filt.matched) return null;

      const subject = item.subject?.trim() || '(no subject)';

      return {
        externalId: buildExternalId(item.mailbox, item.uidValidity, item.uid),
        type: 'email.message',
        title: subject,
        markdown: item.bodyText,
        metadata: {
          from: item.from,
          to: item.to,
          date: item.date,
          mailbox: item.mailbox,
          uid: item.uid,
          messageId: item.messageId,
        },
        createdAt: item.date,
        url: undefined,
      };
    },

    async *reconcile(session: Session) {
      const config = session.account.config as unknown as ImapAccountConfig;
      const creds = await session.credentials();
      if (!creds?.password) {
        throw new Error('imap: account has no stored password credential');
      }

      const client = await connectFn(config, creds.password);
      try {
        const folders = await client.listFolders();
        const mailboxes = resolveMailboxes(folders).map((f) => f.path);
        for (const path of mailboxes) {
          if (session.signal.aborted) return;
          const status = await client.status(path);
          const uids = await client.listUids(path);
          const refs: ExternalRef[] = uids.map((uid) => ({
            externalId: buildExternalId(path, String(status.uidValidity), uid),
            type: 'email.message',
          }));
          for (const page of chunk(refs.length ? refs : [], 500)) {
            if (session.signal.aborted) return;
            yield page;
          }
        }
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}

/**
 * (Re)sync one mailbox forward from its cursor entry, yielding a Batch per
 * fetch chunk. Shared by both the first pass and each live-phase poll: a
 * UIDVALIDITY change detected mid-live-loop is handled exactly like a fresh
 * backfill (phase forced to 'backfill', full resync from UID 0).
 */
async function* syncMailboxOnce(
  client: ImapClient,
  path: string,
  cur: ImapCursor,
  defaultPhase: PullPhase,
  session: Session,
  totalEstimateOverride?: number,
): AsyncGenerator<Batch<ImapCursor, ImapMessageItem>> {
  const status = await client.status(path);
  const prev = cur.mailboxes[path];
  const presentUids = await client.listUids(path);
  const plan = planMailboxSync(prev, status.uidValidity, presentUids);

  if (plan.reset) {
    session.log(
      'warn',
      `imap: UIDVALIDITY changed for "${path}" — resyncing from scratch`,
    );
  }
  const phase: PullPhase = plan.reset ? 'backfill' : defaultPhase;
  const estimateTotal =
    phase === 'backfill' ? (totalEstimateOverride ?? status.exists) : undefined;

  if (plan.uidsToFetch.length === 0) {
    // Floor the cursor so an empty (or newly-reset) mailbox still gets a
    // baseline entry for future delta comparisons, even with zero messages.
    if (!prev || plan.reset) {
      yield {
        phase,
        items: [],
        cursor: advanceCursor(cur, path, status.uidValidity, 0),
        estimateTotal,
      };
    }
    return;
  }

  let cursorNow = cur;
  for (const uidChunk of chunk(plan.uidsToFetch, BATCH_SIZE)) {
    const raws = await client.fetchMany(path, uidChunk);
    const items: ImapMessageItem[] = [];
    for (const raw of raws) {
      try {
        items.push(await parseImapMessage(raw, path, status.uidValidity));
      } catch (e) {
        session.log(
          'warn',
          `imap: failed to parse ${path} uid=${raw.uid}: ${String(e)}`,
        );
      }
    }
    const lastUid = Math.max(...uidChunk);
    cursorNow = advanceCursor(cursorNow, path, status.uidValidity, lastUid);
    yield { phase, items, cursor: cursorNow, estimateTotal };
  }
}
