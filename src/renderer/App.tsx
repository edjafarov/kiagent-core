import React from 'react';
import { useAppGate } from '@renderer/state/app-state';
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
import { SourceDescriptorsProvider } from '@renderer/screens/Sources/sources-registry';
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

const NO_EXTENSIONS: AppState['extensions'] = [];

/** What the shell renders on. A feed push that changes only counts or
 *  recent items leaves every field equal (pushes are reconciled, so
 *  `extensions` keeps its reference), and the shell does not re-render. */
function selectShellGate(s: AppState | null) {
  return {
    loaded: s !== null,
    signedIn: s !== null && s.identity !== null,
    extensions: s?.extensions ?? NO_EXTENSIONS,
  };
}

export default function App(): React.ReactElement {
  const gate = useAppGate(selectShellGate);

  const nav = useNavigation<View, ViewParams>('sources', resolveInitialView);

  // Gate 1: nothing loaded yet.
  if (!gate.loaded) {
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
  if (!gate.signedIn) {
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
  const screen = screenRegistry.get(view, params, navigate, gate.extensions);
  const frame = screenRegistry.frame(view);
  const title = viewTitle(view, gate.extensions);

  return (
    <ViewContext.Provider value={nav}>
      <IconSprite />
      <SourceDescriptorsProvider>
        <AppShell sidebar={<Sidebar />}>
          <React.Fragment key={`${view}:${resolved?.epoch ?? 0}`}>
            {frame === 'page' ? (
              screen
            ) : (
              <HostFrame title={title}>{screen}</HostFrame>
            )}
          </React.Fragment>
        </AppShell>
      </SourceDescriptorsProvider>
    </ViewContext.Provider>
  );
}
