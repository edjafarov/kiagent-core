import { createContext, useContext } from 'react';

/**
 * Routed screens. Deliberately small: Sources and Settings own their own
 * in-screen navigation. Settings is NOT routed at all — it is a modal
 * (ViewContextValue.openSettings), so closing it never disturbs the view.
 */
export type View = 'sources' | 'connection' | 'logs' | 'outbox' | 'marketplace';

export interface ViewParams {
  accountId?: string;
  anchor?: string;
}

export interface ViewContextValue {
  view: View;
  params: ViewParams;
  navigate: (to: View, params?: ViewParams) => void;
  back: () => void;
  /** Opens the Settings modal (spec §6). Settings is NOT a routed view. */
  openSettings: () => void;
}

export const ViewContext = createContext<ViewContextValue>({
  view: 'sources',
  params: {},
  navigate: () => {},
  back: () => {},
  openSettings: () => {},
});

export function useView(): ViewContextValue {
  return useContext(ViewContext);
}

/** A concrete navigation target plus a monotonically increasing `epoch`.
 *  App keys the rendered screen on `${view}:${epoch}`, so re-navigating to
 *  the CURRENT view (clicking "Sources" while already there) remounts the
 *  screen and resets its in-screen state — the add-source panel, the
 *  source-detail sub-view. */
export interface ResolvedView {
  view: View;
  params?: ViewParams;
  epoch: number;
}

/** Pure navigate transition: every call bumps `epoch`; same-view
 *  re-navigation is NOT pushed onto the back history (no duplicate stops). */
export function nextResolved(
  prev: ResolvedView | null,
  to: View,
  params?: ViewParams,
): { next: ResolvedView; push: boolean } {
  return {
    next: { view: to, params, epoch: (prev?.epoch ?? 0) + 1 },
    push: prev !== null && prev.view !== to,
  };
}
