import React, { Profiler } from 'react';
import { act, render } from '@testing-library/react';
import { everyWhileVisible, useNow } from '../time';

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function Clock(): React.ReactElement {
  const now = useNow(10_000);
  return <span>{now}</span>;
}

const intervalsOf = (spy: jest.SpyInstance, ms: number) =>
  spy.mock.calls.filter((call) => call[1] === ms).length;

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
});

test('everyWhileVisible ticks while visible, stops while hidden, catches up when shown', () => {
  const fn = jest.fn();
  const stop = everyWhileVisible(fn, 1000);
  jest.advanceTimersByTime(3000);
  expect(fn).toHaveBeenCalledTimes(3);
  setVisibility('hidden');
  jest.advanceTimersByTime(10_000);
  expect(fn).toHaveBeenCalledTimes(3);
  setVisibility('visible');
  expect(fn).toHaveBeenCalledTimes(4);
  jest.advanceTimersByTime(1000);
  expect(fn).toHaveBeenCalledTimes(5);
  stop();
  jest.advanceTimersByTime(5000);
  setVisibility('hidden');
  setVisibility('visible');
  expect(fn).toHaveBeenCalledTimes(5);
});

test('started hidden, nothing ticks until the window is shown', () => {
  setVisibility('hidden');
  const fn = jest.fn();
  const stop = everyWhileVisible(fn, 1000);
  jest.advanceTimersByTime(60_000);
  expect(fn).not.toHaveBeenCalled();
  setVisibility('visible');
  expect(fn).toHaveBeenCalledTimes(1);
  stop();
});

test('three useNow consumers share one interval; the last one out clears it', () => {
  const set = jest.spyOn(window, 'setInterval');
  const clear = jest.spyOn(window, 'clearInterval');
  const { unmount } = render(
    <>
      <Clock />
      <Clock />
      <Clock />
    </>,
  );
  expect(intervalsOf(set, 10_000)).toBe(1);
  unmount();
  expect(clear).toHaveBeenCalledTimes(1);
});

test('a useNow consumer commits nothing while hidden and once when shown', () => {
  // Relies on modern fake timers faking Date: the catch-up setNow gets a
  // new value only because Date.now() advanced. Do not switch to legacy.
  let commits = 0;
  render(
    <Profiler
      id="clock"
      onRender={() => {
        commits += 1;
      }}
    >
      <Clock />
    </Profiler>,
  );
  act(() => setVisibility('hidden'));
  commits = 0;
  act(() => {
    jest.advanceTimersByTime(5 * 60_000);
  });
  expect(commits).toBe(0);
  act(() => setVisibility('visible'));
  expect(commits).toBe(1);
});

test('mounted hidden under StrictMode: no interval until shown, then exactly one', () => {
  setVisibility('hidden');
  const set = jest.spyOn(window, 'setInterval');
  render(
    <React.StrictMode>
      <Clock />
    </React.StrictMode>,
  );
  expect(intervalsOf(set, 10_000)).toBe(0);
  act(() => setVisibility('visible'));
  expect(intervalsOf(set, 10_000)).toBe(1);
});
