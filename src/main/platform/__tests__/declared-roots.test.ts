// src/main/platform/__tests__/declared-roots.test.ts
/** @jest-environment node */
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
  rmdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileRootRegistry } from '../file-roots';
import { reconcileDeclaredRoots, revokeAllRoots } from '../declared-roots';

const EXT = 'kia.agent-sessions';
const CLAUDE = { id: 'claude', path: '~/.claude', purpose: 'p' };

describe('reconcileDeclaredRoots', () => {
  let home: string;
  let registry: ReturnType<typeof createFileRootRegistry>;
  let logs: string[];
  const run = (declared = [CLAUDE], extra: Record<string, unknown> = {}) =>
    reconcileDeclaredRoots({
      registry,
      extensionId: EXT,
      declared,
      home,
      log: (level, msg) => logs.push(`${level}:${msg}`),
      ...extra,
    });

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'kia-home-')));
    registry = createFileRootRegistry();
    logs = [];
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it('grants-declared-after-consent (read-only, named by the ~/ path)', async () => {
    await mkdir(join(home, '.claude'));
    await run();
    expect(await registry.roots(EXT)).toEqual([
      { id: 'claude', name: '~/.claude', writable: false },
    ]);
    expect((await registry.resolve(EXT, 'claude')).path).toBe(
      join(home, '.claude'),
    );
  });

  it('missing-dir-ungranted-not-error', async () => {
    await expect(run()).resolves.toBeUndefined();
    expect(await registry.roots(EXT)).toEqual([]);
    expect(logs.some((l) => l.startsWith('info:'))).toBe(true);
  });

  it('missing-replacement-revokes-old-grant', async () => {
    await mkdir(join(home, '.claude'));
    await run();
    await rm(join(home, '.claude'), { recursive: true });
    await run();
    expect(await registry.roots(EXT)).toEqual([]);
  });

  it('non-directory-ungranted', async () => {
    await writeFile(join(home, '.claude'), 'x');
    await run();
    expect(await registry.roots(EXT)).toEqual([]);
  });

  it('symlinked-root-granted-at-realpath', async () => {
    await mkdir(join(home, 'dotfiles', 'claude'), { recursive: true });
    await symlink(join(home, 'dotfiles', 'claude'), join(home, '.claude'));
    await run();
    expect((await registry.resolve(EXT, 'claude')).path).toBe(
      join(home, 'dotfiles', 'claude'),
    );
  });

  it('refuses-realpath-outside-home', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'kia-out-')));
    await symlink(outside, join(home, '.claude'));
    await run();
    expect(await registry.roots(EXT)).toEqual([]);
    expect(logs.some((l) => l.startsWith('warn:'))).toBe(true);
    await rm(outside, { recursive: true, force: true });
  });

  it('refuses-userData-and-home-and-library', async () => {
    await mkdir(join(home, 'Library', 'Application Support', 'KIAgent'), {
      recursive: true,
    });
    await mkdir(join(home, 'Library', 'Mail', 'V10'), { recursive: true });
    const userDataDir = join(home, 'Library', 'Application Support', 'KIAgent');
    const declared = [
      { id: 'lib', path: '~/Library', purpose: 'p' },
      { id: 'libx', path: '~/Library/Mail', purpose: 'p' },
      { id: 'ud', path: '~/Library/Application Support/KIAgent', purpose: 'p' },
      { id: 'udparent', path: '~/Library/Application Support', purpose: 'p' },
      { id: 'deep', path: '~/Library/Mail/V10', purpose: 'p' },
    ];
    await run(declared, { userDataDir });
    expect((await registry.roots(EXT)).map((r) => r.id)).toEqual(['deep']);
  });

  it('refuses-symlinked-userData-realpath', async () => {
    await mkdir(join(home, 'kia-data'));
    await mkdir(join(home, 'links'));
    await symlink(join(home, 'kia-data'), join(home, 'links', 'userData'));
    await run([{ id: 'd', path: '~/kia-data', purpose: 'p' }], {
      userDataDir: join(home, 'links', 'userData'),
    });
    expect(await registry.roots(EXT)).toEqual([]);
  });

  it('regrants-on-identity-change', async () => {
    await mkdir(join(home, '.claude'));
    await run();
    const before = await registry.resolve(EXT, 'claude');
    await rmdir(join(home, '.claude'));
    await mkdir(join(home, '.claude'));
    await run();
    const after = await registry.resolve(EXT, 'claude');
    expect(after.ino).not.toBe(before.ino);
  });

  it('restored-writable-grant-not-retained', async () => {
    await mkdir(join(home, '.claude'));
    await registry.grant(EXT, join(home, '.claude'), {
      id: 'claude',
      name: '~/.claude',
      writable: true,
    });
    await run();
    expect((await registry.roots(EXT))[0].writable).toBe(false);
  });

  it('revokes-undeclared', async () => {
    await mkdir(join(home, '.claude'));
    await mkdir(join(home, '.old'));
    await run([CLAUDE, { id: 'old', path: '~/.old', purpose: 'p' }]);
    await run([CLAUDE]);
    expect((await registry.roots(EXT)).map((r) => r.id)).toEqual(['claude']);
  });

  it('revokes-all (uninstall / consent lapse)', async () => {
    await mkdir(join(home, '.claude'));
    await run();
    await revokeAllRoots(registry, EXT);
    expect(await registry.roots(EXT)).toEqual([]);
  });
});
