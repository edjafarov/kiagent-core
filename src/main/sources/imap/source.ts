import type {
  AuthChannel,
  Batch,
  Document,
  DocumentInput,
  ExternalRef,
  FolderNode,
  FolderScopeUpdate,
  FolderSelectionChannel,
  PullPhase,
  Session,
  Source,
} from '@shared/contracts';
import { SourceAuthError } from '@shared/source-errors';

import { connectImapClient } from './client';
import {
  advanceCursor,
  chunk,
  generationRefs,
  planMailboxSync,
} from './cursor';
import { describeConnectError } from './errors';
import { isAutomatedMessage } from './filter';
import { buildExternalId } from './ids';
import { attachmentContent, parseImapMessage } from './parse';
import {
  defaultRoots,
  pickerModel,
  resolveScopedMailboxes,
  rootsOf,
  validateSelection,
} from './scope';
import type { ScopedMailbox } from './scope';
import { normalizeAuthor } from '../email-evidence';
import type {
  ImapAccountConfig,
  ImapClient,
  ImapCursor,
  ImapFolderInfo,
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

/** The live loop re-LISTs the account's folders every N polls (~15 min at
 *  the default interval) so a folder created under a ticked root is picked
 *  up without a restart. */
const RELIST_EVERY_POLLS = 15;

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

/** Connect and classify a failure: only a genuine credential rejection is
 *  auth ('needsReauth'); everything else stays a retryable plain Error. */
async function openClient(
  connectFn: ConnectFn,
  config: ImapAccountConfig,
  password: string,
): Promise<ImapClient> {
  try {
    return await connectFn(config, password);
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
}

export interface ImapSourceDeps {
  /** Overridable for tests — fakes the imapflow-backed client entirely. */
  connect?: ConnectFn;
  /** Overridable for tests — avoids real waiting in the live poll loop. */
  sleep?: SleepFn;
  pollIntervalMs?: number;
  /** Overridable for tests — polls between live-phase folder re-LISTs. */
  relistEveryPolls?: number;
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
  const relistEveryPolls = deps.relistEveryPolls ?? RELIST_EVERY_POLLS;
  // One raw message kept between fetchBytes calls: a mail's attachments sit
  // next to each other on the feed, so an N-attachment mail downloads once.
  // Safe to reuse — under one UIDVALIDITY a UID's content never changes.
  let lastRaw: { key: string; source: Buffer } | null = null;

  return {
    descriptor: {
      id: 'imap',
      name: 'Email (IMAP)',
      documentTypes: ['email.message', 'attachment'],
      auth: 'password',
      multiAccount: true,
      cadence: { every: '15m' },
      folderScope: true,
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
      let folders: ImapFolderInfo[];
      try {
        client = await connectFn(config, password);
        folders = await client.listFolders();
        if (resolveScopedMailboxes(folders, null).length === 0) {
          throw new Error(
            'imap: connected, but found no mail folders to sync (expected INBOX or an All-Mail folder)',
          );
        }
      } catch (e) {
        throw new Error(describeConnectError(e));
      } finally {
        await client?.close().catch(() => {});
      }

      // No picker here: Reconnect re-runs connect(), and a picker would reset
      // the user's selection. Manage folders is the only picker entry.
      return {
        identifier: `${user}@${host}`,
        config: {
          ...config,
          folderRoots: defaultRoots(folders),
        } as unknown as Record<string, unknown>,
      };
    },

    async manageFolders(
      session: Session,
      channel: FolderSelectionChannel,
    ): Promise<FolderScopeUpdate<ImapCursor>> {
      const config = session.account.config ?? {};
      const creds = await session.credentials();
      if (!creds?.password) {
        throw new SourceAuthError(
          'imap: account has no stored password credential',
        );
      }
      // One LIST, then close: no network once the picker is open or after.
      const client = await openClient(
        connectFn,
        config as unknown as ImapAccountConfig,
        creds.password,
      );
      let folders: ImapFolderInfo[];
      try {
        folders = await client.listFolders();
      } finally {
        await client.close().catch(() => {});
      }

      const model = pickerModel(folders);
      // Only ids the model offers are preselected: a vanished folder is not.
      const selectedIds = (rootsOf(config) ?? defaultRoots(folders))
        .map((r) => r.id)
        .filter((id) => model.node(id));
      const picked = await channel.pickFolders({
        modes: [{ key: 'mail', label: 'Mail' }],
        multiSelect: true,
        purpose: 'manage',
        selected: selectedIds.map((id) => model.node(id) as FolderNode),
        expand: model.expand(selectedIds),
        note: 'Mail in folders you untick is removed from kia.',
        roots: async () => model.roots,
        children: async (id) => model.children(id),
      });

      const folderRoots = validateSelection(
        folders,
        picked.map((n) => n.id),
      );

      const after = new Set(
        resolveScopedMailboxes(folders, folderRoots).map((m) => m.path),
      );
      const prev = (session.account.cursor as ImapCursor | null) ?? null;
      const kept: ImapCursor['mailboxes'] = {};
      const archiveRefs: ExternalRef[] = [];
      for (const [path, entry] of Object.entries(prev?.mailboxes ?? {})) {
        if (after.has(path)) kept[path] = entry;
        else archiveRefs.push(...generationRefs(path, entry));
      }
      return {
        config: { ...config, folderRoots },
        cursor: prev ? { mailboxes: kept } : null,
        archiveScopeRootIds: [],
        archiveRefs,
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

      const client = await openClient(connectFn, config, creds.password);
      try {
        const declared = rootsOf(config as unknown as Record<string, unknown>);
        let mailboxes = resolveScopedMailboxes(
          await client.listFolders(),
          declared,
        );
        if (mailboxes.length === 0) {
          throw new Error(
            'imap: no syncable mailboxes found (expected INBOX/All Mail and/or Sent)',
          );
        }

        let cur: ImapCursor = cursor ?? { mailboxes: {} };

        // Bring every mailbox forward from its persisted cursor. A mailbox
        // with NO entry (fresh account, newly ticked or newly discovered
        // folder) is a backfill; the engine's progress is account-wide, so
        // its estimate is the sum over ALL resolved mailboxes.
        const sweep = async function* (): AsyncGenerator<
          Batch<ImapCursor, ImapMessageItem>
        > {
          let total: number | undefined;
          if (mailboxes.some((m) => !cur.mailboxes[m.path])) {
            total = 0;
            for (const m of mailboxes) {
              if (session.signal.aborted) return;
              total += (await client.status(m.path)).exists;
            }
          }
          for (const mb of mailboxes) {
            if (session.signal.aborted) return;
            for await (const batch of syncMailboxOnce(
              client,
              mb,
              cur,
              cur.mailboxes[mb.path] ? 'live' : 'backfill',
              session,
              total,
            )) {
              cur = batch.cursor;
              yield batch;
              if (session.signal.aborted) return;
            }
          }
        };

        // First pass (a UIDVALIDITY change forces a from-scratch resync of
        // that mailbox regardless: planMailboxSync.reset).
        for await (const batch of sweep()) yield batch;

        // Heartbeat: one empty batch per session, right after the catch-up
        // pass. This is the ONLY commit a quiet account ever produces — no
        // new mail means syncMailboxOnce yields nothing, reconcile() with no
        // deletions commits nothing, and the live loop below never returns,
        // so the engine's end-of-pull commit is unreachable by design.
        // Without it the engine cannot tell a healthy connection from a dead
        // one: a stale `error` (and the Sources error card, which is keyed on
        // the committed status) survives every reconnect AND every manual
        // Retry until mail happens to arrive, and the engine's retry counter
        // — reset only on a batch commit — keeps climbing across socket
        // deaths HOURS apart until it hits SOURCE_MAX_RETRIES and parks the
        // account. Carries the cursor forward untouched, with no
        // estimateTotal, so it reads as "connected and caught up" and never
        // as sync progress.
        if (session.signal.aborted) return;
        yield { phase: 'live', items: [], cursor: cur };

        // Live phase: poll each mailbox for new mail until the engine aborts
        // this session (see LIVE_POLL_INTERVAL_MS doc above for why poll
        // instead of imapflow idle()).
        let polls = 0;
        for (;;) {
          if (session.signal.aborted) return;
          if (polls > 0 && polls % relistEveryPolls === 0) {
            const next = resolveScopedMailboxes(
              await client.listFolders(),
              declared,
            );
            // Never throw mid-live over an odd LIST: keep the last good set.
            if (next.length === 0) {
              session.log(
                'warn',
                'imap: folder re-list resolved to no mailboxes — keeping the previous set',
              );
            } else {
              mailboxes = next;
            }
          }
          for await (const batch of sweep()) yield batch;
          await sleepFn(pollIntervalMs, session.signal);
          polls += 1;
        }
      } finally {
        await client.close().catch(() => {});
      }
    },

    toDocument(item: ImapMessageItem): DocumentInput | DocumentInput[] | null {
      const filt = isAutomatedMessage(item.headers, item.from ?? '');
      if (filt.matched) return null;

      const subject = item.subject?.trim() || '(no subject)';
      const metadata: Record<string, unknown> = {
        from: item.from,
        to: item.to,
        cc: item.cc,
        replyTo: item.replyTo,
        references: item.references,
        date: item.date,
        mailbox: item.mailbox,
        uid: item.uid,
        messageId: item.messageId,
      };
      if (item.evidence?.author) {
        metadata.contactEvidence = {
          version: 1 as const,
          messages: [item.evidence],
        };
      }

      const messageExternalId = buildExternalId(
        item.mailbox,
        item.uidValidity,
        item.uid,
      );
      const message: DocumentInput = {
        externalId: messageExternalId,
        type: 'email.message',
        title: subject,
        markdown: item.bodyText,
        metadata,
        createdAt: item.date,
        url: undefined,
        ...(item.scopeRootId !== undefined && {
          scopeRootId: item.scopeRootId,
        }),
      };
      // Bytes-less children: the convert worker (and vision, for images and
      // scans) pull the bytes back through fetchBytes.
      const attachments: DocumentInput[] = (item.attachments ?? []).map(
        (att) => ({
          externalId: `${messageExternalId}#${att.index}`,
          type: 'attachment',
          title: att.filename,
          markdown: null,
          metadata: {
            mime: att.mime,
            filename: att.filename,
            sizeBytes: att.sizeBytes,
            mailbox: item.mailbox,
            uid: item.uid,
            uidValidity: item.uidValidity,
            attachmentIndex: att.index,
          },
          createdAt: item.date,
          parent: { externalId: messageExternalId, type: 'email.message' },
          ...(item.scopeRootId !== undefined && {
            scopeRootId: item.scopeRootId,
          }),
        }),
      );
      return attachments.length ? [message, ...attachments] : message;
    },

    async fetchBytes(session: Session, doc: Document) {
      if (doc.type !== 'attachment') return null;
      const meta = doc.metadata as {
        mailbox?: unknown;
        uid?: unknown;
        uidValidity?: unknown;
        attachmentIndex?: unknown;
      };
      if (
        typeof meta.mailbox !== 'string' ||
        typeof meta.uid !== 'number' ||
        typeof meta.uidValidity !== 'string' ||
        typeof meta.attachmentIndex !== 'number'
      )
        return null;
      const key = [
        session.account.id,
        meta.mailbox,
        meta.uidValidity,
        meta.uid,
      ].join('\u0000');
      let source = lastRaw?.key === key ? lastRaw.source : null;
      if (!source) {
        const config = session.account.config as unknown as ImapAccountConfig;
        const creds = await session.credentials();
        if (!creds?.password) {
          throw new SourceAuthError(
            'imap: account has no stored password credential',
          );
        }
        const client = await connectFn(config, creds.password);
        try {
          const status = await client.status(meta.mailbox);
          // A different UIDVALIDITY means this UID now names another message.
          if (String(status.uidValidity) !== meta.uidValidity) return null;
          const raws = await client.fetchMany(meta.mailbox, [meta.uid]);
          const raw = raws.find((r) => r.uid === meta.uid);
          if (!raw) return null; // message deleted upstream
          source = raw.source;
          lastRaw = { key, source };
        } finally {
          await client.close().catch(() => {});
        }
      }
      const content = await attachmentContent(source, meta.attachmentIndex);
      return content ? new Uint8Array(content) : null;
    },

    async readMessageEvidence(session, doc, options) {
      if (doc.type !== 'email.message') return [];
      const wanted = new Set(
        options.authors
          .map(normalizeAuthor)
          .filter((author) => author.length > 0),
      );
      const limit = Math.max(0, Math.min(3, Math.floor(options.limit)));
      if (wanted.size === 0 || limit === 0) return [];

      const match = /^(.*):([^:]+):(\d+)$/u.exec(doc.externalId);
      if (!match) return [];
      const mailbox = match[1];
      const uidValidity = match[2];
      const uid = Number(match[3]);
      if (!mailbox || !Number.isSafeInteger(uid) || uid <= 0) return [];

      const config = session.account.config as unknown as ImapAccountConfig;
      const creds = await session.credentials();
      if (!creds?.password) {
        throw new SourceAuthError(
          'imap: account has no stored password credential',
        );
      }
      const client = await connectFn(config, creds.password);
      try {
        const status = await client.status(mailbox);
        if (String(status.uidValidity) !== uidValidity) return [];
        const raws = await client.fetchMany(mailbox, [uid]);
        const raw = raws.find((item) => item.uid === uid);
        if (!raw) return [];
        const parsed = await parseImapMessage(raw, mailbox, status.uidValidity);
        if (!parsed.evidence || !wanted.has(parsed.evidence.author)) return [];
        return [parsed.evidence].slice(0, limit);
      } finally {
        await client.close().catch(() => {});
      }
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
        const mailboxes = resolveScopedMailboxes(
          folders,
          rootsOf(config as unknown as Record<string, unknown>),
        ).map((m) => m.path);
        // Mirror pull()'s guard: a listFolders that resolves to zero syncable
        // mailboxes would otherwise yield a complete-but-EMPTY listing, which
        // the engine's reconcile diff reads as "everything was deleted
        // upstream". Fail the pass instead (recorded as a reconcile error).
        if (mailboxes.length === 0) {
          throw new Error(
            'imap: no syncable mailboxes found (expected INBOX/All Mail and/or Sent)',
          );
        }
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
  mb: ScopedMailbox,
  cur: ImapCursor,
  defaultPhase: PullPhase,
  session: Session,
  totalEstimateOverride?: number,
): AsyncGenerator<Batch<ImapCursor, ImapMessageItem>> {
  const { path } = mb;
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

  if (plan.reset && prev) {
    // Archive the old-UIDVALIDITY generation HERE, not via reconcile(): the
    // old keys are known exactly (prev.uidValidity × 1..prev.lastUid), and
    // pulling the cleanup into the sync path means reconcile keeps no
    // legitimate mass-archive case — its listing after a rollover matches
    // what this resync re-commits. Refs without a matching row are ignored
    // by archiveByRef, and a crash mid-resync just re-emits these on the
    // next pass (prev is only replaced once a batch cursor commits below).
    for (const deletions of chunk(generationRefs(path, prev), 1000)) {
      if (session.signal.aborted) return;
      yield {
        phase,
        items: [],
        deletions,
        // Deliberately does NOT advance this mailbox's cursor entry: the
        // stale entry keeps plan.reset (and this cleanup) re-triggering
        // until the resync below lands its first real batch.
        cursor: cur,
        estimateTotal,
      };
    }
  }

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
        items.push({
          ...(await parseImapMessage(raw, path, status.uidValidity)),
          scopeRootId: mb.rootId,
        });
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
