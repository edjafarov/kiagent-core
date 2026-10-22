import { useEffect, useRef, useState } from 'react';
import type { CalendarDayView, CalendarDraftView } from '@shared/ipc';

export interface SheetDayView {
  /** The installed answer for the draft's current revision, else null. */
  day: CalendarDayView | null;
  /** True until the current revision's answer (or its failure) lands. */
  checking: boolean;
}

/** What one request settled to, for the draft id + revision it asked about. */
interface Settled {
  key: string;
  day: CalendarDayView | null;
}

/**
 * The review page's day view for the open sheet (spec addendum A): fetched
 * on open and on every revision change while `active`, one request in
 * flight plus at most one follow-up. Every request carries a generation;
 * a revision change, `active` going false, or unmount bumps it, and only a
 * current-generation answer may settle. What the sheet sees is derived from
 * the CURRENT id + revision during render, so a revision change can never
 * commit the old grid or an un-held Add, not even for one frame. Main only
 * answers at the asked revision or null; anything else settles as null so
 * Checking… stays bounded.
 */
export function useSheetDayView(
  draft: Pick<CalendarDraftView, 'id' | 'revision'>,
  active: boolean,
): SheetDayView {
  const key = `${draft.id}:${draft.revision}`;
  const [settled, setSettled] = useState<Settled | null>(null);
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
      const settle = (day: CalendarDayView | null) => {
        if (g !== gen.current || !want.current.active) return;
        setSettled({ key: `${id}:${revision}`, day });
      };
      void window.kiagent
        .invoke('calendar-out:day-view', { id, revision })
        .then(
          (answer) => settle(answer?.revision === revision ? answer : null),
          () => settle(null),
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
    if (active) request();
    return () => {
      // Also stops a queued follow-up after unmount; a dep change sets
      // `want` again right after this.
      gen.current += 1;
      want.current = { ...want.current, active: false };
    };
  }, [draft.id, draft.revision, active]);

  const current = active && settled?.key === key ? settled : null;
  return { day: current?.day ?? null, checking: active && !current };
}
