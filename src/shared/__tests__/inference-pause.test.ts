import { inferencePause } from '../inference-pause';
import { LaneClosedError, ModelChangedError } from '../contracts';
import { NoProviderError } from '../../main/core/inference';

describe('inferencePause', () => {
  it.each([
    [new LaneClosedError(), 'lane-closed'],
    [new ModelChangedError(1, 2, 'm', 'generation'), 'model-changed'],
    [new NoProviderError('complete'), 'no-provider'],
    // what an extension sees after the RPC hop: a plain object with a name
    [{ name: 'LaneClosedError' }, 'lane-closed'],
    [{ name: 'ModelChangedError' }, 'model-changed'],
    [{ name: 'NoProviderError' }, 'no-provider'],
  ])('classifies %p as %s', (err, reason) => {
    expect(inferencePause(err)).toBe(reason);
  });

  it.each([
    [new Error('boom')],
    [{ name: 'AbortError' }],
    [{ name: 'toString' }],
    [{ name: 7 }],
    [{}],
    ['LaneClosedError'],
    [null],
    [undefined],
  ])('answers null for %p', (err) => {
    expect(inferencePause(err)).toBeNull();
  });
});
