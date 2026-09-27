import { useState } from 'react';
import { stripIpcWrapper } from './outbox-rows';

export interface RowActions {
  /** The row whose action is in flight. */
  busyId: string | null;
  /** The last action's failure, on the row it belongs to. */
  error: { id: string; message: string } | null;
  run: (id: string, act: () => Promise<unknown>) => Promise<void>;
}

/** One action at a time per page; the rows re-read afterwards either way
 *  (a failed write shows the row as it really is). */
export function useRowAction(reload: () => void): RowActions {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<RowActions['error']>(null);
  const run = async (id: string, act: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await act();
    } catch (e) {
      setError({
        id,
        message: stripIpcWrapper(e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setBusyId(null);
      reload();
    }
  };
  return { busyId, error, run };
}
