import type { InferenceProvider } from '@shared/contracts';

import {
  createInference,
  LaneClosedError,
  RemoteUnavailableError,
} from '../inference';

const logs = { log: () => {} };

function deferred() {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fake(
  id: string,
  supports: InferenceProvider['supports'],
  handle: InferenceProvider['handle'],
  remote = false,
): InferenceProvider {
  return { id, supports, remote, status: () => 'ready', handle };
}

describe('plane activeCalls', () => {
  it('records a local complete while it runs, not a remote one', async () => {
    const plane = createInference(logs);
    const d = deferred();
    plane.register(fake('local', ['complete', 'see', 'read'], () => d.promise));
    const p = plane.complete('hi', {
      lane: 'interactive',
      task: 'meeting.summary',
    });
    expect(plane.activeCalls.list()).toEqual([
      { op: 'complete', task: 'meeting.summary' },
    ]);
    d.resolve('ok');
    await p;
    expect(plane.activeCalls.list()).toEqual([]);

    const plane2 = createInference(logs);
    const d2 = deferred();
    plane2.register(fake('remote', ['complete'], () => d2.promise, true));
    plane2.setRoute('x', 'remote');
    const p2 = plane2.complete('hi', { task: 'x' });
    expect(plane2.activeCalls.list()).toEqual([]);
    d2.resolve('ok');
    await p2;
    expect(plane2.activeCalls.list()).toEqual([]);
  });

  it('remote→local fallback is recorded once the local provider runs', async () => {
    const plane = createInference(logs);
    const d = deferred();
    plane.register(
      fake(
        'remote',
        ['complete'],
        async () => {
          throw new RemoteUnavailableError('down');
        },
        true,
      ),
    );
    plane.register(fake('local', ['complete'], () => d.promise));
    plane.setRoute('x', 'remote');
    const p = plane.complete('hi', { task: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    // The fallback re-picks with no task: the entry carries no task either.
    expect(plane.activeCalls.list()).toEqual([{ op: 'complete', task: null }]);
    d.resolve('ok');
    await p;
    expect(plane.activeCalls.list()).toEqual([]);
  });

  it('clears on throw and never enters on LaneClosedError', async () => {
    const plane = createInference(logs);
    plane.register(
      fake('local', ['complete'], async () => {
        throw new Error('boom');
      }),
    );
    await expect(plane.complete('hi')).rejects.toThrow('boom');
    expect(plane.activeCalls.list()).toEqual([]);

    const seen: number[] = [];
    plane.activeCalls.onChange((c) => seen.push(c.length));
    plane.setLanePolicy(() => false);
    await expect(
      plane.complete('hi', { lane: 'background' }),
    ).rejects.toBeInstanceOf(LaneClosedError);
    expect(seen).toEqual([]);
  });

  it('read() and see() record their op', async () => {
    const plane = createInference(logs);
    const d = deferred();
    plane.register(fake('local', ['see', 'read'], () => d.promise));
    const r = plane.read(new Uint8Array([1]));
    expect(plane.activeCalls.list()).toEqual([{ op: 'read', task: null }]);
    d.resolve('t');
    await r;
    const d2 = deferred();
    const plane2 = createInference(logs);
    plane2.register(fake('local', ['see'], () => d2.promise));
    const s = plane2.see(new Uint8Array([1]), 'p', { task: 'vision.x' });
    expect(plane2.activeCalls.list()).toEqual([
      { op: 'see', task: 'vision.x' },
    ]);
    d2.resolve('t');
    await s;
    expect(plane2.activeCalls.list()).toEqual([]);
  });

  it('does not record hear()', async () => {
    const plane = createInference(logs);
    const d = deferred();
    plane.register(fake('asr', ['hear'], () => d.promise));
    const h = plane.hear(new Uint8Array([1]));
    expect(plane.activeCalls.list()).toEqual([]);
    d.resolve('t');
    await h;
  });
});
