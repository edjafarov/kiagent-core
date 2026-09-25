import type { ErrorScope } from '@shared/contracts';

/** A reconcile pass's own errors carry this prefix (engine.ts reconcilePass). */
export const RECONCILE_ERROR_PREFIX = 'reconcile: ';

/** The `last_error = …` assignment of an account write. `undefined` keeps the
 *  column, a string sets it, `null` clears it — only an error of `scope` when
 *  one is given. A cycle that runs a reconcile pass shares the column between
 *  the pass and pull(), and each clears only its own (alpha-cent#181). */
export function lastErrorAssignment(
  error: string | null | undefined,
  scope?: ErrorScope,
): { sql: string; params: Array<string | null> } {
  if (error === undefined)
    return { sql: 'last_error = last_error', params: [] };
  if (error !== null || scope === undefined) {
    return { sql: 'last_error = ?', params: [error] };
  }
  return {
    sql:
      scope === 'reconcile'
        ? `last_error = CASE WHEN last_error LIKE ? THEN NULL ELSE last_error END`
        : `last_error = CASE WHEN last_error LIKE ? THEN last_error ELSE NULL END`,
    params: [`${RECONCILE_ERROR_PREFIX}%`],
  };
}
