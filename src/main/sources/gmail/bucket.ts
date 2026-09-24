/**
 * Gmail's folder scope (spec §4): three buckets, not labels. `mail` is
 * everything outside Trash and Spam — archived mail included — and is always
 * selected; Trash and Spam are the two opt-ins.
 *
 * A thread lands in exactly ONE bucket, decided from its messages rather than
 * the label union: a conversation with one trashed reply is still mail. The
 * bucket is the thread's `scopeRootId` and is hashed into its metadata, so a
 * thread moving between buckets re-emits and re-stamps.
 */
export type GmailBucket = 'mail' | 'TRASH' | 'SPAM';

export const GMAIL_BUCKETS: readonly GmailBucket[] = ['mail', 'TRASH', 'SPAM'];

/** mail if any message is in neither Trash nor Spam; else TRASH if any
 *  message is in Trash; else SPAM. */
export function threadBucket(
  messages: ReadonlyArray<{ labelIds?: string[] | null }>,
): GmailBucket {
  let trash = false;
  for (const m of messages) {
    const labels = m.labelIds ?? [];
    const inTrash = labels.includes('TRASH');
    if (!inTrash && !labels.includes('SPAM')) return 'mail';
    trash ||= inTrash;
  }
  // A thread with no messages is never emitted; call it mail regardless.
  if (messages.length === 0) return 'mail';
  return trash ? 'TRASH' : 'SPAM';
}

/** The buckets an account's config selects. Always includes `mail`; a
 *  config with no `folderRoots` (a legacy account) selects only `mail`. */
export function selectedBuckets(
  config: Record<string, unknown>,
): Set<GmailBucket> {
  const selected = new Set<GmailBucket>(['mail']);
  const { folderRoots: roots } = config;
  if (Array.isArray(roots)) {
    for (const r of roots) {
      const { id } = r as { id?: unknown };
      if (GMAIL_BUCKETS.includes(id as GmailBucket))
        selected.add(id as GmailBucket);
    }
  }
  return selected;
}
