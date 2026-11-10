import path from 'path';

export type SharedRoot = 'incoming' | 'sorted';

/** Files in transit; never listed, indexed, hashed or offered. */
export const STAGING_DIR = '.kia-sync';

/** Posix separators and NFC: the form a `rel_path` is stored and compared in. */
export const normalizeRel = (rel: string): string => rel.replaceAll('\\', '/').normalize('NFC');

/** The manifest path of `abs` under `rootAbs`; null outside the root, for the
 *  root itself and for anything inside the staging directory. */
export function toRel(rootAbs: string, abs: string): string | null {
  const r = path.relative(rootAbs, abs);
  if (r === '' || r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) return null;
  const rel = normalizeRel(r);
  if (rel === STAGING_DIR || rel.startsWith(`${STAGING_DIR}/`)) return null;
  return rel;
}

/** The absolute path of a manifest path. Throws on anything that could leave
 *  the root: `..`, an absolute path, an empty segment. */
export function toAbs(rootAbs: string, rel: string): string {
  const segs = rel.replaceAll('\\', '/').split('/');
  if (rel.startsWith('/') || path.isAbsolute(rel) || segs.some((s) => s === '' || s === '..' || s === '.')) {
    throw new Error(`shared-folders: bad path ${JSON.stringify(rel)}`);
  }
  return path.join(rootAbs, ...segs.map((s) => s.normalize('NFC')));
}
