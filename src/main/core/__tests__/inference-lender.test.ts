import type {
  InferenceKind,
  InferenceLender,
  InferenceProvider,
} from '@shared/contracts';

import { createInference, LaneClosedError } from '../inference';

const logs = { log: () => {} };

function local(
  id: string,
  supports: InferenceKind[],
  over: Partial<InferenceProvider> = {},
): InferenceProvider & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    id,
    supports,
    status: () => 'ready',
    describe: () => ({ modelId: `${id}-model` }),
    handle: async (req) => {
      calls.push(req);
      if (req.kind === 'embed') return [new Float32Array([1, 2])];
      return `${id}:${req.kind}`;
    },
    calls,
    ...over,
  };
}

function fakeLender(over: Partial<InferenceLender> = {}) {
  const listeners = new Set<() => void>();
  const calls: { kind: InferenceKind; payload: any; signal?: AbortSignal }[] =
    [];
  const state = {
    takes: new Set<InferenceKind>(['complete', 'see', 'read', 'embed', 'hear']),
    ready: true,
    identity: { providerId: 'local-llm', modelId: 'helper-model' } as {
      providerId: string;
      modelId: string;
    } | null,
  };
  const lender: InferenceLender = {
    takes: (k) => state.takes.has(k),
    ready: () => state.ready,
    identity: () => state.identity,
    handle: async (call) => {
      calls.push(call);
      const value =
        call.kind === 'embed'
          ? [new Float32Array([9, 9, 9])]
          : `helper:${call.kind}`;
      return { value, providerId: 'local-llm', modelId: 'answered-model' };
    },
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    ...over,
  };
  return { lender, calls, state, fire: () => listeners.forEach((f) => f()) };
}

function plane() {
  const p = createInference(logs, { generationSeed: 1 });
  p.setLanePolicy(() => true);
  const llm = local('local-llm', ['complete', 'see']);
  const ocr = local('ocr', ['read']);
  const emb = local('local-embed', ['embed']);
  const asr = local('local-asr', ['hear']);
  p.register(llm);
  p.register(ocr);
  p.register(emb);
  p.register(asr);
  return { p, llm, ocr, emb, asr };
}

describe('a lender answers background calls', () => {
  it('a background completion goes to the lender, with the identity that answered', async () => {
    const { p, llm } = plane();
    const l = fakeLender();
    p.setLender(l.lender);
    const m = await p.completeWithMeta('hi', {
      lane: 'background',
      generation: p.generation(),
    });
    expect(m.text).toBe('helper:complete');
    expect(m.providerId).toBe('local-llm');
    expect(m.modelId).toBe('answered-model');
    expect(llm.calls).toHaveLength(0);
    expect(l.calls[0].payload.prompt).toBe('hi');
    expect('generation' in l.calls[0].payload).toBe(false);
  });

  it('passes the caller signal to the lender', async () => {
    const { p } = plane();
    const l = fakeLender();
    p.setLender(l.lender);
    const ctl = new AbortController();
    await p.read(new Uint8Array([1]), {
      lane: 'background',
      signal: ctl.signal,
    });
    expect(l.calls[0].signal).toBe(ctl.signal);
  });

  it('an interactive call stays on this device', async () => {
    const { p, llm } = plane();
    const l = fakeLender();
    p.setLender(l.lender);
    await expect(p.complete('hi')).resolves.toBe('local-llm:complete');
    expect(l.calls).toHaveLength(0);
    expect(llm.calls).toHaveLength(1);
  });

  it('a task routed to a ready provider still goes there', async () => {
    const { p } = plane();
    const cloud = local('cloud', ['complete'], { remote: true });
    p.register(cloud);
    p.setRoute('research', 'cloud');
    const l = fakeLender();
    p.setLender(l.lender);
    await expect(
      p.complete('hi', { lane: 'background', task: 'research' }),
    ).resolves.toBe('cloud:complete');
    expect(l.calls).toHaveLength(0);
  });

  it('with no helper ready the call closes the lane and never runs here', async () => {
    const { p, ocr } = plane();
    const l = fakeLender();
    l.state.ready = false;
    p.setLender(l.lender);
    await expect(
      p.read(new Uint8Array([1]), { lane: 'background' }),
    ).rejects.toBeInstanceOf(LaneClosedError);
    expect(ocr.calls).toHaveLength(0);
    expect(l.calls).toHaveLength(0);
  });

  it('a kind the lender does not take runs here', async () => {
    const { p, ocr } = plane();
    const l = fakeLender();
    l.state.takes = new Set(['complete']);
    p.setLender(l.lender);
    await expect(
      p.read(new Uint8Array([1]), { lane: 'background' }),
    ).resolves.toBe('ocr:read');
    expect(ocr.calls).toHaveLength(1);
  });

  it('a lent kind counts as having a provider, even with none here', async () => {
    const p = createInference(logs, { generationSeed: 1 });
    expect(p.hasProvider('read')).toBe(false);
    const l = fakeLender();
    l.state.ready = false;
    p.setLender(l.lender);
    expect(p.hasProvider('read')).toBe(true);
    expect(p.mayBecomeReady('read')).toBe(true);
  });

  it('see, embed and hear are lent too', async () => {
    const { p, llm, emb, asr } = plane();
    const l = fakeLender();
    p.setLender(l.lender);
    const s = await p.seeWithMeta(new Uint8Array([1]), 'what', {
      lane: 'background',
    });
    expect(s).toEqual({
      text: 'helper:see',
      providerId: 'local-llm',
      modelId: 'answered-model',
    });
    const e = await p.embed(['a']);
    expect(e.modelId).toBe('answered-model');
    expect(Array.from(e.vectors[0])).toEqual([9, 9, 9]);
    await expect(
      p.hear(new Uint8Array([1]), { lane: 'background' }),
    ).resolves.toBe('helper:hear');
    expect(llm.calls.length + emb.calls.length + asr.calls.length).toBe(0);
  });

  it('describe is lane-aware', async () => {
    const { p } = plane();
    const l = fakeLender();
    p.setLender(l.lender);
    expect(await p.describe('complete')).toMatchObject({
      providerId: 'local-llm',
      modelId: 'local-llm-model',
    });
    expect(await p.describe('complete', undefined, 'background')).toMatchObject(
      { providerId: 'local-llm', modelId: 'helper-model' },
    );
    l.state.ready = false;
    expect(await p.describe('complete', undefined, 'background')).toBeNull();
    l.state.ready = true;
    l.state.identity = null;
    expect(await p.describe('complete', undefined, 'background')).toBeNull();
  });

  it('setting a lender and its changes move the generation', () => {
    const { p } = plane();
    const g0 = p.generation();
    const l = fakeLender();
    p.setLender(l.lender);
    const g1 = p.generation();
    expect(g1).toBeGreaterThan(g0);
    l.fire();
    expect(p.generation()).toBeGreaterThan(g1);
    p.setLender(null);
    const g3 = p.generation();
    l.fire();
    expect(p.generation()).toBe(g3);
  });
});

describe('answering a lent call', () => {
  it('runs the local provider on the background lane and never asks a lender', async () => {
    const { p, llm } = plane();
    const l = fakeLender();
    p.setLender(l.lender);
    const r = await p.runLent({
      kind: 'complete',
      payload: { prompt: 'hi' },
    });
    expect(r).toEqual({
      value: 'local-llm:complete',
      providerId: 'local-llm',
      modelId: 'local-llm-model',
    });
    expect((llm.calls[0] as any).lane).toBe('background');
    expect(l.calls).toHaveLength(0);
  });

  it('ignores task routes: a lent call never reaches a remote provider', async () => {
    const { p } = plane();
    const cloud = local('cloud', ['complete'], { remote: true });
    p.register(cloud);
    p.setRoute('research', 'cloud');
    const r = await p.runLent({
      kind: 'complete',
      payload: { prompt: 'hi', task: 'research' },
    });
    expect(r.providerId).toBe('local-llm');
    expect(cloud.calls).toHaveLength(0);
  });

  it('a closed lane refuses', async () => {
    const { p } = plane();
    p.setLanePolicy(() => false);
    await expect(
      p.runLent({ kind: 'read', payload: {} }),
    ).rejects.toBeInstanceOf(LaneClosedError);
  });
});

describe('fitness', () => {
  it('reports what this device can run itself', () => {
    const p = createInference(logs, { generationSeed: 1 });
    p.register(local('local-llm', ['complete', 'see']));
    p.register(
      local('local-embed', ['embed'], {
        status: () => ({ downloading: { pct: 3 } }),
      }),
    );
    p.register(local('local-asr', ['hear'], { status: () => 'unsupported' }));
    p.register(local('cloud', ['read'], { remote: true }));
    const by = Object.fromEntries(p.fitness().map((f) => [f.kind, f]));
    expect(by.complete).toEqual({
      kind: 'complete',
      local: 'ready',
      providerId: 'local-llm',
      modelId: 'local-llm-model',
    });
    expect(by.embed.local).toBe('possible');
    expect(by.embed.modelId).toBe('local-embed-model');
    expect(by.hear.local).toBe('none');
    expect(by.read).toEqual({
      kind: 'read',
      local: 'none',
      providerId: null,
      modelId: null,
    });
  });
});
