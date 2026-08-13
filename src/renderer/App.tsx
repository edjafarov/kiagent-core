import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { subscribeAppState, getAppState } from '@renderer/state/app-state';
import {
  ViewContext,
  nextResolved,
  type ResolvedView,
  type View,
  type ViewParams,
} from '@renderer/state/view';
import { TitleBar } from '@renderer/components/TitleBar';
import { Sidebar } from '@renderer/components/Sidebar';
import { SettingsModal } from '@renderer/components/SettingsModal';
import { BootSplash } from '@renderer/components/BootSplash';
import { SignIn } from '@renderer/screens/SignIn';
import { IconSprite } from '@shared/web-ui/icon-sprite';
import {
  createScreenRegistry,
  getDefaultScreens,
} from '@renderer/screen-registry';

const screenRegistry = createScreenRegistry(getDefaultScreens());

const GATE_STYLE: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

const isWin =
  typeof navigator !== 'undefined' && /Win/i.test(navigator.platform);

export default function App(): React.ReactElement {
  // Raw store access (not the `useAppState` selector hook): the gate below
  // must observe the `null` not-yet-loaded moment, which `useAppState`
  // deliberately can't express (see state/app-state.ts).
  const state = useSyncExternalStore(subscribeAppState, getAppState);

  // Navigation is local component state, not the URL — there is exactly one
  // BrowserWindow and no back/forward browser chrome to sync with.
  const [resolved, setResolved] = useState<ResolvedView | null>(null);
  const historyRef = useRef<ResolvedView[]>([]);
  // Settings is a modal, not a view (spec §6): opening it never touches
  // `resolved`, so closing restores the exact screen state underneath.
  const [settingsOpen, setSettingsOpen] = useState(false);

  const navigate = useCallback((to: View, params?: ViewParams) => {
    setResolved((prev) => {
      const { next, push } = nextResolved(prev, to, params);
      if (push && prev !== null) historyRef.current.push(prev);
      return next;
    });
  }, []);

  const back = useCallback(() => {
    const prev = historyRef.current.pop() ?? {
      view: 'sources' as const,
      epoch: 0,
    };
    setResolved(prev);
  }, []);

  const openSettings = useCallback(() => setSettingsOpen(true), []);

  const viewContextValue = useMemo(
    () => ({
      view: resolved?.view ?? ('sources' as View),
      params: resolved?.params ?? {},
      navigate,
      back,
      openSettings,
    }),
    [resolved, navigate, back, openSettings],
  );

  // Gate 1: nothing loaded yet.
  if (state === null) {
    return (
      <>
        <TitleBar />
        <div className="ac" style={GATE_STYLE}>
          <BootSplash />
        </div>
      </>
    );
  }

  // Gate 2: no identity — full-window sign-in, no sidebar.
  if (state.identity === null) {
    return (
      <>
        <TitleBar />
        <div className="ac" style={GATE_STYLE}>
          <IconSprite />
          <SignIn />
        </div>
      </>
    );
  }

  const view = resolved?.view ?? 'sources';
  const params = resolved?.params ?? {};
  const screen = screenRegistry.get(view, params, navigate);

  return (
    <ViewContext.Provider value={viewContextValue}>
      <IconSprite />
      <div className="ac kg-shell">
        <Sidebar />
        <main className="kg-main">
          {isWin && <div className="kg-caption-drag" />}
          <React.Fragment key={`${view}:${resolved?.epoch ?? 0}`}>
            {screen}
          </React.Fragment>
        </main>
        {/* Inside `.ac`, not a sibling of it: `box-sizing: border-box` is
            scoped to `.ac *` (web-ui/components.css) with no global
            fallback, so a modal mounted outside this div would render its
            .input/.btn children as content-box. The backdrop is
            `position: fixed` and no ancestor here creates a containing
            block (no transform/filter/contain), so it still covers the
            whole viewport, sidebar included. */}
        {settingsOpen && (
          <SettingsModal onClose={() => setSettingsOpen(false)} />
        )}
      </div>
    </ViewContext.Provider>
  );
}
