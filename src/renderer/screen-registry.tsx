import React from 'react';
import type { ExtensionSnapshot } from '@shared/contracts';
import {
  isKnownView,
  parseExtView,
  type View,
  type ViewParams,
} from '@renderer/state/view';
import { Sources } from '@renderer/screens/Sources';
import { Connection } from '@renderer/screens/Connection';
import { Logs } from '@renderer/screens/Logs';
import { Outbox } from '@renderer/screens/Outbox';
import { Marketplace } from '@renderer/screens/Marketplace';
import {
  ContributedUnavailable,
  type ContributedUnavailableReason,
} from '@renderer/screens/ContributedUnavailable';
import { ContributedScreenBoundary } from '@renderer/screens/ContributedScreenBoundary';

/** Calls the factory INSIDE React's render, not eagerly inside `get()` —
 *  `<Boundary>{factory.factory(params, navigate)}</Boundary>` would invoke
 *  the factory as a plain JS call while building the JSX tree, so a throw
 *  would escape `get()` itself and never reach the boundary below it. This
 *  tiny component is what makes the factory call a React render, which is
 *  the only kind of throw an error boundary can catch. */
function ContributedScreenFactory(props: {
  factory: ScreenFactory;
  params: ViewParams;
  navigate: (to: View, params?: ViewParams) => void;
}): React.ReactElement {
  return props.factory.factory(props.params, props.navigate);
}

export interface ScreenFactory {
  factory: (
    params: ViewParams,
    navigate: (to: View, params?: ViewParams) => void,
  ) => React.ReactElement;
}

export type ScreenDefinitions = Partial<Record<View, ScreenFactory>>;

export interface ScreenRegistry {
  get(
    view: View,
    params: ViewParams,
    navigate: (to: View, params?: ViewParams) => void,
    /** The lifecycle snapshot's extension list — the ONLY source of
     *  availability for a contributed view (B3 item 4: no separate IPC,
     *  no extension-main catalog). Ignored for a `KnownView`. */
    extensions: readonly ExtensionSnapshot[],
  ): React.ReactElement | null;
}

export function getDefaultScreens(): ScreenDefinitions {
  return {
    sources: {
      factory: (_params, navigate) => (
        <Sources onOpenConnection={() => navigate('connection')} />
      ),
    },
    connection: { factory: () => <Connection /> },
    // Logs draws its own header row inside the main pane; the sidebar
    // stays visible (it has no nav entry — entered programmatically).
    logs: { factory: () => <Logs /> },
    outbox: { factory: () => <Outbox /> },
    marketplace: { factory: () => <Marketplace /> },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// B3: the contributed-screen seam. Core registers NOTHING here — a product
// build's generated module (emitted from discovered `contributes.ui`
// manifests, per the design spec's "Build-time composition") is the only
// caller of `registerContributedScreens`, typically once at module load.
// A full replace on every call (not a merge) — deliberate, so a dev-loop
// re-registration after a manifest edit never leaves a stale entry behind.
// ─────────────────────────────────────────────────────────────────────────

let contributedScreens: Partial<Record<string, ScreenFactory>> = {};

export function registerContributedScreens(
  screens: Partial<Record<string, ScreenFactory>>,
): void {
  contributedScreens = { ...screens };
}

/** Test-only escape hatch: `contributedScreens` is module-level state, so
 *  jest test files that register a fixture factory must clear it in
 *  afterEach or leak across files sharing this module. Harmless to call in
 *  production — nothing does. */
export function resetContributedScreens(): void {
  contributedScreens = {};
}

/** `null` means available — render the factory. Order matters: an
 *  extension's own status (disabled/activating/failed) wins over a live,
 *  registered factory, so a live factory is never shown for an extension
 *  that isn't actually running. */
function resolveUnavailableReason(
  ext: ExtensionSnapshot | undefined,
  contributionId: string,
  hasFactory: boolean,
): ContributedUnavailableReason | null {
  if (!ext) return 'not-installed';
  if (!ext.enabled) return 'disabled';
  if (ext.status === 'errored') return 'failed';
  // Positive gate: only 'activated' may mount a live factory. Listing the
  // bad statuses instead fails OPEN for the first boot snapshot (every
  // enabled entry starts as status 'disabled') and for any status added
  // later.
  if (ext.status !== 'activated') return 'activating';
  const declared = (ext.ui ?? []).some((c) => c.id === contributionId);
  if (!declared) return 'not-installed';
  if (!hasFactory) return 'no-factory';
  return null;
}

export function createScreenRegistry(
  screens: ScreenDefinitions,
): ScreenRegistry {
  return {
    get(view, params, navigate, extensions) {
      if (isKnownView(view)) {
        const screen = screens[view];
        if (!screen) return null;
        return screen.factory(params, navigate);
      }
      const parsed = parseExtView(view);
      // Not a well-formed contributed view id either — nothing routes it.
      if (!parsed) return null;
      const { extensionId, contributionId } = parsed;
      const ext = extensions.find((e) => e.id === extensionId);
      const factory = contributedScreens[view];
      const reason = resolveUnavailableReason(
        ext,
        contributionId,
        factory != null,
      );
      const extensionName = ext?.name ?? extensionId;
      if (reason) {
        return (
          <ContributedUnavailable
            extensionName={extensionName}
            reason={reason}
          />
        );
      }
      return (
        <ContributedScreenBoundary extensionName={extensionName}>
          <ContributedScreenFactory
            factory={factory!}
            params={params}
            navigate={navigate}
          />
        </ContributedScreenBoundary>
      );
    },
  };
}
