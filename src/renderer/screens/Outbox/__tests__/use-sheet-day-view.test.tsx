import React from 'react';
import { act, render } from '@testing-library/react';
import type { CalendarDayView } from '@shared/ipc';
import { useSheetDayView, type SheetDayView } from '../use-sheet-day-view';

let resolvers: ((v: CalendarDayView | null) => void)[];
beforeEach(() => {
  resolvers = [];
  (window as any).kiagent = {
    invoke: jest.fn(
      () => new Promise((resolve) => resolvers.push(resolve)),
    ),
  };
});
afterEach(() => {
  delete (window as any).kiagent;
});

/** Records what every committed render of the hook returned. */
function Probe(props: {
  revision: number;
  seen: { revision: number; out: SheetDayView }[];
}) {
  const out = useSheetDayView({ id: 'e1', revision: props.revision }, true);
  props.seen.push({ revision: props.revision, out });
  return null;
}

test('no render ever pairs a revision with an older revision’s answer or an un-held Add', async () => {
  const seen: { revision: number; out: SheetDayView }[] = [];
  const { rerender } = render(<Probe revision={1} seen={seen} />);
  await act(async () =>
    resolvers[0]({ revision: 1, html: 'r1', lineHtml: '', busyClash: true }),
  );
  rerender(<Probe revision={2} seen={seen} />);
  for (const { revision, out } of seen.filter((s) => s.revision === 2)) {
    expect(out.day).toBeNull();
    expect(out.checking).toBe(true);
    expect(revision).toBe(2);
  }
  expect(seen.some((s) => s.revision === 2)).toBe(true);
});
