/**
 * IMAP source — internal types.
 *
 * Ported from the legacy Electron connector at
 * kiagent-ref/src/main/connectors/imap/. Semantics preserved: which mailboxes
 * are synced (folders.ts), the per-mailbox UIDVALIDITY+UID cursor, and the
 * message shaping (subject/from/to/date/body). What's NOT preserved: legacy
 * built one `email_thread` document per RFC-5322 thread (thread-builder.ts /
 * rebuild.ts); this port yields one flat `email.message` document per
 * message — see source.ts for the rationale.
 */

/** Non-secret IMAP connection config, persisted in Account.config. */
export interface ImapAccountConfig {
  host: string;
  port: number;
  /** true => implicit TLS (imapflow `secure`); false => STARTTLS if offered. */
  secure: boolean;
  user: string;
}

export type MailboxRole = 'all' | 'inbox' | 'sent';

export interface ResolvedMailbox {
  path: string;
  role: MailboxRole;
}

/** One mailbox as returned by LIST. */
export interface ImapFolderInfo {
  path: string;
  /** RFC 6154 special-use flag, e.g. '\\All', '\\Sent', or undefined. */
  specialUse?: string;
  /** Lower-cased flag/attribute strings for heuristic fallback. */
  flags: string[];
}

export interface ImapMailboxStatus {
  uidValidity: number;
  uidNext: number;
  exists: number;
}

export interface ImapRawMessage {
  uid: number;
  source: Buffer;
}

/**
 * The slice of IMAP behavior the source needs, behind an interface so pull()
 * is testable with a fake — the real implementation (client.ts) wraps
 * imapflow. Callers must call close() when done with a run.
 */
export interface ImapClient {
  listFolders(): Promise<ImapFolderInfo[]>;
  status(path: string): Promise<ImapMailboxStatus>;
  /** Every UID currently present in the mailbox (used for paging and reconcile). */
  listUids(path: string): Promise<number[]>;
  /** Raw RFC822 sources for a bounded set of UIDs. */
  fetchMany(path: string, uids: number[]): Promise<ImapRawMessage[]>;
  close(): Promise<void>;
}

/** Per-mailbox cursor entry: what backfill/delta has already caught up to. */
export interface FolderCursorEntry {
  uidValidity: string;
  lastUid: number;
}

/** The Source's cursor: one entry per synced mailbox. */
export interface ImapCursor {
  mailboxes: Record<string, FolderCursorEntry>;
}

/**
 * One already-fetched-and-parsed message — everything toDocument() needs,
 * computed with no further I/O so toDocument stays pure/sync per the Source
 * contract.
 */
export interface ImapMessageItem {
  mailbox: string;
  uid: number;
  uidValidity: string;
  messageId: string | null;
  subject: string | null;
  from: string | null;
  to: string[];
  /** ISO-8601, or null if the message carried no parseable Date header. */
  date: string | null;
  /** Cleaned (quoted-reply-stripped) plain-text body. */
  bodyText: string;
  /** Lower-cased header map, used only for automated-sender filtering. */
  headers: Record<string, string>;
}
