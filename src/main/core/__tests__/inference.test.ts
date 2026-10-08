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

  it('background calls are refused until a lane policy is bound', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('ocr', ['read'], 'ocr'));
    await expect(
      plane.read(new Uint8Array([1]), { lane: 'background' }),
    ).rejects.toThrow(LaneClosedError);
    await expect(plane.read(new Uint8Array([1]))).resolves.toBe('ocr:read');
  });

  it('gate reads the policy on every call (no cached boolean)', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('ocr', ['read'], 'ocr'));
    let open = false;
    plane.setLanePolicy(() => open);
    await expect(
      plane.read(new Uint8Array([1]), { lane: 'background' }),
    ).rejects.toThrow(LaneClosedError);
    open = true;
    await expect(
      plane.read(new Uint8Array([1]), { lane: 'background' }),
    ).resolves.toBe('ocr:read');
  });

  it('interactive calls flow while the policy says closed', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('ocr', ['read'], 'ocr'));
    plane.setLanePolicy(() => false);
    await expect(plane.read(new Uint8Array([1]))).resolves.toBe('ocr:read');
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

describe('tasks and budget keys on calls', () => {
  it('task and budgetKey reach the provider payload for complete and see', async () => {
    const seen: unknown[] = [];
    const plane = createInference(fakeLogs(), { generationSeed: 1 });
    plane.register(
      fakeProvider({
        id: 'p',
        supports: ['complete', 'see'],
        handle: async (req) => {
          seen.push(req.payload);
          return 'ok';
        },
      }),
    );
    await plane.complete('hi', { task: 'task.a', budgetKey: 'k1' });
    await plane.see(new Uint8Array([1]), 'what', {
      task: 'task.b',
      budgetKey: 'k2',
    });
    expect(seen[0]).toMatchObject({ task: 'task.a', budgetKey: 'k1' });
    expect(seen[1]).toMatchObject({ task: 'task.b', budgetKey: 'k2' });
  });

  it('a schema reaches the provider payload for complete', async () => {
    const seen: unknown[] = [];
    const plane = createInference(fakeLogs(), { generationSeed: 1 });
    plane.register(
      fakeProvider({
        id: 'p',
        supports: ['complete'],
        handle: async (req) => {
          seen.push(req.payload);
          return '{}';
        },
      }),
    );
    const schema = { type: 'object' };
    await plane.complete('hi', { schema });
    await plane.complete('hi');
    expect(seen[0]).toMatchObject({ schema });
    expect((seen[1] as { schema?: unknown }).schema).toBeUndefined();
  });

  it("describe with a task doesn't overwrite describe without one", async () => {
    let modelId = 'm1';
    const payloads: Array<Record<string, unknown>> = [];
    const plane = createInference(fakeLogs(), { generationSeed: 1 });
    plane.register({
      id: 'p',
      supports: ['complete'],
      status: () => 'ready',
      describe: () => ({ modelId }),
      handle: async (req) => {
        payloads.push(req.payload as Record<string, unknown>);
        return 'ok';
      },
    });
    const withTask = await plane.describe('complete', 'task.a');
    modelId = 'm2';
    const plain = await plane.describe('complete');
    expect(withTask?.generation).toBe(plain?.generation);
    await plane.complete('hi', { generation: plain!.generation });
    expect(payloads[0].expectModelId).toBe('m2');
  });

  it('seeWithMeta returns text + providerId + modelId', async () => {
    const plane = createInference(fakeLogs(), { generationSeed: 1 });
    plane.register(
      fakeProvider({ id: 'vlm', supports: ['see'], modelId: 'gemma' }),
    );
    await expect(
      plane.seeWithMeta(new Uint8Array([1]), 'what'),
    ).resolves.toEqual({
      text: 'vlm:see',
      providerId: 'vlm',
      modelId: 'gemma',
    });
  });
});

describe('remote providers and per-task routes', () => {
  function remote(
    over: Partial<InferenceProvider> & {
      ready?: (task?: string) => boolean;
    } = {},
  ): InferenceProvider {
    const { ready, ...rest } = over;
    return {
      id: 'r',
      name: 'Remote',
      remote: true,
      supports: ['complete', 'see'],
      status: (task?: string) =>
        (ready ?? (() => true))(task) ? 'ready' : 'standby',
      handle: async (req) => `r:${req.kind}`,
      ...rest,
    };
  }
  const setup = (r = remote()) => {
    const plane = createInference(fakeLogs(), { generationSeed: 1 });
    plane.register(provider('local', ['complete', 'see', 'read'], 'local'));
    const off = plane.register(r);
    return { plane, off };
  };

  it('a route is honoured for its task only', async () => {
    const { plane } = setup();
    plane.setRoute('task.a', 'r');
    await expect(plane.complete('p', { task: 'task.a' })).resolves.toBe(
      'r:complete',
    );
    await expect(plane.complete('p', { task: 'task.b' })).resolves.toBe(
      'local:complete',
    );
  });

  it('remote is never picked without a route', async () => {
    const { plane } = setup();
    await expect(plane.complete('p')).resolves.toBe('local:complete');
    await expect(plane.read(new Uint8Array([1]))).resolves.toBe('local:read');
    await expect(plane.complete('p', { task: 'task.a' })).resolves.toBe(
      'local:complete',
    );
    plane.setRoute('task.a', 'r');
    await expect(plane.complete('p')).resolves.toBe('local:complete');
    await expect(plane.describe('complete')).resolves.toMatchObject({
      providerId: 'local',
    });
    await expect(plane.describe('complete', 'task.a')).resolves.toMatchObject({
      providerId: 'r',
    });
  });

  it('a route to a not-ready-for-task provider → local', async () => {
    const { plane } = setup(remote({ ready: (t) => t !== 'task.a' }));
    plane.setRoute('task.a', 'r');
    await expect(plane.complete('p', { task: 'task.a' })).resolves.toBe(
      'local:complete',
    );
  });

  it('no local → NoProviderError even with a remote registered and unrouted', async () => {
    const plane = createInference(fakeLogs(), { generationSeed: 1 });
    plane.register(remote());
    await expect(plane.complete('p')).rejects.toBeInstanceOf(NoProviderError);
  });

  it('a route flip never moves the generation: a pinned task-less caller survives it', async () => {
    const { plane } = setup();
    const d = await plane.describe('complete');
    plane.setRoute('task.a', 'r');
    plane.setRoute('task.a', null);
    expect(plane.generation()).toBe(d!.generation);
    await expect(
      plane.complete('p', { generation: d!.generation }),
    ).resolves.toBe('local:complete');
  });

  it('routes() reports locality from the provider, and remote for an unknown id', () => {
    const { plane } = setup(remote({ remote: false, name: 'Mine' }));
    plane.setRoute('task.a', 'r');
    plane.setRoute('task.b', 'ghost');
    expect(plane.routes()).toEqual([
      { task: 'task.a', providerName: 'Mine', remote: false },
      { task: 'task.b', providerName: 'ghost', remote: true },
    ]);
  });

  it('the disposer clears routes naming it', async () => {
    const { plane, off } = setup();
    plane.setRoute('task.a', 'r');
    expect(plane.routes()).toEqual([
      { task: 'task.a', providerName: 'Remote', remote: true },
    ]);
    const g = plane.generation();
    off();
    expect(plane.routes()).toEqual([]);
    expect(plane.generation()).toBeGreaterThan(g);
    // Re-registering does not resurrect the old route.
    plane.register(remote());
    await expect(plane.complete('p', { task: 'task.a' })).resolves.toBe(
      'local:complete',
    );
  });

  it("a remote provider's per-call model id is reported (read after the call)", async () => {
    let model = 'before';
    const { plane } = setup(
      remote({
        describe: () => ({ modelId: model }),
        handle: async () => {
          model = 'answered-by';
          return 'text';
        },
      }),
    );
    plane.setRoute('task.a', 'r');
    await expect(
      plane.completeWithMeta('p', { task: 'task.a' }),
    ).resolves.toMatchObject({ providerId: 'r', modelId: 'answered-by' });
    model = 'before';
    await expect(
      plane.seeWithMeta(new Uint8Array([1]), 'p', { task: 'task.a' }),
    ).resolves.toMatchObject({ providerId: 'r', modelId: 'answered-by' });
  });
});

describe('remote → local fallback', () => {
  const unavailable = () =>
    Object.assign(new Error('not now'), { name: 'RemoteUnavailableError' });
  function setup(
    o: {
      remoteHandle?: InferenceProvider['handle'];
      localHandle?: InferenceProvider['handle'];
      localModel?: () => string;
    } = {},
  ) {
    const calls: Array<{ id: string; payload: Record<string, unknown> }> = [];
    const plane = createInference(fakeLogs(), { generationSeed: 1 });
    plane.setLanePolicy(() => true);
    const track =
      (
        id: string,
        h?: InferenceProvider['handle'],
      ): InferenceProvider['handle'] =>
      async (req) => {
        calls.push({ id, payload: req.payload as Record<string, unknown> });
        return h ? h(req) : `${id}:${req.kind}`;
      };
    plane.register({
      id: 'local',
      supports: ['complete', 'see'],
      status: () => 'ready',
      describe: () => ({ modelId: o.localModel?.() ?? 'L' }),
      handle: track('local', o.localHandle),
    });
    const remoteHandle =
      o.remoteHandle ??
      (async () => {
        throw unavailable();
      });
    plane.register({
      id: 'r',
      remote: true,
      supports: ['complete', 'see'],
      status: () => 'ready',
      describe: () => ({ modelId: 'R' }),
      handle: track('r', remoteHandle),
    });
    plane.setRoute('task.a', 'r');
    return { plane, calls };
  }

  it('RemoteUnavailableError → exactly one local retry, and the meta reports local', async () => {
    const { plane, calls } = setup();
    await expect(
      plane.completeWithMeta('p', { task: 'task.a' }),
    ).resolves.toMatchObject({
      text: 'local:complete',
      providerId: 'local',
      modelId: 'L',
    });
    expect(calls.map((c) => c.id)).toEqual(['r', 'local']);
    await expect(
      plane.seeWithMeta(new Uint8Array([1]), 'p', { task: 'task.a' }),
    ).resolves.toEqual({
      text: 'local:see',
      providerId: 'local',
      modelId: 'L',
    });
    await expect(plane.complete('p', { task: 'task.a' })).resolves.toBe(
      'local:complete',
    );
  });

  it('the local retry failing propagates its own error (no second retry)', async () => {
    const { plane, calls } = setup({
      localHandle: async () => {
        throw new Error('local broke');
      },
    });
    await expect(plane.complete('p', { task: 'task.a' })).rejects.toThrow(
      'local broke',
    );
    expect(calls.map((c) => c.id)).toEqual(['r', 'local']);
  });

  it('a local provider error is never retried on a remote', async () => {
    const { plane, calls } = setup({
      localHandle: async () => {
        throw unavailable();
      },
    });
    await expect(plane.complete('p')).rejects.toThrow('not now');
    expect(calls.map((c) => c.id)).toEqual(['local']);
  });

  it('any other remote error also ends locally', async () => {
    const { plane, calls } = setup({
      remoteHandle: async () => {
        throw new TypeError('provider bug');
      },
    });
    await expect(plane.complete('p', { task: 'task.a' })).resolves.toBe(
      'local:complete',
    );
    expect(calls.map((c) => c.id)).toEqual(['r', 'local']);
  });

  it('the local retry re-checks the lane: a lane closed meanwhile defers, never runs locally', async () => {
    let planeRef: ReturnType<typeof createInference> | null = null;
    const { plane, calls } = setup({
      remoteHandle: async () => {
        planeRef!.setLanePolicy(() => false);
        throw unavailable();
      },
    });
    planeRef = plane;
    await expect(
      plane.seeWithMeta(new Uint8Array([1]), 'p', {
        task: 'task.a',
        lane: 'background',
      }),
    ).rejects.toBeInstanceOf(LaneClosedError);
    expect(calls.map((c) => c.id)).toEqual(['r']);
  });

  it("a routed describe's model id is never checked against the local provider", async () => {
    let remoteReady = true;
    const calls: Array<Record<string, unknown>> = [];
    const plane = createInference(fakeLogs(), { generationSeed: 1 });
    plane.register({
      id: 'local',
      supports: ['complete'],
      status: () => 'ready',
      describe: () => ({ modelId: 'L' }),
      handle: async (req) => {
        calls.push(req.payload as Record<string, unknown>);
        return 'ok';
      },
    });
    plane.register({
      id: 'r',
      remote: true,
      supports: ['complete'],
      status: () => (remoteReady ? 'ready' : 'standby'),
      describe: () => ({ modelId: 'R' }),
      handle: async () => 'remote',
    });
    plane.setRoute('task.a', 'r');
    const d = await plane.describe('complete', 'task.a');
    remoteReady = false;
    await plane.complete('p', { task: 'task.a', generation: d!.generation });
    expect(calls[0].expectModelId).toBe('L');
  });

  it("a caller's generation is checked against the answering provider", async () => {
    let bumpNow: (() => void) | null = null;
    const plane = createInference(fakeLogs(), { generationSeed: 1 });
    plane.register(provider('local', ['complete'], 'local'));
    plane.register({
      id: 'r',
      remote: true,
      supports: ['complete'],
      status: () => 'ready',
      onChange: (cb) => {
        bumpNow = cb;
        return () => {};
      },
      handle: async () => {
        bumpNow!();
        throw unavailable();
      },
    });
    plane.setRoute('task.a', 'r');
    const d = await plane.describe('complete', 'task.a');
    await expect(
      plane.complete('p', { task: 'task.a', generation: d!.generation }),
    ).rejects.toMatchObject({ name: 'ModelChangedError' });
  });

  it("fallback checks the local provider's own model id", async () => {
    const { plane, calls } = setup();
    const plain = await plane.describe('complete');
    const routed = await plane.describe('complete', 'task.a');
    expect(routed?.providerId).toBe('r');
    await plane.complete('p', {
      task: 'task.a',
      generation: plain!.generation,
    });
    expect(calls[1]).toMatchObject({
      id: 'local',
      payload: { expectModelId: 'L' },
    });
  });
});

describe('mayBecomeReady (windows-ocr spec §3)', () => {
  it('true while a see provider downloads or says it may; false otherwise', () => {
    const plane = createInference(noopLogs);
    plane.register({
      id: 'dl',
      supports: ['see'],
      status: () => ({ downloading: { pct: 10 } }),
      handle: jest.fn(),
    } as never);
    expect(plane.mayBecomeReady('see')).toBe(true);
    const p2 = createInference(noopLogs);
    p2.register({
      id: 'sb',
      supports: ['see'],
      status: () => 'standby',
      mayBecomeReady: () => false,
      handle: jest.fn(),
    } as never);
    expect(p2.mayBecomeReady('see')).toBe(false);
    p2.register({
      id: 'sb2',
      supports: ['see'],
      status: () => 'standby',
      mayBecomeReady: () => true,
      handle: jest.fn(),
    } as never);
    expect(p2.mayBecomeReady('see')).toBe(true);
    expect(p2.mayBecomeReady('read')).toBe(false);
  });
  it('a remote provider never counts', () => {
    const plane = createInference(noopLogs);
    plane.register({
      id: 'r',
      remote: true,
      supports: ['see'],
      status: () => ({ downloading: { pct: 1 } }),
      mayBecomeReady: () => true,
      handle: jest.fn(),
    } as never);
    expect(plane.mayBecomeReady('see')).toBe(false);
  });
});
