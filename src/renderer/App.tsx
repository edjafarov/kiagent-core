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
import { TopBar } from '@renderer/components/TopBar';
import { BootSplash } from '@renderer/components/BootSplash';
import { SignIn } from '@renderer/screens/SignIn';
import { IconSprite } from '@shared/web-ui/icon-sprite';
import {
  createScreenRegistry,
  getDefaultScreens,
} from '@renderer/screen-registry';

const screenRegistry = createScreenRegistry(getDefaultScreens());

const SHELL_STYLE: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

export default function App(): React.ReactElement {
  // Raw store access (not the `useAppState` selector hook): the gate below
  // must observe the `null` not-yet-loaded moment, which `useAppState`
  // deliberately can't express (see state/app-state.ts).
  const state = useSyncExternalStore(subscribeAppState, getAppState);

  // Navigation is local component state, not the URL — there is exactly one
  // BrowserWindow and no back/forward browser chrome to sync with.
  const [resolved, setResolved] = useState<ResolvedView | null>(null);
  const historyRef = useRef<ResolvedView[]>([]);

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

  const viewContextValue = useMemo(
    () => ({
      view: resolved?.view ?? ('sources' as View),
      params: resolved?.params ?? {},
      navigate,
      back,
    }),
    [resolved, navigate, back],
  );

  // Gate 1: nothing loaded yet.
  if (state === null) {
    return (
      <>
        <TitleBar />
        <div className="ac" style={SHELL_STYLE}>
          <BootSplash />
        </div>
      </>
    );
  }

  // Gate 2: no identity — full-window sign-in, per contracts.ts's AppState
  // (there is no legacy "use kia locally" skip; every window either has an
  // identity or shows SignIn).
  if (state.identity === null) {
    return (
      <>
        <TitleBar />
        <div className="ac" style={SHELL_STYLE}>
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
      <TitleBar />
      <IconSprite />
      <div className="ac" style={SHELL_STYLE}>
        {screenRegistry.usesTopBar(view) && <TopBar />}
        <React.Fragment key={`${view}:${resolved?.epoch ?? 0}`}>
          {screen}
        </React.Fragment>
      </div>
    </ViewContext.Provider>
  );
}
