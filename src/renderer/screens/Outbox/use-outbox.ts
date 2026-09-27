import { useCallback, useEffect, useState } from 'react';
import type { OutboxPanelRow } from '@shared/ipc';

export interface OutboxData {
  /** Null while the first read is in flight. */
  rows: OutboxPanelRow[] | null;
  /** The last read failed — never shown as an empty outbox. */
  loadFailed: boolean;
  reload: () => void;
}

/**
 * The outbox rows: read on mount, again on every `push:outbox-changed`
 * (a draft arrives, a send finishes, a draft expires) and after each of the
 * page's own actions.
 */
export function useOutbox(): OutboxData {
  const [rows, setRows] = useState<OutboxPanelRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const reload = useCallback(() => {
    void window.kiagent
      .invoke('outbox:list', {})
      .then((next) => {
        setRows(next);
        setLoadFailed(false);
      })
      .catch(() => {
        // "Nothing drafted yet" is a claim about the user's outbox; a failed
        // read must say it failed instead.
        setRows((prev) => prev ?? []);
        setLoadFailed(true);
      });
  }, []);

  useEffect(() => {
    reload();
    return window.kiagent.on('push:outbox-changed', reload);
  }, [reload]);

  return { rows, loadFailed, reload };
}
