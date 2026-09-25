import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * The app's navigation state, shared by core's App and the product overlay's
 * App (which has its own, larger route catalog). Generic over the view id
 * and params types so it depends on neither app's `state/view.ts`.
 *
 * Navigation is local component state, not the URL — there is exactly one
 * BrowserWindow and no back/forward browser chrome to sync with.
 */

/** Params every app's routes share: the Settings page keeps its pane here. */
export interface NavParams {
  pane?: string;
}

/** A concrete navigation target plus a monotonically increasing `epoch`.
 *  App keys the rendered screen on `${view}:${epoch}`, so re-navigating to
 *  the CURRENT view (clicking "Sources" while already there) remounts the
 *  screen and resets its in-screen state. */
export interface Resolved<V extends string, P extends NavParams> {
  view: V;
  params?: P;
  epoch: number;
}

/** Pure navigate transition: every call bumps `epoch`; same-view
 *  re-navigation is NOT pushed onto the back history (no duplicate stops). */
export function nextResolved<V extends string, P extends NavParams>(
  prev: Resolved<V, P> | null,
  to: V,
  params?: P,
): { next: Resolved<V, P>; push: boolean } {
  return {
    next: { view: to, params, epoch: (prev?.epoch ?? 0) + 1 },
    push: prev !== null && prev.view !== to,
  };
}

export interface Navigation<V extends string, P extends NavParams> {
  /** The current target; `null` until the first navigation (the default
   *  view is showing). */
  resolved: Resolved<V, P> | null;
  view: V;
  params: P;
  navigate: (to: V, params?: P) => void;
  back: () => void;
  /** Opens the Settings page on `pane`, or on the pane last shown. */
  openSettings: (pane?: string) => void;
  /** Replaces the current view's params in place: no remount, no history
   *  entry (e.g. switching Settings panes). */
  replaceParams: (params: P) => void;
}

/** Both apps route Settings under this id. */
const SETTINGS = 'settings';

export function useNavigation<V extends string, P extends NavParams>(
  defaultView: V,
  initial: () => Resolved<V, P> | null,
): Navigation<V, P> {
  const [resolved, setResolved] = useState<Resolved<V, P> | null>(initial);
  const historyRef = useRef<Resolved<V, P>[]>([]);
  // The pane last shown, for openSettings() with no pane.
  const lastPaneRef = useRef<string | undefined>(undefined);
  if (resolved?.view === SETTINGS && resolved.params?.pane) {
    lastPaneRef.current = resolved.params.pane;
  }

  const navigate = useCallback((to: V, params?: P) => {
    setResolved((prev) => {
      const { next, push } = nextResolved(prev, to, params);
      if (push && prev !== null) historyRef.current.push(prev);
      return next;
    });
  }, []);

  const back = useCallback(() => {
    setResolved(historyRef.current.pop() ?? { view: defaultView, epoch: 0 });
  }, [defaultView]);

  // Some buttons pass openSettings straight to onClick, so a click event can
  // arrive here; anything but a string means "no pane".
  const openSettings = useCallback(
    (pane?: unknown) => {
      const wanted = typeof pane === 'string' ? pane : lastPaneRef.current;
      navigate(SETTINGS as V, wanted ? ({ pane: wanted } as P) : undefined);
    },
    [navigate],
  );

  const replaceParams = useCallback((params: P) => {
    setResolved((prev) => (prev ? { ...prev, params } : prev));
  }, []);

  return useMemo(
    () => ({
      resolved,
      view: resolved?.view ?? defaultView,
      params: resolved?.params ?? ({} as P),
      navigate,
      back,
      openSettings,
      replaceParams,
    }),
    [resolved, defaultView, navigate, back, openSettings, replaceParams],
  );
}
