/**
 * Typed source-failure taxonomy shared by the engine, the bundled sources,
 * and the extension host RPC layer. contracts.ts stays type-only, so these
 * runtime classes live in their own module (same rationale as the version
 * constant in extension-rpc.ts).
 *
 * The engine keys off the `code` PROPERTY, never `instanceof` — an error
 * rehydrated from the extension-child wire (or from a differently-bundled
 * copy of this module) is a plain Error carrying `code`, and that must
 * classify identically to a locally-thrown SourceAuthError.
 */

export type SourceErrorCode = 'auth' | 'permanent';

/** Authentication is gone (revoked/expired token, changed password): the
 *  engine commits `status: 'needsReauth'` and STOPS — no retries, no
 *  automatic supervisor restarts. The user's explicit Retry (or a fresh
 *  connect) is the only way back in. */
export class SourceAuthError extends Error {
  readonly code: SourceErrorCode = 'auth';
}

/** Retrying can never help (unsupported legacy config, permanent upstream
 *  rejection): the engine commits `status: 'error'` immediately instead of
 *  burning the transient-failure retry budget. */
export class SourcePermanentError extends Error {
  readonly code: SourceErrorCode = 'permanent';
}

/** The classification the engine (and the wire layer) uses. Recognizes the
 *  two taxonomy codes on ANY error shape; every other `code` value (Node's
 *  ENOTFOUND, the DB worker's DB_WORKER_* …) is not a source-taxonomy code. */
export function sourceErrorCode(err: unknown): SourceErrorCode | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'auth' || code === 'permanent' ? code : undefined;
}
