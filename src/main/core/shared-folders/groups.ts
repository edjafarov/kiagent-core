/** One group per file, whatever the case of its name on each side. A name that
 *  differs only in case is the same file on macOS and Windows (see `nameKey`):
 *  the file on disk (`f`), this Mac's mirror entry (`m`) and the manifest's row
 *  (`r`) of one file are found together even when each spells it differently.
 *  The manifest's spelling wins for a row; an existing file and mirror entry
 *  keep theirs. */
import type { NameKey } from './paths';

export interface Group<F, M, R> {
  f?: F;
  m?: M;
  r?: R;
}

export function groupByName<
  F extends { rel: string },
  M extends { rel_path: string },
  R extends { rel_path: string; deleted: number },
>(key: NameKey, files: Iterable<F>, mirror: Iterable<M>, rows: Iterable<R>): Map<string, Group<F, M, R>> {
  const groups = new Map<string, Group<F, M, R>>();
  const at = (k: string): Group<F, M, R> => groups.get(k) ?? groups.set(k, {}).get(k)!;
  // Two on one side (a case-sensitive volume, or an old duplicate): kept apart, nothing is lost.
  for (const f of files) {
    const g = at(key(f.rel));
    if (!g.f) g.f = f;
    else at(`\0f:${f.rel}`).f = f;
  }
  for (const m of mirror) {
    const g = at(key(m.rel_path));
    if (!g.m) g.m = m;
    else at(`\0m:${m.rel_path}`).m = m;
  }
  for (const r of rows) {
    const g = at(key(r.rel_path));
    if (!g.r) g.r = r;
    else if (g.r.deleted && !r.deleted) {
      at(`\0r:${g.r.rel_path}`).r = g.r; // a live row beats a tombstone of the same name
      g.r = r;
    } else at(`\0r:${r.rel_path}`).r = r;
  }
  return groups;
}
