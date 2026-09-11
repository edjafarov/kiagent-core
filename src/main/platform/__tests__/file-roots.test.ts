/** @jest-environment node */
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileRootRegistry } from '../file-roots';

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
});
