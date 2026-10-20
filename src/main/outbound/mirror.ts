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
import type { CoreStore } from '../core/store/store';

/** Whole create → read → adopt, before draft_reply returns (§5.2). */
export const MIRROR_CREATE_DEADLINE_MS = 20_000;
/** One read/update round trip on the confirm and revise paths. */
export const MIRROR_CALL_DEADLINE_MS = 20_000;

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
    threading: row.threading ?? undefined,
  };
}

function snapshotOfContent(c: DraftContent): DraftSnapshot {
  return {
    to: c.to,
    cc: c.cc,
    bcc: c.bcc,
    subject: c.subject,
    bodyMarkdown: c.bodyText,
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
  ): Promise<OutboxRow>;
  /** read → adopt, or move the row to its terminal state. Throws when the
   *  provider can't be reached (the row is left as it was). */
  refreshLocked(
    row: OutboxRow,
    drafts: DraftMirror,
    ms?: number,
  ): Promise<OutboxRow>;
  /** Kia's edit → provider → read → adopt (one revision bump). */
  updateLocked(
    row: OutboxRow,
    drafts: DraftMirror,
    patch: DraftPatch,
    local: DraftSnapshot,
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
    origins?: OutboxAttachment[],
  ) =>
    (
      await store.outbox.applyContent(
        row.id,
        snapshotOfContent(c),
        ref,
        origins,
      )
    ).row;

  const readAdopt = async (
    row: OutboxRow,
    drafts: DraftMirror,
    ref: DraftRef,
    ms: number,
    origins?: OutboxAttachment[],
  ): Promise<OutboxRow> => {
    const r = await deadline(drafts.read(ref), ms, 'draft read');
    const label = providerLabel(await deps.sourceOf(row));
    if (r.state === 'draft') return adopt(row, r.ref, r.content, origins);
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
    async createLocked(row, drafts, intent) {
      const started = deps.nowMs();
      const left = () => MIRROR_CREATE_DEADLINE_MS - (deps.nowMs() - started);
      const provider = providerLabel(await deps.sourceOf(row));
      let ref: DraftRef;
      try {
        ref = await deadline(
          drafts.create(intent ?? intentOf(row)),
          left(),
          'draft create',
        );
      } catch (e) {
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
      try {
        return await readAdopt(mirrored, drafts, ref, Math.max(1, left()));
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

    async updateLocked(row, drafts, patch, local) {
      const ref = row.mirror?.ref;
      if (!ref) throw new Error('outbox: not mirrored');
      const next = await deadline(
        drafts.update(ref, patch),
        MIRROR_CALL_DEADLINE_MS,
        'draft update',
      );
      try {
        return await readAdopt(
          row,
          drafts,
          next,
          MIRROR_CALL_DEADLINE_MS,
          local.attachments,
        );
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
        return (await store.outbox.applyContent(row.id, local, next)).row;
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
