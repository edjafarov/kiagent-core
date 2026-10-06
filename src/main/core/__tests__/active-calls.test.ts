import { createActiveCalls } from '../active-calls';

test('enter/leave keeps start order and notifies each change', () => {
  const a = createActiveCalls();
  const seen: string[] = [];
  a.onChange((l) => seen.push(l.map((c) => c.op).join(',')));
  const leaveSee = a.enter('see', 'vision.describe');
  const leaveHear = a.enter('hear', null);
  expect(a.list()).toEqual([
    { op: 'see', task: 'vision.describe' },
    { op: 'hear', task: null },
  ]);
  leaveSee();
  leaveSee(); // idempotent: no second removal, no extra notification
  leaveHear();
  expect(a.list()).toEqual([]);
  expect(seen).toEqual(['see', 'see,hear', 'hear', '']);
});

test('unsubscribe stops notifications', () => {
  const a = createActiveCalls();
  const fn = jest.fn();
  const off = a.onChange(fn);
  off();
  a.enter('complete', null)();
  expect(fn).not.toHaveBeenCalled();
});
