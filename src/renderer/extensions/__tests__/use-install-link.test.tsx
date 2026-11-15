import React from 'react';
import { act, render } from '@testing-library/react';
import { ViewContext, type ViewContextValue } from '@renderer/state/view';
import { useInstallLink } from '../use-install-link';

function Probe(): null {
  useInstallLink();
  return null;
}

describe('useInstallLink', () => {
  let pending: Array<{
    seq: number;
    owner: string;
    repo: string;
    tag?: string;
  } | null>;
  let nudge: () => void;
  let nav: jest.Mocked<Pick<ViewContextValue, 'navigate' | 'replaceParams'>> &
    ViewContextValue;

  beforeEach(() => {
    pending = [];
    (window as unknown as { kiagent: unknown }).kiagent = {
      invoke: jest.fn(async () => pending.shift() ?? null),
      on: jest.fn((_ch: string, fn: () => void) => {
        nudge = fn;
        return () => {};
      }),
    };
    nav = {
      view: 'home',
      params: {},
      navigate: jest.fn(),
      back: jest.fn(),
      openSettings: jest.fn(),
      replaceParams: jest.fn(),
    } as never;
  });

  const mount = () =>
    render(
      <ViewContext.Provider value={nav}>
        <Probe />
      </ViewContext.Provider>,
    );

  it('takes a link waiting at mount and routes to the Sources catalog', async () => {
    pending.push({ seq: 1, owner: 'o', repo: 'r', tag: 'v1' });
    mount();
    await act(async () => {});
    expect(nav.navigate).toHaveBeenCalledWith('sources', {
      add: '',
      link: 'o/r@v1',
      linkSeq: '1',
    });
  });

  it('the same link twice routes twice, with distinct seqs', async () => {
    mount();
    await act(async () => {});
    pending.push({ seq: 1, owner: 'o', repo: 'r' });
    await act(async () => nudge());
    pending.push({ seq: 2, owner: 'o', repo: 'r' });
    await act(async () => nudge());
    expect(nav.navigate.mock.calls.map((c) => c[1])).toEqual([
      { add: '', link: 'o/r', linkSeq: '1' },
      { add: '', link: 'o/r', linkSeq: '2' },
    ]);
  });

  it('on Sources it replaces params instead of remounting the screen', async () => {
    nav.view = 'sources';
    nav.params = { accountId: 'a1' };
    pending.push({ seq: 3, owner: 'o', repo: 'r' });
    mount();
    await act(async () => {});
    expect(nav.replaceParams).toHaveBeenCalledWith({
      accountId: 'a1',
      add: '',
      link: 'o/r',
      linkSeq: '3',
    });
    expect(nav.navigate).not.toHaveBeenCalled();
  });
});
