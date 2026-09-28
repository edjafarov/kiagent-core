/**
 * `WorkerSession.fetchBytes` could not get the bytes RIGHT NOW: the
 * document's source has not registered yet (workers attach before sources
 * at boot), or the source's own fetch threw (offline, token expired, rate
 * limit). The engine's `workOne` turns this into a `deferred` ledger row
 * without spending retries, so the worker's re-drive tries again later —
 * instead of three quick retries ending in a terminal `failed` that nothing
 * revisits. Workers need not catch it.
 *
 * A source answering `null` ("these bytes do not exist") is NOT this: that
 * stays a terminal answer the worker records.
 */
export class FetchDeferredError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FetchDeferredError';
  }
}
