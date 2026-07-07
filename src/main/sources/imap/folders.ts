import type { ImapFolderInfo, ResolvedMailbox } from './types';

// Names that denote a Gmail-style "all mail" mailbox — a superset of INBOX, so
// syncing it instead of INBOX loses nothing. Deliberately excludes "Archive":
// on standard IMAP (Dovecot, etc.) Archive is a separate, sparse folder that
// does NOT contain inbox mail, so matching it here would skip INBOX entirely
// and index nothing. Gmail's real all-mail is caught by the \All special-use
// (preferred above) or its localized "All Mail" name.
//
// Ported verbatim from kiagent-ref/src/main/connectors/imap/folders.ts — same
// mailbox-selection semantics as the legacy connector.
const ALL_NAMES = [/^all mail$/i, /^all$/i];
const SENT_NAMES = [/^sent( mail| items)?$/i];

/**
 * Decide which mailboxes to sync: the all-mail folder (or INBOX if none) plus
 * Sent. Junk/Trash/Drafts and everything else are skipped. Prefers RFC 6154
 * SPECIAL-USE, falling back to common-name heuristics.
 */
export function resolveMailboxes(folders: ImapFolderInfo[]): ResolvedMailbox[] {
  const su = (flag: string) =>
    folders.find((f) => f.specialUse?.toLowerCase() === flag.toLowerCase());

  const out: ResolvedMailbox[] = [];

  // All-mail (or INBOX fallback).
  const all = su('\\All');
  if (all) {
    out.push({ path: all.path, role: 'all' });
  } else {
    const byName = folders.find((f) =>
      ALL_NAMES.some((rx) => rx.test(leaf(f.path))),
    );
    if (byName) out.push({ path: byName.path, role: 'all' });
    else {
      const inbox = folders.find((f) => f.path.toUpperCase() === 'INBOX');
      if (inbox) out.push({ path: inbox.path, role: 'inbox' });
    }
  }

  // Sent.
  const sent =
    su('\\Sent') ??
    folders.find((f) => SENT_NAMES.some((rx) => rx.test(leaf(f.path))));
  if (sent) out.push({ path: sent.path, role: 'sent' });

  // Dedupe by path (a server could map INBOX and \All to the same mailbox).
  const seen = new Set<string>();
  return out.filter((r) =>
    seen.has(r.path) ? false : (seen.add(r.path), true),
  );
}

function leaf(path: string): string {
  const parts = path.split(/[/.]/);
  return parts[parts.length - 1];
}
