import { useCallback, useEffect, useState } from 'react';
import type { OutboxPanelRow } from '@shared/ipc';
import { stripIpcWrapper } from './outbox-rows';

export interface OutboxData {
  /** Null while the first read is in flight. */
  rows: OutboxPanelRow[] | null;
  /** The last read failed — shown, never passed off as current rows. */
  loadFailed: boolean;
  reload: () => void;
  /** The row whose action is in flight. */
  busyId: string | null;
  /** The last action's failure, on the row it belongs to. */
  error: { id: string; message: string } | null;
  /** Runs one row action. Its effect arrives as a push, which re-reads. */
  run: (id: string, act: () => Promise<unknown>) => Promise<void>;
}

/**
 * The outbox rows: read on mount and again on every `push:outbox-changed`
 * (a draft arrives, a send finishes, a draft expires, a row action lands —
 * main coalesces them), plus the row actions' busy and error state.
 */
export function useOutbox(): OutboxData {
  const [rows, setRows] = useState<OutboxPanelRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<OutboxData['error']>(null);

  const reload = useCallback(() => {
    void window.kiagent
      .invoke('outbox:list', {})
      .then((next) => {
        setRows(next);
        setLoadFailed(false);
      })
      .catch(() => {
        setRows((prev) => prev ?? []);
        setLoadFailed(true);
      });
  }, []);

  useEffect(() => {
    reload();
    return window.kiagent.on('push:outbox-changed', reload);
  }, [reload]);

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
    }
  };

  return { rows, loadFailed, reload, busyId, error, run };
}
