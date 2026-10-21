import { useCallback, useEffect, useState } from 'react';
import type { CalendarDraftView } from '@shared/ipc';
import { stripIpcWrapper } from './outbox-rows';

export interface CalendarDraftsData {
  /** Null while the first read is in flight. */
  drafts: CalendarDraftView[] | null;
  loadFailed: boolean;
  reload: () => void;
}

/** The event drafts waiting for the user: read on mount and again on every
 *  `push:calendar-out-changed` (main coalesces them). */
export function useCalendarDrafts(): CalendarDraftsData {
  const [drafts, setDrafts] = useState<CalendarDraftView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const reload = useCallback(() => {
    void window.kiagent
      .invoke('calendar-out:list', undefined)
      .then((next) => {
        setDrafts(next);
        setLoadFailed(false);
      })
      .catch(() => {
        setDrafts((prev) => prev ?? []);
        setLoadFailed(true);
      });
  }, []);

  useEffect(() => {
    reload();
    return window.kiagent.on('push:calendar-out-changed', reload);
  }, [reload]);

  return { drafts, loadFailed, reload };
}

export function errorText(e: unknown): string {
  return stripIpcWrapper(e instanceof Error ? e.message : String(e));
}
