import React from 'react';

// A product replaces the two composition files; these mocks stand in for
// its copies.
jest.mock('@shared/composition', () => ({
  PRODUCT_ROUTES: { home: { title: 'Home' } },
  PRODUCT_INITIAL_VIEW: 'home',
  ATTENTION_ACTION_POLICY: { views: ['home'], paramKeys: [] },
  SOURCES_POLICY: { hidden: [], showGetStarted: true },
}));
jest.mock('@renderer/composition', () => ({
  PRODUCT_SCREENS: {
    home: { frame: 'page', factory: () => <div>product home</div> },
    sources: { frame: 'page', factory: () => <div>product sources</div> },
  },
}));

/* eslint-disable import/first */
import {
  INITIAL_VIEW,
  KNOWN_VIEWS,
  ROUTE_META,
  isKnownView,
} from '@renderer/state/view';
import {
  createScreenRegistry,
  getDefaultScreens,
} from '@renderer/screen-registry';
import { ATTENTION_ACTION_POLICY } from '@main/attention/action-policy';

describe('product composition', () => {
  it('adds the product routes to the catalog', () => {
    expect(KNOWN_VIEWS).toEqual([
      'home',
      'sources',
      'connection',
      'logs',
      'outbox',
      'settings',
    ]);
    expect(isKnownView('home')).toBe(true);
    expect((ROUTE_META as Record<string, { title: string }>).home.title).toBe(
      'Home',
    );
  });

  it('opens on the product initial view', () => {
    expect(INITIAL_VIEW).toBe('home');
  });

  it('mounts product screens, and lets one replace a core screen', () => {
    const registry = createScreenRegistry(getDefaultScreens());
    const render = (view: string) =>
      registry.get(view as never, {}, () => {}, []) as React.ReactElement<{
        children: string;
      }>;
    expect(render('home').props.children).toBe('product home');
    expect(render('sources').props.children).toBe('product sources');
    expect(render('logs')).not.toBeNull();
  });

  it('gives the attention service the product allow-list', () => {
    expect(ATTENTION_ACTION_POLICY.views).toEqual(['home']);
  });
});
