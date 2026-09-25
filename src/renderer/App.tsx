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
  isExtView,
  nextResolved,
  parseExtView,
  resolveInitialView,
  type KnownView,
  type ResolvedView,
  type View,
  type ViewParams,
} from '@renderer/state/view';
import type { AppState } from '@shared/contracts';
import { TitleBar } from '@renderer/components/TitleBar';
import { Sidebar } from '@renderer/components/Sidebar';
import { BootSplash } from '@renderer/components/BootSplash';
import { SignIn } from '@renderer/screens/SignIn';
import { IconSprite } from '@shared/web-ui/icon-sprite';
import { AppShell, HostFrame } from '@shared/web-ui/ui';
import {
  createScreenRegistry,
  getDefaultScreens,
} from '@renderer/screen-registry';

const screenRegistry = createScreenRegistry(getDefaultScreens());

// Page titles for host-framed views, shown in the app's top bar (the band
// doubles as the window drag region). A 'page' view renders its own.
const VIEW_TITLES: Partial<Record<KnownView, string>> = {
  sources: 'Sources',
  outbox: 'Outbox',
  connection: 'Connection',
  marketplace: 'Marketplace',
  logs: 'Logs',
  settings: 'Settings',
};

/** B3: the title-lookup routing site (design spec's routing table) — a
 *  direct `VIEW_TITLES[view]` index is only correct for a `KnownView`. A
 *  contributed view's title comes from its OWN manifest entry, carried on
 *  the lifecycle snapshot's `ExtensionSnapshot.ui` (no other source exists
 *  — see screen-registry.tsx's B3 section). Never throws: an unparseable
 *  or unrecognized `ExtView` simply has no title, same as any other
 *  unknown view did before this change. */
function viewTitle(
  view: View,
  extensions: AppState['extensions'],
): string | undefined {
  if (!isExtView(view)) return VIEW_TITLES[view];
  const parsed = parseExtView(view);
  if (!parsed) return undefined;
  const ext = extensions.find((e) => e.id === parsed.extensionId);
  return ext?.ui?.find((c) => c.id === parsed.contributionId)?.title;
}

const GATE_STYLE: React.CSSProperties = {
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
  const [resolved, setResolved] = useState<ResolvedView | null>(() =>
    resolveInitialView(),
  );
  const historyRef = useRef<ResolvedView[]>([]);
  // The pane last shown, for openSettings() with no pane.
  const lastPaneRef = useRef<string | undefined>(undefined);
  if (resolved?.view === 'settings' && resolved.params?.pane) {
    lastPaneRef.current = resolved.params.pane;
  }

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

  // Some buttons pass openSettings straight to onClick, so a click event can
  // arrive here; anything but a string means "no pane".
  const openSettings = useCallback(
    (pane?: unknown) => {
      const wanted = typeof pane === 'string' ? pane : lastPaneRef.current;
      navigate('settings', wanted ? { pane: wanted } : undefined);
    },
    [navigate],
  );

  const replaceParams = useCallback((params: ViewParams) => {
    setResolved((prev) => (prev ? { ...prev, params } : prev));
  }, []);

  const viewContextValue = useMemo(
    () => ({
      view: resolved?.view ?? ('sources' as View),
      params: resolved?.params ?? {},
      navigate,
      back,
      openSettings,
      replaceParams,
    }),
    [resolved, navigate, back, openSettings, replaceParams],
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
  const screen = screenRegistry.get(view, params, navigate, state.extensions);
  const frame = screenRegistry.frame(view);
  const title = viewTitle(view, state.extensions);

  return (
    <ViewContext.Provider value={viewContextValue}>
      <IconSprite />
      <AppShell sidebar={<Sidebar />}>
        <React.Fragment key={`${view}:${resolved?.epoch ?? 0}`}>
          {frame === 'page' ? (
            screen
          ) : (
            <HostFrame title={title}>{screen}</HostFrame>
          )}
        </React.Fragment>
      </AppShell>
    </ViewContext.Provider>
  );
}
