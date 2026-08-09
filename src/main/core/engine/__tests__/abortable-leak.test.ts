/**
 * @jest-environment node
 *
 * Regression guard for the main-process OOM of 2026-08-09 (packaged 0.48.2
 * died after ~25h with 3.09 GiB of a 4 GiB JS heap in use).
 *
 * `abortable()` used to race every `it.next()` against ONE long-lived
 * `aborted` promise. `Promise.race` subscribes a fresh reaction to each input
 * on every call, and a promise that never settles never drains its reaction
 * list — so each iteration left behind a reaction pinning that iteration's
 * settled race promise, whose result is the yielded value. Feed batches carry
 * up to FEED_BATCH documents *including their markdown*, and the attach/project
 * consumers iterate forever, so every batch ever read stayed reachable.
 *
 * ⚠️ Do NOT "simplify" this into an abort-listener count assertion. The broken
 * version held exactly ONE listener per generator — it leaked promise
 * reactions, not listeners, so a listener test passes on the bug it is meant
 * to catch. Reachability is the only property that discriminates.
 */
import v8 from 'v8';
import vm from 'vm';

import { abortable } from '../engine';

/** `global.gc` without requiring the runner to pass `--expose-gc`. */
function makeGc(): () => void {
  if (typeof (global as { gc?: () => void }).gc === 'function') {
    return (global as unknown as { gc: () => void }).gc;
  }
  v8.setFlagsFromString('--expose-gc');
  try {
    return vm.runInNewContext('gc') as () => void;
  } finally {
    v8.setFlagsFromString('--no-expose-gc');
  }
}

/** GC is not obliged to collect on the first ask; give it a few turns. */
async function collect(gc: () => void): Promise<void> {
  for (let i = 0; i < 4; i++) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('abortable() retention', () => {
  it('releases values once the consumer has moved past them', async () => {
    const gc = makeGc();
    const ctrl = new AbortController();

    // Never-ending source, mirroring store.feed(): each value is a distinct
    // object, so a WeakRef to one says only whether THAT value is reachable.
    const source = (async function* () {
      for (;;) yield { payload: 'x'.repeat(4096) };
    })();

    const gen = abortable(source, ctrl.signal);

    // Take one value, keep a weak handle, and drop every strong reference the
    // test itself holds. Done in its own scope so no local outlives it.
    const ref = await (async (): Promise<WeakRef<object>> => {
      const first = await gen.next();
      return new WeakRef(first.value as object);
    })();

    // Advance well past it. The generator's own registers hold only the most
    // recent value, so after this the first value is reachable ONLY if
    // something accumulated a reference to it.
    for (let i = 0; i < 40; i++) await gen.next();

    await collect(gc);

    // The generator is deliberately still alive here: ending it would free the
    // `aborted` promise and its whole reaction chain, and the bug would hide.
    expect(ref.deref()).toBeUndefined();

    ctrl.abort();
    await gen.return(undefined);
  });

  it('still stops promptly when the signal aborts mid-iteration', async () => {
    const ctrl = new AbortController();
    // Parks forever, like the live feed waiting on a commit that never comes:
    // only the abort race can end this iteration. (The source's own `finally`
    // cannot run while it is suspended on an unsettleable await — that is JS
    // semantics, not something abortable() can fix, so this asserts the thing
    // that matters: the CONSUMER is released.)
    const source = (async function* () {
      await new Promise(() => {});
      yield 1;
    })();

    const seen: number[] = [];
    let finished = false;
    const done = (async () => {
      for await (const v of abortable(source, ctrl.signal)) seen.push(v);
      finished = true;
    })();

    await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false); // parked until the abort, not before
    ctrl.abort();
    await done;

    expect(finished).toBe(true);
    expect(seen).toEqual([]);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let pulled = 0;
    const source = (async function* () {
      for (;;) {
        pulled += 1;
        yield pulled;
      }
    })();

    const seen: number[] = [];
    for await (const v of abortable(source, ctrl.signal)) seen.push(v);

    expect(seen).toEqual([]);
  });
});
