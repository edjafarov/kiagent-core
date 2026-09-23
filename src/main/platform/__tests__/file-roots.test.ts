/** @jest-environment node */
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFileRootRegistry,
  createFileRootsPersistence,
  restoreFileRootsFromFile,
} from '../file-roots';

describe('file root registry', () => {
  let rootPath: string;
  let registry: ReturnType<typeof createFileRootRegistry>;

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), 'kiagent-file-root-'));
    registry = createFileRootRegistry();
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it('grants opaque roots and resolves them only for the owning extension', async () => {
    const granted = await registry.grant('documents', rootPath, {
      name: 'Documents',
      writable: true,
    });

    expect(granted.id).not.toContain(rootPath);
    await expect(
      registry.resolve('documents', granted.id),
    ).resolves.toMatchObject({
      ...granted,
      path: await realpath(rootPath),
    });
    await expect(
      registry.resolve('other-extension', granted.id),
    ).rejects.toThrow();
  });

  it('revokes a root and makes subsequent resolution fail', async () => {
    const granted = await registry.grant('documents', rootPath, {
      name: 'Documents',
      writable: false,
    });
    await registry.revoke('documents', granted.id);
    await expect(registry.resolve('documents', granted.id)).rejects.toThrow(
      /revoked/i,
    );
  });

  it('does not expose a root path through the public root listing', async () => {
    const granted = await registry.grant('documents', rootPath, {
      name: 'Documents',
      writable: true,
    });
    await expect(registry.roots('documents')).resolves.toEqual([
      { ...granted },
    ]);
    expect(JSON.stringify(await registry.roots('documents'))).not.toContain(
      rootPath,
    );
  });

  it('rejects a missing grant target', async () => {
    await expect(
      registry.grant('documents', join(rootPath, 'missing'), {
        name: 'Missing',
        writable: true,
      }),
    ).rejects.toThrow();
  });

  it('keeps the grant bound to the canonical directory', async () => {
    await mkdir(join(rootPath, 'nested'));
    await writeFile(join(rootPath, 'nested', 'keep.txt'), 'ok');
    const granted = await registry.grant(
      'documents',
      join(rootPath, 'nested'),
      {
        name: 'Nested',
        writable: true,
      },
    );
    await expect(
      registry.resolve('documents', granted.id),
    ).resolves.toHaveProperty('path', await realpath(join(rootPath, 'nested')));
  });

  it('allows trusted restore to retain a persisted root id', async () => {
    const restored = await registry.grant('documents', rootPath, {
      id: 'persisted-root-id',
      name: 'Restored',
      writable: true,
    });
    expect(restored.id).toBe('persisted-root-id');
    await expect(
      registry.resolve('documents', 'persisted-root-id'),
    ).resolves.toMatchObject(restored);
  });

  it('rejects trusted restore when the persisted filesystem identity differs', async () => {
    await expect(
      registry.grant('documents', rootPath, {
        id: 'persisted-root-id',
        identity: { dev: 'wrong-device', ino: 'wrong-inode' },
        name: 'Restored',
        writable: true,
      }),
    ).rejects.toThrow(/identity/i);
  });

  it('restores only the original bigint filesystem identity, not a replacement at the same path', async () => {
    await registry.grant('documents', rootPath, {
      id: 'stable-root',
      name: 'Documents',
      writable: true,
    });
    const persisted = registry.snapshot();
    await rm(rootPath, { recursive: true, force: true });
    await mkdir(rootPath);
    const restored = createFileRootRegistry();
    await restored.restore(persisted);
    await expect(restored.resolve('documents', 'stable-root')).rejects.toThrow(
      /unknown|revoked/i,
    );
  });
});

describe('file root persistence', () => {
  let rootPath: string;
  let dir: string;
  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), 'kiagent-file-root-'));
    dir = await mkdtemp(join(tmpdir(), 'kiagent-persist-'));
  });
  afterEach(async () => {
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('recovers-after-failure: one failed write does not poison later saves', async () => {
    const target = join(dir, 'file-roots.json');
    const registry = createFileRootRegistry();
    const persist = createFileRootsPersistence(target, registry);
    await chmod(dir, 0o500); // writing into a read-only dir fails
    await registry.grant('documents', rootPath, {
      id: 'a',
      name: 'A',
      writable: true,
    });
    await expect(persist()).rejects.toThrow();
    await chmod(dir, 0o700);
    await registry.grant('kia.x', rootPath, {
      id: 'b',
      name: 'B',
      writable: false,
    });
    await persist();
    const saved = JSON.parse(await readFile(target, 'utf8'));
    expect(saved.map((r: { id: string }) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('dirty-snapshot-retried-without-changes', async () => {
    const target = join(dir, 'file-roots.json');
    const registry = createFileRootRegistry();
    const persist = createFileRootsPersistence(target, registry);
    await registry.grant('kia.x', rootPath, {
      id: 'b',
      name: 'B',
      writable: false,
    });
    await chmod(dir, 0o500);
    await expect(persist()).rejects.toThrow();
    await chmod(dir, 0o700);
    await persist(); // no registry change in between
    const fresh = createFileRootRegistry();
    await restoreFileRootsFromFile(target, fresh);
    expect(await fresh.roots('kia.x')).toEqual([
      { id: 'b', name: 'B', writable: false },
    ]);
  });
});
