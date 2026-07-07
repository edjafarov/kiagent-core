import React from 'react';
import type { View, ViewParams } from '@renderer/state/view';
import { Sources } from '@renderer/screens/Sources';
import { Connection } from '@renderer/screens/Connection';
import { Logs } from '@renderer/screens/Logs';
import { Marketplace } from '@renderer/screens/Marketplace';
import { Settings } from '@renderer/screens/Settings';

export interface ScreenFactory {
  factory: (
    params: ViewParams,
    navigate: (to: View, params?: ViewParams) => void,
  ) => React.ReactElement;
  usesTopBar: boolean;
}

export type ScreenDefinitions = Partial<Record<View, ScreenFactory>>;

export interface ScreenRegistry {
  get(
    view: View,
    params: ViewParams,
    navigate: (to: View, params?: ViewParams) => void,
  ): React.ReactElement | null;
  usesTopBar(view: View): boolean;
}

export function getDefaultScreens(): ScreenDefinitions {
  return {
    sources: {
      factory: (_params, navigate) => (
        <Sources onOpenConnection={() => navigate('connection')} />
      ),
      usesTopBar: true,
    },
    connection: { factory: () => <Connection />, usesTopBar: true },
    // Logs draws its own dedicated top bar (back button, wordmark, live
    // pill) instead of the shared <TopBar/> — see ui-inventory.md §2.5.
    logs: { factory: () => <Logs />, usesTopBar: false },
    marketplace: { factory: () => <Marketplace />, usesTopBar: true },
    settings: { factory: () => <Settings />, usesTopBar: true },
  };
}

export function createScreenRegistry(
  screens: ScreenDefinitions,
): ScreenRegistry {
  return {
    get(view, params, navigate) {
      const screen = screens[view];
      if (!screen) return null;
      return screen.factory(params, navigate);
    },
    usesTopBar(view) {
      return screens[view]?.usesTopBar ?? false;
    },
  };
}
