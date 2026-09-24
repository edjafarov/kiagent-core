import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { ExtensionSnapshot } from '@shared/contracts';
import {
  ContributedPage,
  pageCacheKey,
  __resetPageCache,
  type LoadModule,
  type PageProps,
} from '@renderer/contributed-page';

const ext = (over: Partial<ExtensionSnapshot> = {}): ExtensionSnapshot => ({
  id: 'kia.cal',
  name: 'Cal',
  version: '1.0.0',
  origin: 'marketplace',
  enabled: true,
  status: 'activated',
  caps: [],
  sourceIds: [],
  oauthSources: [],
  ui: [{ id: 'calendar', slot: 'screen', title: 'Calendar' }],
  activatedAt: '2026-09-24T10:00:00.000Z',
  ...over,
});

let invoke: jest.Mock;
beforeEach(() => {
  __resetPageCache();
  invoke = jest.fn(async () => ({ source: 'SRC' }));
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke,
    on: () => () => {},
  };
});

it('fetches the source and renders the default export with params and navigate', async () => {
  const navigate = jest.fn();
  const loadModule: LoadModule = jest.fn(async () => ({
    default: (p: PageProps) => (
      <button type="button" onClick={() => p.navigate('logs')}>
        page {p.params.anchor}
      </button>
    ),
  }));
  render(
    <ContributedPage
      ext={ext()}
      contributionId="calendar"
      params={{ anchor: 'd' }}
      navigate={navigate}
      loadModule={loadModule}
    />,
  );
  (await screen.findByText('page d')).click();
  expect(navigate).toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith('extensions:ui-source', {
    extensionId: 'kia.cal',
    contributionId: 'calendar',
  });
  expect(loadModule).toHaveBeenCalledWith('SRC');
});

it('a second mount of the same activation reuses the loaded module', async () => {
  const loadModule = jest.fn(async () => ({ default: () => <div>ok</div> }));
  const props = {
    ext: ext(),
    contributionId: 'calendar',
    params: {},
    navigate: jest.fn(),
    loadModule,
  };
  const { unmount } = render(<ContributedPage {...props} />);
  await screen.findByText('ok');
  unmount();
  render(<ContributedPage {...props} />);
  await screen.findByText('ok');
  expect(loadModule).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('import failure → load-failed naming the extension; the next visit retries', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const loadModule = jest.fn(async () => {
    throw new Error('boom');
  });
  const props = {
    ext: ext(),
    contributionId: 'calendar',
    params: {},
    navigate: jest.fn(),
    loadModule,
  };
  const { unmount } = render(<ContributedPage {...props} />);
  expect(
    await screen.findByText(/Cal couldn.t load this screen/i),
  ).toBeInTheDocument();
  unmount();
  render(<ContributedPage {...props} />);
  await screen.findByText(/Cal couldn.t load this screen/i);
  expect(loadModule).toHaveBeenCalledTimes(2);
  spy.mockRestore();
});

it('render throw → error state; a new activatedAt reloads and clears it', async () => {
  let bad = true;
  const loadModule = jest.fn(async () => ({
    default: () => {
      if (bad) throw new Error('x');
      return <div>ok</div>;
    },
  }));
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const { rerender } = render(
    <ContributedPage
      ext={ext()}
      contributionId="calendar"
      params={{}}
      navigate={jest.fn()}
      loadModule={loadModule}
    />,
  );
  expect(await screen.findByText(/hit an error/i)).toBeInTheDocument();
  bad = false;
  rerender(
    <ContributedPage
      ext={ext({ activatedAt: '2026-09-24T11:00:00.000Z' })}
      contributionId="calendar"
      params={{}}
      navigate={jest.fn()}
      loadModule={loadModule}
    />,
  );
  expect(await screen.findByText('ok')).toBeInTheDocument();
  expect(loadModule).toHaveBeenCalledTimes(2);
  spy.mockRestore();
});

it('two contributions of one extension do not collide in the cache', () => {
  expect(pageCacheKey(ext(), 'a')).not.toBe(pageCacheKey(ext(), 'b'));
  expect(pageCacheKey(ext(), 'a')).toBe(
    'kia.cal/a@1.0.0#2026-09-24T10:00:00.000Z',
  );
});
