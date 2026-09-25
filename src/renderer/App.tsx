import React, { useSyncExternalStore } from 'react';
import { subscribeAppState, getAppState } from '@renderer/state/app-state';
import { useNavigation } from '@renderer/state/navigation';
import {
  ROUTE_META,
  ViewContext,
  isExtView,
  parseExtView,
  resolveInitialView,
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

/** B3: the title-lookup routing site (design spec's routing table) — a
 *  direct `ROUTE_META[view]` index is only correct for a `KnownView`. A
 *  contributed view's title comes from its OWN manifest entry, carried on
 *  the lifecycle snapshot's `ExtensionSnapshot.ui` (no other source exists
 *  — see screen-registry.tsx's B3 section). Never throws: an unparseable
 *  or unrecognized `ExtView` simply has no title, same as any other
 *  unknown view did before this change. */
function viewTitle(
  view: View,
  extensions: AppState['extensions'],
): string | undefined {
  if (!isExtView(view)) return ROUTE_META[view].title;
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

  const nav = useNavigation<View, ViewParams>('sources', resolveInitialView);

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

  const { view, params, navigate, resolved } = nav;
  const screen = screenRegistry.get(view, params, navigate, state.extensions);
  const frame = screenRegistry.frame(view);
  const title = viewTitle(view, state.extensions);

  return (
    <ViewContext.Provider value={nav}>
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
