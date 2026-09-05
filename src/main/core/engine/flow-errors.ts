/**
 * Typed failures for the ACCOUNT-SCOPED flows (reconnect, manage folders).
 *
 * Separate from `@shared/source-errors`: that module is the taxonomy the pull
 * loop keys off (and the SDK copies verbatim into every connector). These
 * three are orchestration failures the platform raises about itself, and no
 * source ever throws them.
 */

/** A second flow tried to claim an account that already has one in flight.
 *  There is no per-account lock anywhere else in this codebase — `flows` in
 *  connect-broker.ts is keyed by flowId only — and this design makes Reconnect
 *  and Manage folders reachable from the same detail screen. */
export class AccountFlowBusyError extends Error {
  constructor(readonly heldBy: string) {
    super(
      'another folder or reconnect flow is already running for this ' +
        'account — finish or cancel it first',
    );
  }
}

/** The account's config changed while a manage-folders picker was open, so
 *  the update the source computed describes a scope that no longer exists.
 *  Refuse rather than overwrite the newer change (spec invariant: a stale
 *  result "never overwrites the newer change"). */
export class FolderScopeStaleError extends Error {
  constructor() {
    super(
      'this account changed while the folder picker was open — reopen ' +
        'Manage folders and choose again',
    );
  }
}

/** A folder-scope write arrived through a door that cannot honour the
 *  scope-change contract (stop → transform cursor → archive the source's
 *  removed roots in one transaction), or carried a scope that violates it. */
export class FolderScopeConfigError extends Error {}
