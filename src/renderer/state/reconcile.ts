/**
 * Structural sharing for the app-state push (spec 2026-10-09 renderer perf, A).
 *
 * IPC structured-clones every `push:app-state`, so the renderer receives
 * fresh references for everything even when main kept them stable. This
 * walks the new snapshot against the previous one and keeps the previous
 * reference for every deeply equal value — arrays by index, objects by key —
 * so shallow-equal selectors bail out and an unchanged push is a no-op.
 *
 * JSON-shaped data only (what the projection carries). "Plain object" is
 * checked cross-realm: a clone made in another realm has that realm's
 * Object.prototype, so `proto === Object.prototype` would reject it.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

export function reconcile<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    const out = next.map((item: unknown, i: number) => {
      const kept = i < prev.length ? reconcile(prev[i], item) : item;
      if (i >= prev.length || kept !== prev[i]) same = false;
      return kept;
    });
    return (same ? prev : out) as T;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const nextKeys = Object.keys(next);
    let same = nextKeys.length === Object.keys(prev).length;
    const out: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const has = Object.prototype.hasOwnProperty.call(prev, key);
      const kept = has ? reconcile(prev[key], next[key]) : next[key];
      if (!has || kept !== prev[key]) same = false;
      out[key] = kept;
    }
    return (same ? prev : out) as T;
  }
  return next;
}
