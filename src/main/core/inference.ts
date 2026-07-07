import type { Inference, InferenceProvider, Lane } from '@shared/contracts';

import type { LogSink } from './engine/engine';

export interface InferencePlane extends Inference {
  register(provider: InferenceProvider): () => void;
  providers(): InferenceProvider[];
  /** Scheduler-controlled: false closes the background lane (battery, user
   *  active, outside the processing window) — background requests then fail
   *  fast with LaneClosedError. Interactive always flows. */
  setBackgroundOpen(open: boolean): void;
}

/** Thrown by the routing layer when NO ready provider supports a kind — as
 *  opposed to a provider/helper that IS present but crashes mid-request.
 *  The two-pass vision worker relies on the distinction: "no provider" means
 *  the capability simply isn't available yet (fall through / try the next
 *  pass), whereas a crash is a transient fault to DEFER and retry so a doc
 *  isn't left permanently un-extracted. */
export class NoProviderError extends Error {
  readonly kind: 'complete' | 'see' | 'read';

  constructor(kind: 'complete' | 'see' | 'read') {
    super(
      `no inference provider available for '${kind}' — install or enable one in Settings`,
    );
    this.name = 'NoProviderError';
    this.kind = kind;
  }
}

/** Thrown to background-lane callers while the lane is closed. Fail-fast on
 *  purpose: parking the request as a pending promise would pin the caller's
 *  entire async chain — including batches of loaded documents — in memory
 *  until the lane reopens (observed as ~1.5 GB held for a full daytime
 *  window). Workers catch this and DEFER the change to the ledger instead. */
export class LaneClosedError extends Error {
  constructor() {
    super(
      'background inference lane is closed — outside the processing window',
    );
    this.name = 'LaneClosedError';
  }
}

/**
 * ONE front door to models. Requests route to the first ready provider that
 * supports the kind; background requests flow only while the scheduler holds
 * the lane open, and throw LaneClosedError otherwise.
 */
export function createInference(logs: LogSink): InferencePlane {
  const providers: InferenceProvider[] = [];
  let backgroundOpen = true;

  const gate = (lane: Lane): void => {
    if (lane !== 'interactive' && !backgroundOpen) throw new LaneClosedError();
  };

  const pick = (kind: 'complete' | 'see' | 'read'): InferenceProvider => {
    const p = providers.find(
      (x) => x.supports.includes(kind) && x.status() === 'ready',
    );
    if (!p) {
      throw new NoProviderError(kind);
    }
    return p;
  };

  return {
    async complete(prompt, opts) {
      const lane = opts?.lane ?? 'interactive';
      gate(lane);
      const p = pick('complete');
      const out = await p.handle({
        kind: 'complete',
        payload: { prompt, maxTokens: opts?.maxTokens },
        lane,
      });
      return String(out);
    },
    async see(image, prompt, opts) {
      const lane = opts?.lane ?? 'interactive';
      gate(lane);
      const p = pick('see');
      const out = await p.handle({
        kind: 'see',
        payload: { image, prompt, mime: opts?.mime },
        lane,
      });
      return String(out);
    },
    async read(image, opts) {
      const lane = opts?.lane ?? 'interactive';
      gate(lane);
      const p = pick('read');
      const out = await p.handle({
        kind: 'read',
        payload: { image, mime: opts?.mime },
        lane,
      });
      return String(out);
    },
    register(provider) {
      providers.push(provider);
      logs.log('inference', 'info', `provider registered: ${provider.id}`);
      return () => {
        const i = providers.indexOf(provider);
        if (i >= 0) providers.splice(i, 1);
      };
    },
    providers: () => [...providers],
    setBackgroundOpen(open) {
      backgroundOpen = open;
    },
  };
}
