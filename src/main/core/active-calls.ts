import type { ActiveCall, ActiveCallOp } from '@shared/contracts';

/** Local model calls executing right now — fed by the inference plane
 *  (complete/see/read) and the local-ASR pump (hear); read by main, which
 *  projects it into AppState.processing.active. In memory, per app run. */
export interface ActiveCalls {
  /** Record an executing local call; call the returned function when it
   *  ends (idempotent). */
  enter(op: ActiveCallOp, task: string | null): () => void;
  /** Executing calls in start order. */
  list(): ActiveCall[];
  onChange(fn: (calls: ActiveCall[]) => void): () => void;
}

export function createActiveCalls(): ActiveCalls {
  let nextId = 0;
  const calls = new Map<number, ActiveCall>(); // insertion order = start order
  const subs = new Set<(calls: ActiveCall[]) => void>();
  const emit = (): void => {
    const list = [...calls.values()];
    subs.forEach((fn) => fn(list));
  };
  return {
    enter(op, task) {
      const id = nextId++;
      calls.set(id, { op, task });
      emit();
      let left = false;
      return () => {
        if (left) return;
        left = true;
        calls.delete(id);
        emit();
      };
    },
    list: () => [...calls.values()],
    onChange(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
