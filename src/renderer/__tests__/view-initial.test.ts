import { resolveInitialView } from '@renderer/state/view';

describe('resolveInitialView', () => {
  it('is null without a hash', () => {
    expect(resolveInitialView('')).toBeNull();
    expect(resolveInitialView('#')).toBeNull();
  });

  it('reads a known view and its params', () => {
    const params = encodeURIComponent(JSON.stringify({ pane: 'about' }));
    expect(resolveInitialView(`#view=settings&params=${params}`)).toEqual({
      view: 'settings',
      params: { pane: 'about' },
      epoch: 0,
    });
  });

  it('accepts a contributed view id', () => {
    expect(
      resolveInitialView('#view=ext:kia.google-calendar/calendar')?.view,
    ).toBe('ext:kia.google-calendar/calendar');
  });

  it('ignores an unknown view and bad params', () => {
    expect(resolveInitialView('#view=nope')).toBeNull();
    expect(resolveInitialView('#view=logs&params=%7Bbad')).toEqual({
      view: 'logs',
      params: undefined,
      epoch: 0,
    });
  });
});
