import type { Worker } from '@shared/contracts';

import { workerConsumerName } from '../../core/engine/engine';
import { registerRedrive } from '../index';

/** Minimal CorePlatform stub: registerRedrive touches scheduler.register,
 *  store.ledgerDeferred, engine.rerunDeferred, and (via backgroundLaneOpen)
 *  prefs.get().processing + scheduler.env. */
function makePlatform(deferred: string[]) {
  const registered: Array<{ id: string; cb: () => Promise<void> }> = [];
  const ledgerQueries: string[] = [];
  const reruns: string[] = [];
  const platform = {
    prefs: { get: () => ({ processing: { enabled: true, window: 'always' } }) },
    scheduler: {
      env: { onBattery: false, userActive: false },
      register: (id: string, _s: unknown, cb: () => Promise<void>) => {
        registered.push({ id, cb });
      },
    },
    store: {
      ledgerDeferred: async (consumer: string) => {
        ledgerQueries.push(consumer);
        return deferred.includes(consumer) ? [{ id: 'x' }] : [];
      },
    },
    engine: {
      rerunDeferred: async (w: Worker) => {
        reruns.push(w.name);
      },
    },
  };
  return { platform: platform as never, registered, ledgerQueries, reruns };
}

const worker = (name: string, version: number): Worker =>
  ({
    name,
    version,
    schedule: { every: '30m' },
    matches: () => false,
    work: async () => 'skip',
  }) as Worker;

describe('workerConsumerName', () => {
  it('derives worker:<name>:v<version>', () => {
    expect(workerConsumerName(worker('audio', 2))).toBe('worker:audio:v2');
  });
});

describe('registerRedrive', () => {
  it('queries the ledger under the DERIVED consumer — a version bump moves the gate (v1-constant desync regression)', async () => {
    const { platform, registered, ledgerQueries } = makePlatform([]);
    registerRedrive(platform, worker('audio', 2), []);
    await registered[0].cb();
    expect(ledgerQueries).toEqual(['worker:audio:v2']);
  });

  it('runs ONLY its own installers, and only when deferred work exists', async () => {
    const calls: string[] = [];
    const llm = { ensureInstalled: () => calls.push('llm') };
    const asr = { ensureInstalled: () => calls.push('asr') };

    // vision has deferred work → llm install requested, asr NOT (deferred
    // OCR work must never download whisper — spec §5)
    const a = makePlatform(['worker:vision:v1']);
    registerRedrive(a.platform, worker('vision', 1), [llm]);
    await a.registered[0].cb();
    expect(calls).toEqual(['llm']);
    expect(a.reruns).toEqual(['vision']);

    // audio has deferred work → asr install requested, llm NOT (deferred
    // audio work must not keep Gemma installs warm — spec §5)
    calls.length = 0;
    const b = makePlatform(['worker:audio:v2']);
    registerRedrive(b.platform, worker('audio', 2), [asr]);
    await b.registered[0].cb();
    expect(calls).toEqual(['asr']);
  });

  it('does nothing when the ledger is empty', async () => {
    const calls: string[] = [];
    const { platform, registered, reruns } = makePlatform([]);
    registerRedrive(platform, worker('audio', 2), [
      { ensureInstalled: () => calls.push('asr') },
    ]);
    await registered[0].cb();
    expect(calls).toEqual([]);
    expect(reruns).toEqual([]);
  });
});
