import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DeclaredFileRoot } from '@shared/contracts';
import type { FileRootRegistry } from './file-roots';

type Log = (level: 'info' | 'warn', msg: string) => void;

const inside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent + path.sep);

async function realOrResolved(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** One declaration → the realpath to grant, or null (left ungranted, logged).
 *  The manifest parser already refused lexical escapes and ~/Library(/x);
 *  these checks repeat the rules on the REALPATH, which a symlink can move. */
async function resolveDeclared(
  d: DeclaredFileRoot,
  home: string,
  userData: string | undefined,
  log: Log,
): Promise<string | null> {
  const abs = path.join(home, d.path.slice(2));
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    log('info', `file root ${d.id} (${d.path}) not found — not granted`);
    return null;
  }
  if (!st.isDirectory()) {
    log(
      'info',
      `file root ${d.id} (${d.path}) is not a directory — not granted`,
    );
    return null;
  }
  const real = await fsp.realpath(abs);
  const rel = path.relative(home, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    log(
      'warn',
      `file root ${d.id} (${d.path}) resolves outside the home folder — refused`,
    );
    return null;
  }
  const segs = rel.toLowerCase().split(path.sep);
  if (segs[0] === 'library' && segs.length <= 2) {
    log(
      'warn',
      `file root ${d.id} (${d.path}) is too broad (~/Library or one level below) — refused`,
    );
    return null;
  }
  if (userData && (inside(real, userData) || inside(userData, real))) {
    log(
      'warn',
      `file root ${d.id} (${d.path}) overlaps the app's own data — refused`,
    );
    return null;
  }
  return real;
}

export async function revokeAllRoots(
  registry: FileRootRegistry,
  extensionId: string,
): Promise<void> {
  for (const r of await registry.roots(extensionId))
    await registry.revoke(extensionId, r.id);
}

/** Platform-owned: make an EXTERNAL extension's grants equal its consented
 *  declarations (spec §3.3). Runs with no live host for the extension, so
 *  revoking everything first is side-effect free — and guarantees no stale,
 *  undeclared or writable grant survives. Pass `[]` to revoke all (consent
 *  lapsed, uninstall). Not persisted: re-derived on every activation. */
export async function reconcileDeclaredRoots(o: {
  registry: FileRootRegistry;
  extensionId: string;
  declared: readonly DeclaredFileRoot[];
  home: string;
  userDataDir?: string;
  log: Log;
}): Promise<void> {
  await revokeAllRoots(o.registry, o.extensionId);
  if (o.declared.length === 0) return;
  const home = await fsp.realpath(o.home);
  const userData = o.userDataDir
    ? await realOrResolved(o.userDataDir)
    : undefined;
  for (const d of o.declared) {
    const real = await resolveDeclared(d, home, userData, o.log);
    if (!real) continue;
    try {
      await o.registry.grant(o.extensionId, real, {
        id: d.id,
        name: d.path,
        writable: false,
      });
    } catch (error) {
      o.log(
        'warn',
        `file root ${d.id} (${d.path}) could not be granted: ${String(error)}`,
      );
    }
  }
}
