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

/** A reconnect signed in as somebody else. Thrown by `Source.reauthenticate`
 *  BEFORE it lets the platform capture anything, so the mismatch costs the
 *  account nothing: `engine.reconnect` only reaches `vault.save` when
 *  `reauthenticate` RESOLVES.
 *
 *  Deliberately carries no `code`: the taxonomy above drives the pull loop's
 *  retry/needsReauth decisions, and this error never reaches it. That is also
 *  why the wire cannot carry it — `extension-rpc.ts` ships only `{message,
 *  code}` for a source error, so a mismatch raised inside a PROXIED connector
 *  arrives in main as a plain Error and stages as 'reauth-provider' rather
 *  than 'reauth-identity'. Accepted: giving it a taxonomy code to survive the
 *  wire would make the pull loop treat every mismatch as auth/permanent. */
export class IdentityMismatchError extends Error {
  // Subclassing Error does not set `name`, and the stage classifier's
  // instanceof check cannot survive a structured clone — set it explicitly so
  // there is a stable string fallback.
  readonly name = 'IdentityMismatchError';
}

/** The ONE comparison rule for "is this the same provider identity". Trimmed
 *  and case-insensitive, because providers round-trip mailbox-local case and
 *  the picker/OAuth callback both pad. Never a substring or domain match — a
 *  loose rule here re-points an existing corpus at a different mailbox.
 *
 *  Takes exactly the two identities, never a credential, so a mismatch can be
 *  logged and shown verbatim. */
export function assertAccountIdentity(expected: string, actual: string): void {
  const norm = (s: string): string => s.trim().toLowerCase();
  if (norm(expected) === norm(actual)) return;
  throw new IdentityMismatchError(
    `this reconnect signed in as ${actual.trim()}, but this account is ` +
      `${expected.trim()} — sign in with the original account, or add the ` +
      `new one as a separate source`,
  );
}
