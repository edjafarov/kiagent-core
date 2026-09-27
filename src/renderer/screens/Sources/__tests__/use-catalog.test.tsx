import { act, renderHook } from '@testing-library/react';
import type { MarketplaceListItem } from '@shared/ipc';
import { invalidateStoreListing } from '@renderer/extensions/store-listing';
import { useCatalog } from '../use-catalog';

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) =>
    sel({ extensions: [], accounts: [] }),
}));
jest.mock('../sources-registry', () => ({
  useSourceDescriptors: () => [],
}));

let list: jest.Mock;
beforeEach(() => {
  invalidateStoreListing();
  list = jest.fn(() => Promise.resolve([] as MarketplaceListItem[]));
  (window as any).kiagent = {
    invoke: (ch: string) =>
      ch === 'marketplace:list' ? list() : Promise.resolve(null),
  };
});
afterEach(() => {
  delete (window as any).kiagent;
});

test('two catalogs on screen share one store fetch', async () => {
  renderHook(() => useCatalog());
  renderHook(() => useCatalog());
  await act(async () => {});
  expect(list).toHaveBeenCalledTimes(1);
});

test('a failed fetch is asked again by the next mount', async () => {
  list.mockImplementationOnce(() => Promise.reject(new Error('offline')));
  const first = renderHook(() => useCatalog());
  await act(async () => {});
  expect(first.result.current.storeError).toBe('offline');
  const second = renderHook(() => useCatalog());
  await act(async () => {});
  expect(list).toHaveBeenCalledTimes(2);
  expect(second.result.current.storeError).toBeNull();
});

test('a mount after invalidateStoreListing fetches again', async () => {
  renderHook(() => useCatalog()).unmount();
  await act(async () => {});
  renderHook(() => useCatalog());
  await act(async () => {});
  expect(list).toHaveBeenCalledTimes(1);
  invalidateStoreListing();
  renderHook(() => useCatalog());
  await act(async () => {});
  expect(list).toHaveBeenCalledTimes(2);
});
