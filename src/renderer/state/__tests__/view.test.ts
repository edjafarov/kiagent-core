import { nextResolved, type ResolvedView } from '../view';

describe('nextResolved', () => {
  test('first navigation starts at epoch 1 and pushes nothing', () => {
    expect(nextResolved(null, 'sources')).toEqual({
      next: { view: 'sources', params: undefined, epoch: 1 },
      push: false,
    });
  });

  test('cross-view navigation bumps epoch and pushes history', () => {
    const prev: ResolvedView = { view: 'sources', epoch: 3 };
    expect(nextResolved(prev, 'marketplace')).toEqual({
      next: { view: 'marketplace', params: undefined, epoch: 4 },
      push: true,
    });
  });

  test('same-view re-navigation bumps epoch but does NOT push history', () => {
    const prev: ResolvedView = { view: 'sources', epoch: 3 };
    const { next, push } = nextResolved(prev, 'sources');
    expect(next.epoch).toBe(4); // key change → screen remounts → add panel resets
    expect(push).toBe(false); // no duplicate back stop
  });

  test('params ride along', () => {
    const { next } = nextResolved(null, 'connection', { anchor: 'mcp' });
    expect(next.params).toEqual({ anchor: 'mcp' });
  });
});
