import type { ErrorScope } from '@shared/contracts';

/** A reconcile pass's own errors carry this prefix (engine.ts reconcilePass). */
export const RECONCILE_ERROR_PREFIX = 'reconcile: ';

/** The `last_error = …` assignment of an account write. `undefined` keeps the
 *  column, a string sets it, `null` clears it — only an error of `scope` when
 *  one is given. A cycle that runs a reconcile pass shares the column between
 *  the pass and pull(), and each clears only its own (alpha-cent#181).
 *  `expr` is the right-hand side alone (with the same `params`), for callers
 *  that compare the new value against the current one. */
export function lastErrorAssignment(
  error: string | null | undefined,
  scope?: ErrorScope,
): { sql: string; expr: string; params: Array<string | null> } {
  const assign = (expr: string, params: Array<string | null>) => ({
    sql: `last_error = ${expr}`,
    expr,
    params,
  });
  if (error === undefined) return assign('last_error', []);
  if (error !== null || scope === undefined) return assign('?', [error]);
  return assign(
    scope === 'reconcile'
      ? `CASE WHEN last_error LIKE ? THEN NULL ELSE last_error END`
      : `CASE WHEN last_error LIKE ? THEN last_error ELSE NULL END`,
    [`${RECONCILE_ERROR_PREFIX}%`],
  );
}
