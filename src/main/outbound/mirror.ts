/**
 * The Outbox row ↔ provider draft lifecycle (alpha-cent
 * docs/superpowers/specs/2026-10-20-outbox-draft-sync-design.md §5.2–§5.4).
 * Every `*Locked` helper assumes the caller holds the per-draft lock
 * (draft-lock.ts). The provider wins: what its draft says is adopted into
 * the row through `applyContent`, the one content write.
 */
import type {
  DraftContent,
  DraftMirror,
  DraftPatch,
  DraftRef,
  DraftSnapshot,
  OutboxAttachment,
  OutboxRow,
  SendIntent,
} from '@shared/contracts';

import type { LogSink } from '../core/engine/engine';
import { normalizeSnapshot, snapshotOf } from '../core/store/outbox';
import { htmlToText } from '../sources/email-evidence';
import { bodyHash, collapse, renderEmailBody, wordsOf } from './email-body';
import type { CoreStore } from '../core/store/store';

/** Whole create → read → adopt, before draft_reply returns (§5.2). */
export const MIRROR_CREATE_DEADLINE_MS = 20_000;
/** One read/update round trip on the confirm and revise paths. */
export const MIRROR_CALL_DEADLINE_MS = 20_000;

interface ReadOptions {
  /** Files this write uploads: where each came from. */
  origins?: OutboxAttachment[];
  /** The read right after the create. */
  created?: boolean;
  /** What Kia just wrote, when the read follows Kia's own update. */
  local?: DraftSnapshot;
  /** That update wrote the body: only then can its echo vouch for the
   *  provider's body as Kia's rendering. */
  wroteBody?: boolean;
}

const FIELDS = ['to', 'cc', 'bcc', 'subject', 'body', 'attachments'];

/** Which fields a provider's copy changed, by name only — never the
 *  content, which stays out of the log. */
export function changedFields(a: OutboxRow, b: OutboxRow): string[] {
  const key = (r: OutboxRow) =>
    JSON.parse(
      normalizeSnapshot(snapshotOf(r), { provider: true }),
    ) as unknown[];
  const [x, y] = [key(a), key(b)];
  return FIELDS.filter((_, i) => JSON.stringify(x[i]) !== JSON.stringify(y[i]));
}

export function providerLabel(source: string): string {
  return source === 'gmail' ? 'Gmail' : 'Outlook';
}

export function deadline<T>(
  p: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** What a send of this row carries (files are filled in by the caller). */
export function intentOf(row: OutboxRow): SendIntent {
  return {
    accountId: row.accountId,
    kind: row.kind,
    outboundRef: row.outboundRef ?? undefined,
    to: row.to,
    cc: row.cc,
    ...(row.bcc.length ? { bcc: row.bcc } : {}),
    subject: row.subject ?? undefined,
    bodyMarkdown: row.bodyMarkdown,
    bodyHtml: renderEmailBody(row.bodyMarkdown).html,
    threading: row.threading ?? undefined,
  };
}

/** The provider's body as Markdown: its HTML when it has one (the plain
 *  part never vouches for a different HTML part), else its text. */
function markdownOf(c: DraftContent): string {
  return c.bodyHtml !== undefined ? htmlToText(c.bodyHtml) : c.bodyText;
}

/** Whether the provider's body says what `md` renders to, word for word
 *  (links and images included). */
export function sameBody(c: DraftContent, md: string): boolean {
  const theirs =
    c.bodyHtml !== undefined ? wordsOf(c.bodyHtml) : collapse(c.bodyText);
  const mine =
    c.bodyHtml !== undefined ? wordsOf(renderEmailBody(md).html) : collapse(md);
  return theirs === mine;
}

function snapshotOfContent(c: DraftContent): DraftSnapshot {
  return {
    to: c.to,
    cc: c.cc,
    bcc: c.bcc,
    subject: c.subject,
    bodyMarkdown: markdownOf(c),
    attachments: c.attachments,
  };
}

const short = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  const line = m.replace(/\s+/g, ' ').trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line || 'unknown error';
};

export interface MirrorOps {
  /** create → read → adopt; never throws. A failure leaves the row
   *  Outbox-only with the reason in `mirror.error`. */
  createLocked(
    row: OutboxRow,
    drafts: DraftMirror,
    intent?: SendIntent,
    /** `readback: false` when an update follows at once (its own readback
     *  then adopts the result). */
    opts?: { readback?: boolean },
  ): Promise<OutboxRow>;
  /** read → adopt, or move the row to its terminal state. Throws when the
   *  provider can't be reached (the row is left as it was). */
  refreshLocked(
    row: OutboxRow,
    drafts: DraftMirror,
    ms?: number,
  ): Promise<OutboxRow>;
  /** Kia's edit → provider → read → adopt (one revision bump).
   *  `created`: the files upload that finishes a create — its read is the
   *  create's read. */
  updateLocked(
    row: OutboxRow,
    drafts: DraftMirror,
    patch: DraftPatch,
    local: DraftSnapshot,
    opts?: { created?: boolean },
  ): Promise<OutboxRow>;
  /** Best effort: a failure is logged, never thrown. */
  removeLocked(row: OutboxRow, drafts: DraftMirror): Promise<void>;
}

export function createMirrorOps(deps: {
  store: CoreStore;
  logSink: LogSink;
  nowMs: () => number;
  sourceOf: (row: OutboxRow) => Promise<string>;
}): MirrorOps {
  const { store } = deps;

  const adopt = async (
    row: OutboxRow,
    ref: DraftRef,
    c: DraftContent,
    { origins, created, local, wroteBody }: ReadOptions,
  ) => {
    // The words decide whether the provider changed the body (spec
    // 2026-10-21 §3.4a): a provider re-serializing Kia's HTML, or the user
    // bolding a word, is the same body — the row keeps its Markdown. Any
    // other change is adopted as the provider's text.
    const ours = [local?.bodyMarkdown, row.bodyMarkdown].find(
      (md) => md !== undefined && sameBody(c, md),
    );
    const copy = {
      ...snapshotOfContent(c),
      ...(ours !== undefined && { bodyMarkdown: ours }),
    };
    const fields = (s: DraftSnapshot) =>
      normalizeSnapshot(
        { ...s, bodyMarkdown: '', attachments: [] },
        { provider: true },
      );
    // The provider's copy of Kia's own write: the row keeps Kia's text.
    const echo =
      local !== undefined &&
      ours === local.bodyMarkdown &&
      fields(copy) === fields(local);
    // Kia's own rendering as the provider holds it: what a send may carry
    // without writing the body again (§3.4b). A subject- or files-only
    // write never vouches for a body Kia did not write; the last key stays.
    const own =
      (echo && wroteBody === true) ||
      (created === true && ours === row.bodyMarkdown && !local);
    const hash = bodyHash(c);
    const before = (await store.outbox.get(row.id)) ?? row;
    const { row: next, changed } = await store.outbox.applyContent(
      row.id,
      echo ? { ...local, attachments: copy.attachments } : copy,
      ref,
      {
        origins,
        from: echo ? 'echo' : created ? 'created' : 'provider',
        keys: { seenKey: hash, ...(own && { ownKey: hash }) },
      },
    );
    if (changed && !echo)
      deps.logSink.log(
        'outbound',
        'info',
        `draft ${row.id}: ${providerLabel(await deps.sourceOf(row))} copy changed ${changedFields(before, next).join(', ')}`,
        { draftId: row.id },
      );
    return next;
  };

  const readAdopt = async (
    row: OutboxRow,
    drafts: DraftMirror,
    ref: DraftRef,
    ms: number,
    opts: ReadOptions = {},
  ): Promise<OutboxRow> => {
    const r = await deadline(drafts.read(ref), ms, 'draft read');
    if (r.state === 'draft') return adopt(row, r.ref, r.content, opts);
    // Right after a create only a draft is a believable answer.
    if (opts.created) throw new Error(`a new draft read back as ${r.state}`);
    const label = providerLabel(await deps.sourceOf(row));
    if (r.state === 'sent') {
      await store.outbox.transition(row.id, ['draft'], 'sent', {
        sentAt: new Date(deps.nowMs()).toISOString(),
        externalMessageId: r.externalMessageId ?? null,
      });
      await store.outbox.setMirror(row.id, {
        ...row.mirror,
        ref,
        provider: label,
        sentElsewhere: true,
      });
    } else if (r.state === 'deleted') {
      await store.outbox.transition(row.id, ['draft'], 'discarded', {
        error: `Deleted in ${label}`,
      });
    } else {
      await store.outbox.transition(row.id, ['draft'], 'delivery_unknown', {
        error: `No longer in Drafts — sent from ${label} or deleted there; check Sent`,
      });
    }
    deps.logSink.log(
      'outbound',
      'info',
      `draft ${row.id}: ${label} draft ${r.state}`,
      {
        draftId: row.id,
      },
    );
    return (await store.outbox.get(row.id)) ?? row;
  };

  return {
    async createLocked(row, drafts, intent, opts = {}) {
      const started = deps.nowMs();
      const left = () => MIRROR_CREATE_DEADLINE_MS - (deps.nowMs() - started);
      const provider = providerLabel(await deps.sourceOf(row));
      let ref: DraftRef;
      const creating = drafts.create(intent ?? intentOf(row));
      try {
        ref = await deadline(creating, left(), 'draft create');
      } catch (e) {
        // A create still in flight at the deadline may land later; that
        // draft would be no row's, and the next try would make another.
        creating.then((late) => drafts.remove(late)).catch(() => undefined);
        const error = short(e);
        await store.outbox.setMirror(row.id, { ref: null, error, provider });
        deps.logSink.log(
          'outbound',
          'warn',
          `draft ${row.id}: not synced (${error})`,
          {
            draftId: row.id,
          },
        );
        return (await store.outbox.get(row.id)) ?? row;
      }
      // The ref first: from here on the provider draft is the row's.
      await store.outbox.setMirror(row.id, { ref, provider });
      const mirrored = (await store.outbox.get(row.id)) ?? row;
      if (opts.readback === false) return mirrored;
      try {
        return await readAdopt(mirrored, drafts, ref, Math.max(1, left()), {
          created: true,
        });
      } catch (e) {
        deps.logSink.log(
          'outbound',
          'warn',
          `draft ${row.id}: readback failed (${short(e)})`,
          {
            draftId: row.id,
          },
        );
        return mirrored;
      }
    },

    async refreshLocked(row, drafts, ms = MIRROR_CALL_DEADLINE_MS) {
      const ref = row.mirror?.ref;
      if (!ref || row.status !== 'draft') return row;
      return readAdopt(row, drafts, ref, ms);
    },

    async updateLocked(row, drafts, patch, local, { created } = {}) {
      const ref = row.mirror?.ref;
      if (!ref) throw new Error('outbox: not mirrored');
      // Awaited to the end, never abandoned at a deadline: a write still in
      // flight after the lock is released could overwrite a later edit, or
      // land between a confirm's read and its send. The provider calls are
      // bounded themselves (per-attempt timeouts; the extension RPC's 60 s).
      // Only the files this write uploads are Kia's by name alone.
      const uploading = new Set(
        (patch.attachments ?? []).map((a) => a.filename),
      );
      const origins = local.attachments.filter((a) =>
        uploading.has(a.filename),
      );
      // Kia's body write: until its readback is an echo, the provider's
      // body is not vouched for as Kia's rendering (§3.4b).
      if (patch.bodyMarkdown !== undefined) {
        const fresh = (await store.outbox.get(row.id)) ?? row;
        if (fresh.mirror?.ownKey !== undefined)
          await store.outbox.setMirror(row.id, {
            ...fresh.mirror,
            ownKey: undefined,
          });
      }
      let next: DraftRef;
      try {
        next = await drafts.update(ref, patch);
      } catch (e) {
        // A provider may have applied part of it (Outlook: the text, then
        // the files): show what it holds now before giving up.
        await readAdopt(row, drafts, ref, MIRROR_CALL_DEADLINE_MS).catch(
          () => undefined,
        );
        throw e;
      }
      try {
        return await readAdopt(row, drafts, next, MIRROR_CALL_DEADLINE_MS, {
          origins,
          local,
          created,
          // The create's own files upload: the body was written by the create.
          wroteBody: patch.bodyMarkdown !== undefined || created === true,
        });
      } catch (e) {
        // The provider has the edit; show it until the next refresh reads
        // the provider's own version.
        deps.logSink.log(
          'outbound',
          'warn',
          `draft ${row.id}: readback failed (${short(e)})`,
          {
            draftId: row.id,
          },
        );
        return (
          await store.outbox.applyContent(row.id, local, next, { origins })
        ).row;
      }
    },

    async removeLocked(row, drafts) {
      const ref = row.mirror?.ref;
      if (!ref) return;
      try {
        await deadline(
          drafts.remove(ref),
          MIRROR_CALL_DEADLINE_MS,
          'draft remove',
        );
      } catch (e) {
        deps.logSink.log(
          'outbound',
          'warn',
          `draft ${row.id}: provider draft not removed (${short(e)})`,
          {
            draftId: row.id,
          },
        );
      }
    },
  };
}
