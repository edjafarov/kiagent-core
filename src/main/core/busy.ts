/** A neutral do-not-disturb registry: owners (extensions) say they are busy
 *  and why; readers only see busy + reasons. In memory, per app run. */
export interface BusyRegistry {
  set(owner: string, reason: string | null): void;
  get(): { busy: boolean; reasons: string[] };
}

export function createBusyRegistry(): BusyRegistry {
  const byOwner = new Map<string, string>();
  return {
    set(owner, reason) {
      if (reason === null) byOwner.delete(owner);
      else byOwner.set(owner, reason);
    },
    get() {
      const reasons = [...byOwner.values()];
      return { busy: reasons.length > 0, reasons };
    },
  };
}
