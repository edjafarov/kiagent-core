import type { InferenceProvider } from '@shared/contracts';

import { createInference, LaneClosedError } from '../inference';

const logs = { log: () => {} } as any;
const embedder = (out: Float32Array[]): InferenceProvider => ({
  id: 'local-embed',
  supports: ['embed'],
  status: () => 'ready',
  describe: () => ({ modelId: 'embeddinggemma-300m-qat-Q8_0' }),
  handle: jest.fn(async () => out),
});

describe('inference.embed', () => {
  it('runs on the background lane and returns vectors + modelId', async () => {
    const inf = createInference(logs, { generationSeed: 1 });
    inf.setLanePolicy(() => true);
    const p = embedder([new Float32Array([1, 2])]);
    inf.register(p);
    const r = await inf.embed(['hi'], { task: 'messages.sort' });
    expect(r.modelId).toBe('embeddinggemma-300m-qat-Q8_0');
    expect(Array.from(r.vectors[0])).toEqual([1, 2]);
    expect((p.handle as jest.Mock).mock.calls[0][0]).toEqual({
      kind: 'embed',
      lane: 'background',
      payload: { texts: ['hi'] },
    });
  });

  it('obeys a closed background lane', async () => {
    const inf = createInference(logs);
    inf.setLanePolicy(() => false);
    inf.register(embedder([]));
    await expect(inf.embed(['x'])).rejects.toBeInstanceOf(LaneClosedError);
  });

  it('with no embedding provider throws NoProviderError(embed)', async () => {
    const inf = createInference(logs);
    inf.setLanePolicy(() => true);
    await expect(inf.embed(['x'])).rejects.toMatchObject({
      name: 'NoProviderError',
      kind: 'embed',
    });
  });

  it('shows as an active call with its task while running', async () => {
    const inf = createInference(logs);
    inf.setLanePolicy(() => true);
    let seen: unknown[] = [];
    const p = embedder([]);
    (p.handle as jest.Mock).mockImplementation(async () => {
      seen = inf.activeCalls.list();
      return [];
    });
    inf.register(p);
    await inf.embed(['x'], { task: 'messages.sort' });
    expect(seen).toEqual([{ op: 'embed', task: 'messages.sort' }]);
  });
});
