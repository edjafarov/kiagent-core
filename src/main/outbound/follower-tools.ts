/** A read-only copy drafts nothing: the outbox is the leader's (spec 7.6). The
 *  assistant gets a sentence it can act on instead of a raw SyncReadOnly. */
import type { OutboundToolApi } from './service';

const WRITES = ['draftReply', 'draftMessage', 'reviseDraft'] as const;

export function guardDraftTools<T extends OutboundToolApi>(
  api: T,
  sync: { readOnly(): boolean; masterName(): string | null },
): T {
  const where = (): string => `Draft this on ${sync.masterName() ?? 'the device that leads'}`;
  const sentence = (): Error =>
    new Error(`${where()}: this device holds a read-only copy, so drafts are made on the device that leads.`);
  const guarded = Object.create(api) as T;
  for (const name of WRITES) {
    (guarded as Record<string, unknown>)[name] = async (a: never) => {
      if (sync.readOnly()) throw sentence();
      try {
        return await (api[name] as (a: never) => Promise<unknown>)(a);
      } catch (err) {
        if (err instanceof Error && err.name === 'SyncReadOnly') throw sentence();
        throw err;
      }
    };
  }
  return guarded;
}
