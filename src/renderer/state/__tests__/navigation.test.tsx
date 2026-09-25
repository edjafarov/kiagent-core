import '@testing-library/jest-dom';
import React from 'react';
import { act, render } from '@testing-library/react';
import { useNavigation, type Navigation } from '../navigation';

type V = 'home' | 'logs' | 'settings';

function mount(initial: () => { view: V; epoch: number } | null = () => null) {
  const ref: { current: Navigation<V, { pane?: string }> | null } = {
    current: null,
  };
  function Probe(): null {
    ref.current = useNavigation<V, { pane?: string }>('home', initial);
    return null;
  }
  render(<Probe />);
  return (): Navigation<V, { pane?: string }> => ref.current!;
}

describe('useNavigation', () => {
  it('starts on the default view, or on the initial target', () => {
    expect(mount()().view).toBe('home');
    expect(mount(() => ({ view: 'logs', epoch: 0 }))().view).toBe('logs');
  });

  it('navigates, goes back, and remounts on re-navigation', () => {
    const nav = mount();
    act(() => nav().navigate('logs'));
    const { epoch } = nav().resolved!;
    act(() => nav().navigate('logs'));
    expect(nav().resolved!.epoch).toBe(epoch + 1);
    act(() => nav().back());
    expect(nav().view).toBe('home');
  });

  it('replaces params in place: same epoch, no history entry', () => {
    const nav = mount();
    act(() => nav().navigate('settings', { pane: 'about' }));
    const { epoch } = nav().resolved!;
    act(() => nav().replaceParams({ pane: 'storage' }));
    expect(nav().params).toEqual({ pane: 'storage' });
    expect(nav().resolved!.epoch).toBe(epoch);
    act(() => nav().back());
    expect(nav().view).toBe('home');
  });

  it('reopens Settings on the pane last shown; a non-string argument means none', () => {
    const nav = mount();
    act(() => nav().openSettings('advanced'));
    act(() => nav().navigate('logs'));
    act(() => (nav().openSettings as (x: unknown) => void)({ type: 'click' }));
    expect(nav().view).toBe('settings');
    expect(nav().params).toEqual({ pane: 'advanced' });
  });
});
