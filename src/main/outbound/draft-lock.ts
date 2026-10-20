/**
 * Serializes every operation on one Outbox draft — mirror create, refresh,
 * revise, send, discard, scheduled send (alpha-cent
 * docs/superpowers/specs/2026-10-20-outbox-draft-sync-design.md §3).
 *
 * Not re-entrant: public entry points acquire it; `*Locked` helpers assume
 * it is held and never acquire it again (a nested acquire would wait on
 * itself forever).
 */
export type DraftLock = <T>(
  draftId: string,
  fn: () => Promise<T>,
) => Promise<T>;

export function createDraftLock(): DraftLock {
  const tails = new Map<string, Promise<unknown>>();
  return function withDraft<T>(
    draftId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = tails.get(draftId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    tails.set(draftId, run);
    void run
      .finally(() => {
        if (tails.get(draftId) === run) tails.delete(draftId);
      })
      .catch(() => {});
    return run;
  };
}
