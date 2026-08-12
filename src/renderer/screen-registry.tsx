import React from 'react';
import type { View, ViewParams } from '@renderer/state/view';
import { Sources } from '@renderer/screens/Sources';
import { Connection } from '@renderer/screens/Connection';
import { Logs } from '@renderer/screens/Logs';
import { Outbox } from '@renderer/screens/Outbox';
import { Marketplace } from '@renderer/screens/Marketplace';

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

export function createScreenRegistry(
  screens: ScreenDefinitions,
): ScreenRegistry {
  return {
    get(view, params, navigate) {
      const screen = screens[view];
      if (!screen) return null;
      return screen.factory(params, navigate);
    },
  };
}
