import React from 'react';
import { useAppGate } from '@renderer/state/app-state';
import { useNavigation } from '@renderer/state/navigation';
import {
  INITIAL_VIEW,
  ROUTE_META,
  ViewContext,
  isExtView,
  parseExtView,
  resolveInitialView,
  type View,
  type ViewParams,
} from '@renderer/state/view';
import { SOURCES_POLICY } from '@shared/composition';
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
import { PRODUCT_SHELL } from '@renderer/composition';
import { InstallLinks } from './extensions/use-install-link';

const screenRegistry = createScreenRegistry(getDefaultScreens());

/** The top-line title for the routed view. `ROUTE_META[view]` is indexed
 *  only for a `KnownView`; a contributed view's title comes from its own
 *  manifest entry on the lifecycle snapshot, falling back to the bare
 *  contribution id (the screen body already shows the "unavailable" state
 *  for that case). Never throws. */
export function routeTitle(
  view: View,
  extensions: AppState['extensions'],
): string {
  if (!isExtView(view)) return ROUTE_META[view].title;
  const parsed = parseExtView(view);
  if (!parsed) return view;
  const ext = extensions.find((e) => e.id === parsed.extensionId);
  const contribution = ext?.ui?.find((c) => c.id === parsed.contributionId);
  return contribution?.title ?? parsed.contributionId;
}

const GATE_STYLE: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

const NO_EXTENSIONS: AppState['extensions'] = [];

const SignInScreen = PRODUCT_SHELL.SignIn ?? SignIn;
const ShellSidebar = PRODUCT_SHELL.Sidebar ?? Sidebar;
const Frame = PRODUCT_SHELL.Frame ?? React.Fragment;
const useProductShell = PRODUCT_SHELL.useShell ?? (() => {});

/** What the shell renders on. A feed push that changes only counts or
 *  recent items leaves every field equal (pushes are reconciled, so
 *  `extensions` keeps its reference), and the shell does not re-render. */
function selectShellGate(s: AppState | null) {
  return {
    loaded: s !== null,
    signedIn: s !== null && s.identity !== null,
    ready: s?.ready !== false,
    principal: s?.identity
      ? JSON.stringify([...s.identity.emails].sort())
      : null,
    extensions: s?.extensions ?? NO_EXTENSIONS,
  };
}

export default function App(): React.ReactElement {
  const gate = useAppGate(selectShellGate);

  const nav = useNavigation<View, ViewParams>(INITIAL_VIEW, resolveInitialView);
  useProductShell({ principal: gate.principal, navigate: nav.navigate });

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
          <SignInScreen />
        </div>
      </>
    );
  }

  // Gate 3: signed in, but the first snapshot is a bootstrap one with
  // `ready: false` and no accounts. Showing the shell now would turn that
  // emptiness into a false "no sources" state.
  if (!gate.ready) {
    return (
      <Frame>
        <TitleBar />
        <div className="ac" style={GATE_STYLE}>
          <BootSplash />
        </div>
      </Frame>
    );
  }

  const { view, params, navigate, resolved } = nav;
  const screen = screenRegistry.get(view, params, navigate, gate.extensions);
  const frame = screenRegistry.frame(view);

  return (
    <Frame>
      {/* Keyed by who is signed in: another account starts a fresh shell. */}
      <ViewContext.Provider key={gate.principal} value={nav}>
        <IconSprite />
        <InstallLinks />
        <SourceDescriptorsProvider
          hidden={SOURCES_POLICY.hidden}
          showGetStarted={SOURCES_POLICY.showGetStarted}
        >
          <AppShell sidebar={<ShellSidebar />}>
            <React.Fragment key={`${view}:${resolved?.epoch ?? 0}`}>
              {frame === 'page' ? (
                screen
              ) : (
                <HostFrame title={routeTitle(view, gate.extensions)}>
                  {screen}
                </HostFrame>
              )}
            </React.Fragment>
          </AppShell>
        </SourceDescriptorsProvider>
      </ViewContext.Provider>
    </Frame>
  );
}
