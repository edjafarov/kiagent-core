import fs from 'node:fs';
import path from 'path';

export type SharedRoot = 'incoming' | 'sorted';

/** Files in transit; never listed, indexed, hashed or offered. */
export const STAGING_DIR = '.kia-sync';

/** Posix separators and NFC: the form a `rel_path` is stored and compared in. */
export const normalizeRel = (rel: string): string => rel.replaceAll('\\', '/').normalize('NFC');

/** The key under which names are matched. macOS and Windows volumes are
 *  usually case-insensitive, so `Taxes/a.pdf` and `taxes/a.pdf` are one file
 *  there: the key is the NFC name in lower case. Elsewhere names match exactly.
 *  Never a name to write to disk: spelling is kept as it is. */
export type NameKey = (rel: string) => string;
export const nameKey = (platform: NodeJS.Platform = process.platform): NameKey =>
  platform === 'darwin' || platform === 'win32' ? (rel) => normalizeRel(rel).toLowerCase() : (rel) => rel;

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

/** `toAbs`, and the proof that nothing on the way is a symlink. A manifest
 *  path comes from another device, so before it is read, written, removed or
 *  moved: every segment that exists below the root is looked at with `lstat`
 *  (a symlink or junction anywhere, the last segment included, is refused, also
 *  one that points back inside), and the nearest existing directory above the
 *  target must resolve to a place inside the root's own real path. The root
 *  itself may be a symlink. A segment that does not exist yet is fine. */
export async function safeAbs(rootAbs: string, rel: string): Promise<string> {
  const abs = toAbs(rootAbs, rel);
  const segs = path.relative(rootAbs, abs).split(path.sep);
  let cur = rootAbs;
  let deepest = rootAbs; // the last directory that exists on the way
  for (const seg of segs) {
    cur = path.join(cur, seg);
    let st: fs.Stats;
    try {
      // eslint-disable-next-line no-await-in-loop
      st = await fs.promises.lstat(cur);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') break;
      throw new Error(`shared-folders: cannot look at ${JSON.stringify(rel)} (${code ?? 'error'})`);
    }
    if (st.isSymbolicLink()) throw new Error(`shared-folders: ${JSON.stringify(rel)} goes through a symlink`);
    if (!st.isDirectory()) break;
    deepest = cur;
  }
  const realRoot = await fs.promises.realpath(rootAbs);
  const realDeepest = await fs.promises.realpath(deepest);
  const inside = path.relative(realRoot, realDeepest);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
    throw new Error(`shared-folders: ${JSON.stringify(rel)} leaves the folder`);
  return abs;
}
