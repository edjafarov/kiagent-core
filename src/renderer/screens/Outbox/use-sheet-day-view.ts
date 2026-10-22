import { useEffect, useRef, useState } from 'react';
import type { CalendarDayView, CalendarDraftView } from '@shared/ipc';

export interface SheetDayView {
  /** The installed answer for the draft's current revision, else null. */
  day: CalendarDayView | null;
  /** True until the current revision's answer (or its failure) lands. */
  checking: boolean;
}

/**
 * The review page's day view for the open sheet (spec addendum A): fetched
 * on open and on every revision change while `active`, one request in
 * flight plus at most one follow-up. Every request carries a generation;
 * a revision change, `active` going false, or unmount bumps it, and only a
 * current-generation answer at the current revision is installed or may
 * end `checking`.
 */
export function useSheetDayView(
  draft: Pick<CalendarDraftView, 'id' | 'revision'>,
  active: boolean,
): SheetDayView {
  const [day, setDay] = useState<CalendarDayView | null>(null);
  const [checking, setChecking] = useState(active);
  const gen = useRef(0);
  const want = useRef({ id: draft.id, revision: draft.revision, active });
  const inFlight = useRef(false);
  const pending = useRef(false);

  useEffect(() => {
    const request = (): void => {
      if (inFlight.current) {
        pending.current = true;
        return;
      }
      inFlight.current = true;
      const g = gen.current;
      const { id, revision } = want.current;
      const current = () => g === gen.current && want.current.active;
      void window.kiagent
        .invoke('calendar-out:day-view', { id, revision })
        .then(
          (answer) => {
            if (!current()) return;
            setDay(answer?.revision === revision ? answer : null);
            setChecking(false);
          },
          () => {
            if (!current()) return;
            setDay(null);
            setChecking(false);
          },
        )
        .finally(() => {
          inFlight.current = false;
          if (pending.current) {
            pending.current = false;
            if (want.current.active) request();
          }
        });
    };

    gen.current += 1;
    want.current = { id: draft.id, revision: draft.revision, active };
    setDay(null);
    setChecking(active);
    if (active) request();
    return () => {
      // Also stops a queued follow-up after unmount; a dep change sets
      // `want` again right after this.
      gen.current += 1;
      want.current = { ...want.current, active: false };
    };
  }, [draft.id, draft.revision, active]);

  return { day, checking };
}
