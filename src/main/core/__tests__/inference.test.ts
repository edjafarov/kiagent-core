import type { InferenceProvider } from '@shared/contracts';

import { createInference, LaneClosedError } from '../inference';

const noopLogs = { log: () => {} };

function provider(
  id: string,
  supports: InferenceProvider['supports'],
  result: string,
): InferenceProvider {
  return {
    id,
    supports,
    status: () => 'ready',
    handle: async (req) => `${result}:${req.kind}`,
  };
}

describe('inference plane', () => {
  it('read routes to the first ready provider supporting read', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('llm', ['complete', 'see'], 'llm'));
    plane.register(provider('ocr', ['read'], 'ocr'));
    await expect(plane.read(new Uint8Array([1]))).resolves.toBe('ocr:read');
    await expect(plane.see(new Uint8Array([1]), 'p')).resolves.toBe('llm:see');
  });

  it('read with no provider throws the settings hint', async () => {
    const plane = createInference(noopLogs);
    await expect(plane.read(new Uint8Array([1]))).rejects.toThrow(/no inference provider/);
  });

  it('background lane fails fast with LaneClosedError while closed', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('ocr', ['read'], 'ocr'));
    plane.setBackgroundOpen(false);
    await expect(
      plane.read(new Uint8Array([1]), { lane: 'background' }),
    ).rejects.toThrow(LaneClosedError);
    plane.setBackgroundOpen(true);
    await expect(
      plane.read(new Uint8Array([1]), { lane: 'background' }),
    ).resolves.toBe('ocr:read');
  });

  it('interactive lane flows while the background lane is closed', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('ocr', ['read'], 'ocr'));
    plane.setBackgroundOpen(false);
    await expect(plane.read(new Uint8Array([1]))).resolves.toBe('ocr:read');
  });
});
