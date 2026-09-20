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

export type CapabilityErrorCode =
  | 'HOST_CALL_IN_TRANSACTION'
  | 'RPC_ABORTED'
  | 'RPC_DEADLINE_EXCEEDED'
  | 'DB_WORKER_CRASHED'
  | 'DB_WORKER_RESTARTING'
  | 'DB_WORKER_DEAD'
  | 'DB_OPERATION_CANCELLED'
  | 'DB_COORDINATOR_CLOSED'
  | 'DB_OWNER_RELEASED'
  | 'DB_OWNER_POISONED'
  | 'DB_TX_TOKEN_INVALID'
  | 'DB_TX_EXPIRED'
  | 'PLUGIN_DB_IMPORT_INCOMPLETE'
  | 'PLUGIN_DB_IMPORT_DIGEST_MISMATCH'
  | 'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH'
  | 'PLUGIN_DB_IMPORT_SNAPSHOT_INVALID'
  | 'PLUGIN_DB_IMPORT_SOURCE_CHANGED'
  | 'PLUGIN_DB_IMPORT_SOURCE_UNAVAILABLE'
  | 'PLUGIN_DB_IMPORT_FOREIGN_KEY'
  | 'PLUGIN_DB_IMPORT_DESCRIPTOR_CHANGED'
  | 'PLUGIN_DB_IMPORT_STATE_INVALID'
  | 'PLUGIN_DB_TARGET_NONEMPTY'
  | 'PLUGIN_DB_DESCRIPTOR_DRIFT'
  | 'PLUGIN_DB_DESCRIPTOR_FOREIGN_KEY'
  | 'PLUGIN_DB_SCHEMA_OBJECT_KIND'
  | 'PLUGIN_DB_SCHEMA_OBJECT_MISSING'
  | 'PLUGIN_DB_SCHEMA_REFERENCE'
  | 'PLUGIN_DB_LEGACY_FK_ORDER'
  | 'PLUGIN_DB_LEGACY_FK_CYCLE'
  | 'PLUGIN_DB_LEGACY_PATH_DRIFT'
  | 'PLUGIN_DB_LEGACY_PATH_INVALID'
  | 'PLUGIN_DB_LEGACY_SOURCE_UNAVAILABLE'
  | 'PLUGIN_DB_REGISTRY_PATH_INVALID'
  | 'PLUGIN_DB_NOT_REGISTERED'
  | 'PLUGIN_DB_NOT_OPEN'
  | 'PLUGIN_DB_OWNER_INVALID'
  | 'PLUGIN_DB_RESET_TOMBSTONE'
  | 'PLUGIN_SQL_DDL_FORBIDDEN'
  | 'PLUGIN_SQL_SCHEMA_IN_TRANSACTION'
  | 'PLUGIN_SQL_TRANSACTION_CONTROL'
  | 'PLUGIN_SQL_UNAUTHORIZED'
  | 'PLUGIN_SQLITE_UNSUPPORTED'
  | 'PLUGIN_MIGRATION_NOT_REGISTERED'
  | 'PLUGIN_MIGRATION_LEDGER_MISMATCH'
  | 'PLUGIN_REGISTRATION_HOST_ONLY'
  | 'FILE_ROOT_REVOKED'
  | 'FILE_HANDLE_INVALID'
  | 'FILE_OPERATION_CANCELLED'
  | 'NETWORK_ABORTED'
  | 'NETWORK_TIMEOUT';
export type SourceErrorCode = 'auth' | 'permanent';
export type WireErrorCode = SourceErrorCode | CapabilityErrorCode;

/**
 * B1 (host-owned renderer eventing): outcomes `ext:invoke` can resolve that
 * never arise from an ordinary extension-RPC reply — the destination
 * (extensionId/name) doesn't exist, the extension's tier is denied the `ui`
 * write surface, the renderer's request itself is malformed, or the caller
 * failed sender verification. `WireErrorCode` alone can't express these:
 * it's the taxonomy for a REJECTED RPC call between main and a child, and
 * these four arise either before any RPC call is made (malformed/tier/
 * unknown) or from the IPC boundary itself (untrusted sender), never from a
 * child's reply. `ExtErrorCode` is additive — every existing `WireErrorCode`
 * still crosses through `ext:invoke`'s envelope unchanged (e.g. a handler
 * that times out surfaces as `RPC_DEADLINE_EXCEEDED`) — so this widens
 * rather than duplicates the taxonomy. */
export type ExtDispatchErrorCode =
  | 'EXT_UNKNOWN_DESTINATION'
  | 'EXT_TIER_DENIED'
  | 'EXT_MALFORMED_REQUEST'
  | 'EXT_UNTRUSTED_SENDER'
  /** A registered handler rejected with something that isn't a
   *  `WireErrorCode` (e.g. a plain `throw new Error(...)` in extension
   *  code) — the envelope still needs SOME code, and this is the
   *  catch-all so `ext:invoke` never has to guess. */
  | 'EXT_HANDLER_FAILED';
export type ExtErrorCode = WireErrorCode | ExtDispatchErrorCode;

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

export function wireErrorCode(err: unknown): WireErrorCode | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  if (
    code === 'auth' ||
    code === 'permanent' ||
    code === 'HOST_CALL_IN_TRANSACTION' ||
    code === 'RPC_ABORTED' ||
    code === 'RPC_DEADLINE_EXCEEDED' ||
    [
      'DB_WORKER_CRASHED',
      'DB_WORKER_RESTARTING',
      'DB_WORKER_DEAD',
      'DB_OPERATION_CANCELLED',
      'DB_COORDINATOR_CLOSED',
      'DB_OWNER_RELEASED',
      'DB_OWNER_POISONED',
      'DB_TX_TOKEN_INVALID',
      'DB_TX_EXPIRED',
      'PLUGIN_DB_IMPORT_INCOMPLETE',
      'PLUGIN_DB_IMPORT_DIGEST_MISMATCH',
      'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
      'PLUGIN_DB_IMPORT_SNAPSHOT_INVALID',
      'PLUGIN_DB_IMPORT_SOURCE_CHANGED',
      'PLUGIN_DB_IMPORT_SOURCE_UNAVAILABLE',
      'PLUGIN_DB_IMPORT_FOREIGN_KEY',
      'PLUGIN_DB_IMPORT_DESCRIPTOR_CHANGED',
      'PLUGIN_DB_IMPORT_STATE_INVALID',
      'PLUGIN_DB_TARGET_NONEMPTY',
      'PLUGIN_DB_DESCRIPTOR_DRIFT',
      'PLUGIN_DB_DESCRIPTOR_FOREIGN_KEY',
      'PLUGIN_DB_SCHEMA_OBJECT_KIND',
      'PLUGIN_DB_SCHEMA_OBJECT_MISSING',
      'PLUGIN_DB_SCHEMA_REFERENCE',
      'PLUGIN_DB_LEGACY_FK_ORDER',
      'PLUGIN_DB_LEGACY_FK_CYCLE',
      'PLUGIN_DB_LEGACY_PATH_DRIFT',
      'PLUGIN_DB_LEGACY_PATH_INVALID',
      'PLUGIN_DB_LEGACY_SOURCE_UNAVAILABLE',
      'PLUGIN_DB_REGISTRY_PATH_INVALID',
      'PLUGIN_DB_NOT_REGISTERED',
      'PLUGIN_DB_NOT_OPEN',
      'PLUGIN_DB_OWNER_INVALID',
      'PLUGIN_DB_RESET_TOMBSTONE',
      'PLUGIN_SQL_DDL_FORBIDDEN',
      'PLUGIN_SQL_SCHEMA_IN_TRANSACTION',
      'PLUGIN_SQL_TRANSACTION_CONTROL',
      'PLUGIN_SQL_UNAUTHORIZED',
      'PLUGIN_SQLITE_UNSUPPORTED',
      'PLUGIN_MIGRATION_NOT_REGISTERED',
      'PLUGIN_MIGRATION_LEDGER_MISMATCH',
      'PLUGIN_REGISTRATION_HOST_ONLY',
      'FILE_ROOT_REVOKED',
      'FILE_HANDLE_INVALID',
      'FILE_OPERATION_CANCELLED',
      'NETWORK_ABORTED',
      'NETWORK_TIMEOUT',
    ].includes(code as string)
  )
    return code as WireErrorCode;
  return undefined;
}

/** A reconnect signed in as somebody else. Thrown by `Source.reauthenticate`
 *  BEFORE it lets the platform capture anything, so the mismatch costs the
 *  account nothing: `engine.reconnect` only reaches `vault.save` when
 *  `reauthenticate` RESOLVES.
 *
 *  Deliberately carries no `code`: the taxonomy above drives the pull loop's
 *  retry/needsReauth decisions, and this error never reaches it. Giving it a
 *  taxonomy code to survive the wire would make the pull loop treat every
 *  mismatch as auth/permanent, which is why it has none.
 *
 *  It does still cross the extension RPC boundary intact by NAME: the reply
 *  path carries `errorName` (`src/shared/extension-rpc.ts`), so a mismatch
 *  raised inside a PROXIED connector now stages as 'reauth-identity', the
 *  same as an in-process one. Before that field existed it arrived as a plain
 *  Error and staged as 'reauth-provider' — the reason the stage classifier
 *  has a name fallback at all. */
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
