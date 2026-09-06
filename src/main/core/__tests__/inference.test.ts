import type { InferenceProvider } from '@shared/contracts';

import {
  createInference,
  LaneClosedError,
  ModelChangedError,
  NoProviderError,
} from '../inference';

const noopLogs = { log: () => {} };

// Alias kept for the generation tests below, which mirror the task-2 brief
// verbatim (it calls this helper `fakeLogs()`) — same object as `noopLogs`.
const fakeLogs = () => noopLogs;

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

/** A provider fixture for the generation/describe tests: unlike `provider()`
 *  above it can report a `modelId` (via `describe`) and fire `onChange`. */
function fakeProvider(opts: {
  id: string;
  supports: InferenceProvider['supports'];
  modelId?: string;
  handle?: InferenceProvider['handle'];
  onChange?: InferenceProvider['onChange'];
}): InferenceProvider {
  return {
    id: opts.id,
    supports: opts.supports,
    status: () => 'ready',
    handle: opts.handle ?? (async (req) => `${opts.id}:${req.kind}`),
    describe: opts.modelId ? () => ({ modelId: opts.modelId! }) : undefined,
    onChange: opts.onChange,
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
    await expect(plane.read(new Uint8Array([1]))).rejects.toThrow(
      /no inference provider/,
    );
  });

  it('hear routes to a provider supporting hear and passes the audio format', async () => {
    const plane = createInference(noopLogs);
    let seen: unknown;
    plane.register({
      id: 'asr',
      supports: ['complete', 'see', 'hear'],
      status: () => 'ready',
      handle: async (req) => {
        seen = req.payload;
        return `asr:${req.kind}`;
      },
    });
    await expect(
      plane.hear(new Uint8Array([1]), { format: 'wav' }),
    ).resolves.toBe('asr:hear');
    expect(seen).toMatchObject({ format: 'wav' });
  });

  it('hear forwards vad, language and detectLanguage to the provider payload', async () => {
    const plane = createInference(noopLogs);
    let seen: unknown;
    plane.register({
      id: 'asr',
      supports: ['complete', 'see', 'hear'],
      status: () => 'ready',
      handle: async (req) => {
        seen = req.payload;
        return `asr:${req.kind}`;
      },
    });
    await expect(
      plane.hear(new Uint8Array([1]), {
        format: 'wav',
        vad: 'required',
        language: 'uk',
        detectLanguage: true,
        model: 'accuracy',
      }),
    ).resolves.toBe('asr:hear');
    expect(seen).toMatchObject({
      vad: 'required',
      language: 'uk',
      detectLanguage: true,
      model: 'accuracy',
    });
  });

  it('hear with no audio provider throws NoProviderError', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('ocr', ['read'], 'ocr'));
    await expect(plane.hear(new Uint8Array([1]))).rejects.toThrow(
      /no inference provider available for 'hear'/,
    );
  });

  it('hear with only local-llm registered throws NoProviderError — Gemma is not an ASR fallback', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('local-llm', ['complete', 'see'], 'llm'));
    await expect(plane.hear(new Uint8Array([1]))).rejects.toBeInstanceOf(
      NoProviderError,
    );
  });

  it('hear routes to a ready local-asr provider', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('local-asr', ['hear'], 'transcript'));
    await expect(plane.hear(new Uint8Array([1]))).resolves.toBe(
      'transcript:hear',
    );
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

  it('notifies lane subscribers only on a real transition', () => {
    const plane = createInference(noopLogs);
    const seen: boolean[] = [];
    const off = plane.onLaneChange((open) => seen.push(open));
    plane.setBackgroundOpen(true); // already true — no event
    plane.setBackgroundOpen(false);
    plane.setBackgroundOpen(false); // no change — no event
    plane.setBackgroundOpen(true);
    off();
    plane.setBackgroundOpen(false); // unsubscribed
    expect(seen).toEqual([false, true]);
  });

  it('bumps the generation on register, unregister and provider change', () => {
    const plane = createInference(fakeLogs(), { generationSeed: 100 });
    let fire: () => void = () => {};
    const p = fakeProvider({
      id: 'x',
      supports: ['complete'],
      modelId: 'm1',
      onChange: (cb) => {
        fire = cb;
        return () => {};
      },
    });
    const off = plane.register(p);
    const g1 = plane.generation();
    fire();
    expect(plane.generation()).toBe(g1 + 1);
    off();
    expect(plane.generation()).toBe(g1 + 2);
  });

  it('rejects a stale generation before the provider is called', async () => {
    const plane = createInference(fakeLogs(), { generationSeed: 100 });
    const handle = jest.fn(async () => 'never');
    plane.register(
      fakeProvider({ id: 'x', supports: ['complete'], modelId: 'm1', handle }),
    );
    const d = await plane.describe('complete');
    plane.register(fakeProvider({ id: 'y', supports: ['see'], modelId: 'm2' })); // bumps
    await expect(
      plane.complete('hi', { maxTokens: 8, generation: d!.generation }),
    ).rejects.toMatchObject({
      name: 'ModelChangedError',
      expected: d!.generation,
      source: 'generation',
    });
    expect(handle).toHaveBeenCalledTimes(0);
  });

  it('succeeds when the current generation is passed', async () => {
    const plane = createInference(fakeLogs(), { generationSeed: 100 });
    const handle = jest.fn(async () => 'ok');
    plane.register(
      fakeProvider({ id: 'x', supports: ['complete'], modelId: 'm1', handle }),
    );
    const d = await plane.describe('complete');
    await expect(
      plane.complete('hi', { maxTokens: 8, generation: d!.generation }),
    ).resolves.toBe('ok');
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('returns the same identity to concurrent describers', async () => {
    const plane = createInference(fakeLogs(), { generationSeed: 7 });
    plane.register(
      fakeProvider({ id: 'x', supports: ['complete'], modelId: 'm1' }),
    );
    const [a, b] = await Promise.all([
      plane.describe('complete'),
      plane.describe('complete'),
    ]);
    expect(a).toEqual(b);
  });

  it('describes null when no provider is ready', async () => {
    const plane = createInference(fakeLogs());
    await expect(plane.describe('complete')).resolves.toBeNull();
  });

  it('returns identity and usage with the completion', async () => {
    const plane = createInference(fakeLogs(), { generationSeed: 5 });
    plane.register(
      fakeProvider({
        id: 'x',
        supports: ['complete'],
        modelId: 'm1',
        handle: async () => ({
          text: 'hi',
          promptTokens: 9,
          completionTokens: 2,
          truncated: true,
        }),
      }),
    );
    await expect(
      plane.completeWithMeta('p', { maxTokens: 8 }),
    ).resolves.toEqual({
      text: 'hi',
      providerId: 'x',
      modelId: 'm1',
      generation: 5,
      profile: 'default',
      promptTokens: 9,
      completionTokens: 2,
      truncated: true,
    });
  });

  it('ModelChangedError is discriminable by name, not instanceof, alone', async () => {
    const plane = createInference(fakeLogs(), { generationSeed: 1 });
    plane.register(
      fakeProvider({ id: 'x', supports: ['complete'], modelId: 'm1' }),
    );
    const d = await plane.describe('complete');
    plane.register(fakeProvider({ id: 'y', supports: ['see'], modelId: 'm2' }));
    let caught: unknown;
    try {
      await plane.complete('hi', { generation: d!.generation });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModelChangedError);
    expect((caught as ModelChangedError).name).toBe('ModelChangedError');
    expect((caught as ModelChangedError).modelId).toBe('m1');
    expect((caught as ModelChangedError).source).toBe('generation');
  });

  it('widens the provider payload with profile, system, generation and expectModelId', async () => {
    const plane = createInference(fakeLogs(), { generationSeed: 42 });
    let seen: unknown;
    plane.register(
      fakeProvider({
        id: 'x',
        supports: ['complete'],
        modelId: 'm1',
        handle: async (req) => {
          seen = req.payload;
          return 'ok';
        },
      }),
    );
    const current = plane.generation();
    await plane.complete('p', {
      maxTokens: 8,
      profile: 'deterministic',
      system: 's',
      generation: current,
    });
    expect(seen).toMatchObject({
      profile: 'deterministic',
      system: 's',
      generation: current,
      expectModelId: 'm1',
    });
  });

  it('defaults profile and omits generation/expectModelId when the caller passes neither', async () => {
    const plane = createInference(fakeLogs(), { generationSeed: 42 });
    let seen: unknown;
    plane.register(
      fakeProvider({
        id: 'x',
        supports: ['complete'],
        modelId: 'm1',
        handle: async (req) => {
          seen = req.payload;
          return 'ok';
        },
      }),
    );
    await plane.complete('p');
    expect(seen).toMatchObject({ profile: 'default' });
    expect((seen as { generation?: number }).generation).toBeUndefined();
    expect((seen as { expectModelId?: string }).expectModelId).toBeUndefined();
  });

  // Fix round, post-review (finding 1): `expectModelId` must carry what the
  // caller's OWN `describe()` call recorded, not a value recomputed fresh
  // at call time — recomputing fresh made the provider-level check in
  // `handle()` structurally unreachable, since both reads happen
  // synchronously in the same JS turn with nothing able to mutate state in
  // between (see the review at tasks-2-3-review.md). This test simulates
  // exactly the scenario the provider-side check exists to catch: an
  // `onChange`-coverage gap, where a provider's model drifts WITHOUT ever
  // calling `onChange`, so the generation never bumps and `checkGeneration`
  // has nothing to reject.
  it('threads the RECORDED describe()-time modelId forward, not a fresh recompute', async () => {
    const plane = createInference(fakeLogs(), { generationSeed: 42 });
    let currentModelId = 'm1';
    let seenPayload: unknown;
    plane.register({
      id: 'x',
      supports: ['complete'],
      status: () => 'ready',
      describe: () => ({ modelId: currentModelId }),
      handle: async (req) => {
        seenPayload = req.payload;
        return 'ok';
      },
    });

    const described = await plane.describe('complete');
    expect(described).toMatchObject({ modelId: 'm1' });

    // The provider's model changes WITHOUT calling onChange — the bug
    // class the provider-level check is a backstop for. The generation
    // therefore does NOT bump, so `checkGeneration` will not reject.
    currentModelId = 'm2';

    await plane.complete('p', { generation: described!.generation });

    // A fresh recompute at call time would report 'm2' (what the provider
    // NOW resolves) — the pre-fix behavior, which can never differ from
    // what handle() itself resolves. The fix threads forward what the
    // caller's earlier lookup actually told them: 'm1'.
    expect((seenPayload as { expectModelId?: string }).expectModelId).toBe(
      'm1',
    );
  });

  // Fix round 2, post-review (finding 1): `describedAt` is a single slot
  // per kind — a SECOND caller's describe() call must not overwrite what
  // an earlier caller's describe() recorded for the same (still-current)
  // generation. Without this, the exact interleaving the check exists to
  // catch — a model drift between two describe() calls at one generation
  // — erases its own evidence: the second call's fresher read would
  // overwrite the first call's now-stale one, and the first caller's
  // later `complete()` would compare against the fresh (already-drifted)
  // value and pass clean.
  it('a later describe() at the same generation does not erase an earlier describe()-time record', async () => {
    const plane = createInference(fakeLogs(), { generationSeed: 42 });
    let currentModelId = 'm1';
    let seenPayload: unknown;
    plane.register({
      id: 'x',
      supports: ['complete'],
      status: () => 'ready',
      describe: () => ({ modelId: currentModelId }),
      handle: async (req) => {
        seenPayload = req.payload;
        return 'ok';
      },
    });

    // Caller A looks up the model first, recording 'm1'.
    const a = await plane.describe('complete');
    expect(a).toMatchObject({ modelId: 'm1' });

    // The model drifts WITHOUT a generation bump — the onChange-coverage
    // gap itself; the generation caller A holds is still current.
    currentModelId = 'm2';

    // Caller B looks up the model SECOND, at the SAME (still-current)
    // generation. B truthfully sees the live 'm2' in its own return
    // value — first-write-wins only pins the INTERNAL record, not what a
    // later describe() call reports to its own caller.
    const b = await plane.describe('complete');
    expect(b).toMatchObject({ modelId: 'm2', generation: a!.generation });

    // Caller A's later call, citing A's OWN generation, must still be
    // checked against A's ORIGINAL recorded modelId ('m1') — not B's
    // fresher 'm2' — or the drift A could have caught is invisible.
    await plane.complete('p', { generation: a!.generation });
    expect((seenPayload as { expectModelId?: string }).expectModelId).toBe(
      'm1',
    );
  });
});
