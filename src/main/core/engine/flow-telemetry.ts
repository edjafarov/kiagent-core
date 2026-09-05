import type { LogLevel } from '@shared/contracts';
import { IdentityMismatchError } from '@shared/source-errors';

import { FolderScopeConfigError, FolderScopeStaleError } from './flow-errors';

/**
 * Spec §Observability, amendment A-7. This module owns BOTH halves: the
 * failure-stage enum every folder surface reports against, and the one
 * structured record a successful scope change emits.
 *
 * PRIVACY RULE, and the reason the record is a fixed shape rather than a
 * free-form fields bag: a folder-scope log may carry account ids, source ids,
 * a stage name and COUNTS — never a local path, never a provider folder name,
 * and never an error MESSAGE (a connector's "folder Payroll 2026 not found"
 * leaks a name the user chose). The human-readable message still reaches the
 * user, over the flow's `error` ConnectEvent; it just never reaches the log.
 */

/** Structural sink — `LogSink` itself is declared in engine.ts, and importing
 *  it back from there would be a module cycle for no gain. */
export interface FlowLogSink {
  log(
    scope: string,
    level: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ): void;
}

export type FolderFlowStage =
  /** Listing or browsing the provider's tree failed (picker roots/children). */
  | 'folder-list'
  /** The chosen set was refused: empty, unreachable, or not a covering set. */
  | 'folder-validate'
  /** The account changed under an open picker; the result was discarded. */
  | 'folder-stale'
  /** The store transaction (config + cursor + archival) failed. */
  | 'folder-commit'
  /** Re-authentication returned a DIFFERENT provider identity. */
  | 'reauth-identity'
  /** Re-authentication failed at the provider (denied, abandoned, network). */
  | 'reauth-provider';

export const FOLDER_FLOW_STAGES: readonly FolderFlowStage[] = [
  'folder-list',
  'folder-validate',
  'folder-stale',
  'folder-commit',
  'reauth-identity',
  'reauth-provider',
];

const LOG_SCOPE = 'folder-scope';

/** True for a real `IdentityMismatchError`, and for a copy that lost its
 *  prototype but kept its `name` (structured clone, worker postMessage).
 *  The extension-rpc wire keeps NEITHER — it ships `{ message, code }` only
 *  — so a mismatch raised inside a PROXIED connector still stages as
 *  'reauth-provider'. Known limitation; see the reviewer notes. */
function isIdentityMismatch(err: unknown): boolean {
  if (err instanceof IdentityMismatchError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'IdentityMismatchError'
  );
}

/** Refine the stage the flow believes it is in with what the error actually
 *  says. The flow's own transitions are authoritative for the folder path;
 *  the three overrides exist because an error type is more precise than the
 *  position it was thrown from. */
export function folderFlowStage(
  current: FolderFlowStage,
  err: unknown,
): FolderFlowStage {
  if (isIdentityMismatch(err)) return 'reauth-identity';
  if (err instanceof FolderScopeStaleError) return 'folder-stale';
  if (err instanceof FolderScopeConfigError) return 'folder-validate';
  return current;
}

/** THE record. Exactly one per successful scope change (A-7). */
export function logScopeChanged(
  logs: FlowLogSink,
  rec: {
    accountId: string;
    sourceId: string;
    added: number;
    retained: number;
    removed: number;
  },
): void {
  logs.log(LOG_SCOPE, 'info', 'folder scope changed', {
    accountId: rec.accountId,
    sourceId: rec.sourceId,
    added: rec.added,
    retained: rec.retained,
    removed: rec.removed,
  });
}

/** One record per failed account-scoped flow, staged. `error` is the error's
 *  CONSTRUCTOR NAME, never its message — see the privacy rule above. */
export function logFolderFlowFailure(
  logs: FlowLogSink,
  stage: FolderFlowStage,
  rec: { accountId: string; sourceId: string; error: unknown },
): void {
  const err = rec.error;
  logs.log(LOG_SCOPE, 'warn', 'folder flow failed', {
    accountId: rec.accountId,
    sourceId: rec.sourceId,
    stage,
    error: err instanceof Error ? err.name || err.constructor.name : typeof err,
  });
}
