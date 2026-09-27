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
import { Settings } from '@renderer/screens/Settings';
import {
  ContributedUnavailable,
  type ContributedUnavailableReason,
} from '@renderer/screens/ContributedUnavailable';
import { ContributedPage } from '@renderer/contributed-page';

/** 'page': the screen renders its own Page (top bar + pane).
 *  'host': App renders the top bar and puts the screen in the legacy frame. */
export type ScreenFrame = 'page' | 'host';

export interface ScreenFactory {
  frame?: ScreenFrame;
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
  /** Who renders the view's top bar. Contributed views are always 'host'. */
  frame(view: View): ScreenFrame;
}

export function getDefaultScreens(): ScreenDefinitions {
  return {
    sources: {
      frame: 'page',
      factory: (_params, navigate) => (
        <Sources onOpenConnection={() => navigate('connection')} />
      ),
    },
    connection: { frame: 'page', factory: () => <Connection /> },
    // Logs is a page under Settings (breadcrumb "Settings › Logs"); it has
    // no nav entry — General › Diagnostics and error cards open it.
    logs: { frame: 'page', factory: () => <Logs /> },
    outbox: { frame: 'page', factory: () => <Outbox /> },
    settings: {
      frame: 'page',
      factory: (params) => <Settings pane={params.pane} />,
    },
  };
}

/** `null` means available — mount the page. Order matters: an extension's
 *  own status (disabled/activating/failed) wins, so a page is never loaded
 *  for an extension that isn't actually running. */
function resolveUnavailableReason(
  ext: ExtensionSnapshot | undefined,
  contributionId: string,
): ContributedUnavailableReason | null {
  if (!ext) return 'not-installed';
  if (!ext.enabled) return 'disabled';
  if (ext.status === 'errored') return 'failed';
  if (ext.status === 'needs-consent') return 'needs-consent';
  // Positive gate: only 'activated' may mount a page. Listing the
  // bad statuses instead fails OPEN for the first boot snapshot (every
  // enabled entry starts as status 'disabled') and for any status added
  // later.
  if (ext.status !== 'activated') return 'activating';
  const declared = (ext.ui ?? []).some((c) => c.id === contributionId);
  if (!declared) return 'not-installed';
  return null;
}

export function createScreenRegistry(
  screens: ScreenDefinitions,
): ScreenRegistry {
  return {
    frame(view) {
      return isKnownView(view) ? (screens[view]?.frame ?? 'host') : 'host';
    },
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
      const reason = resolveUnavailableReason(ext, contributionId);
      if (!ext || reason) {
        return (
          <ContributedUnavailable
            extensionName={ext?.name ?? extensionId}
            reason={reason ?? 'not-installed'}
          />
        );
      }
      return (
        <ContributedPage
          ext={ext}
          contributionId={contributionId}
          params={params}
          navigate={navigate}
        />
      );
    },
  };
}
