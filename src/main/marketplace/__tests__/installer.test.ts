/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as tar from 'tar';

import { createInstaller } from '../installer';

const MANIFEST = {
  id: 'test.basic',
  name: 'Basic',
  version: '1.0.0',
  engine: '^1.0.0',
  entry: 'index.js',
  caps: ['net'],
  contributes: { sources: ['basicsrc'] },
};

function makeExtDirFixture(root: string, manifest: unknown = MANIFEST): string {
  const dir = path.join(root, 'pkg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    'module.exports={activate:async()=>({})};',
  );
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

describe('createInstaller (local refs)', () => {
  let tmp: string;
  let extDir: string;
  let owners: Record<string, string>;
  let installer: ReturnType<typeof createInstaller>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-inst-'));
    extDir = path.join(tmp, 'extensions');
    owners = { gmail: 'builtin' };
    installer = createInstaller({ extDir, sourceIdOwners: () => owners });
  });
  afterEach(() => {
    installer.discardAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('previews a directory and commits it into extDir with an installed.json record', async () => {
    const pkg = makeExtDirFixture(tmp);
    const pending = await installer.preview(pkg);
    expect(pending.manifest.id).toBe('test.basic');
    expect(pending.integrity).toBeNull();
    expect(pending.sizeBytes).toBeGreaterThan(0);

    const { record, dir } = await installer.commit(pending.token);
    expect(dir).toBe(path.join(extDir, 'test.basic'));
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    expect(record).toMatchObject({
      id: 'test.basic',
      version: '1.0.0',
      origin: 'dev',
    });
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(extDir, 'installed.json'), 'utf8'),
    );
    expect(onDisk).toHaveLength(1);
    // token is one-shot
    await expect(installer.commit(pending.token)).rejects.toThrow(
      /unknown|expired/,
    );
  });

  it('previews a .tgz (strip:1) and rejects marketplace refs', async () => {
    makeExtDirFixture(tmp);
    const tgz = path.join(tmp, 'pkg.tgz');
    // npm-pack convention: one top-level dir ('pkg/…') that strip:1 drops.
    await tar.c({ gzip: true, file: tgz, cwd: tmp }, ['pkg']);
    const pending = await installer.preview(tgz);
    expect(pending.manifest.id).toBe('test.basic');
    await expect(installer.preview('github:kia-plugins/x')).rejects.toThrow(
      /not available yet/,
    );
    await expect(
      installer.preview('https://example.com/x.tgz'),
    ).rejects.toThrow(/not available yet/);
  });

  it('rejects a plaintext http: ref with a clear error, never falling through to the local-path branch', async () => {
    // Without this check, narrowing marketplace-ref detection to
    // github:/https: only would route http: refs into the local-path
    // branch, producing a confusing "no such path" filesystem error
    // instead of a clear refusal — TOFU integrity-pinning only protects
    // RE-installs, so a first install over plaintext http is MITM-able.
    await expect(installer.preview('http://example.com/x.tgz')).rejects.toThrow(
      'insecure http: refs are not supported — use an https: URL or a github: ref',
    );
    // https: behavior is unchanged by the http: rejection.
    await expect(
      installer.preview('https://example.com/x.tgz'),
    ).rejects.toThrow(/not available yet/);
  });

  it('rejects source-id collisions owned by someone else, allows self-updates', async () => {
    owners = { basicsrc: 'other.ext' };
    await expect(installer.preview(makeExtDirFixture(tmp))).rejects.toThrow(
      /already provided by other.ext/,
    );
    owners = { basicsrc: 'test.basic' };
    await expect(
      installer.preview(makeExtDirFixture(tmp)),
    ).resolves.toBeDefined();
  });

  it('update preserves data/ and evicts the oldest pending beyond 8', async () => {
    const pkg = makeExtDirFixture(tmp);
    const p1 = await installer.preview(pkg);
    const { dir } = await installer.commit(p1.token);
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data', 'keep.txt'), 'precious');

    const p2 = await installer.preview(
      makeExtDirFixture(path.join(tmp, 'v2'), {
        ...MANIFEST,
        version: '1.1.0',
      }),
    );
    await installer.commit(p2.token);
    expect(fs.readFileSync(path.join(dir, 'data', 'keep.txt'), 'utf8')).toBe(
      'precious',
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
        .version,
    ).toBe('1.1.0');

    const first = await installer.preview(pkg);
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await installer.preview(pkg);
    }
    await expect(installer.commit(first.token)).rejects.toThrow(
      /unknown|expired/,
    );
  });

  it('rejects an invalid package (bad manifest) at preview', async () => {
    const bad = makeExtDirFixture(tmp, { ...MANIFEST, caps: ['teleport'] });
    await expect(installer.preview(bad)).rejects.toThrow(/invalid manifest/);
  });

  it('peek() returns the pending manifest id without consuming the token; throws for unknown tokens (F4)', async () => {
    const pkg = makeExtDirFixture(tmp);
    const pending = await installer.preview(pkg);
    expect(installer.peek(pending.token)).toBe('test.basic');
    // Read-only: a second peek() still works, and commit() afterwards still
    // succeeds — peek() must not consume/evict the pending entry.
    expect(installer.peek(pending.token)).toBe('test.basic');
    await expect(installer.commit(pending.token)).resolves.toMatchObject({
      manifest: { id: 'test.basic' },
    });

    expect(() => installer.peek('no-such-token')).toThrow(/unknown or expired/);
  });

  it('rejects a .tgz that ships a data/ directory', async () => {
    const pkg = makeExtDirFixture(tmp);
    fs.mkdirSync(path.join(pkg, 'data'));
    fs.writeFileSync(path.join(pkg, 'data', 'anything.txt'), 'should fail');
    const tgz = path.join(tmp, 'pkg-with-data.tgz');
    await tar.c({ gzip: true, file: tgz, cwd: tmp }, ['pkg']);
    await expect(installer.preview(tgz)).rejects.toThrow(
      "package ships a 'data/' directory — 'data/' is reserved for extension-private state",
    );
  });

  it('accepts a directory with data/ but excludes it from staging', async () => {
    const pkg = makeExtDirFixture(tmp);
    fs.mkdirSync(path.join(pkg, 'data'));
    fs.writeFileSync(path.join(pkg, 'data', 'junk.txt'), 'dev-loop artifact');
    const pending = await installer.preview(pkg);
    expect(pending.manifest.id).toBe('test.basic');
    // Staging dir should not contain the data/ directory
    expect(fs.existsSync(path.join(pending.stagingDir, 'data'))).toBe(false);
  });

  describe('marketplace refs', () => {
    async function tgzBytesOf(
      version: string,
      extra?: { name: string; content: string },
    ): Promise<Buffer> {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-mkt-src-'));
      const pkg = makeExtDirFixture(root, {
        ...MANIFEST,
        id: 'mkt.demo',
        version,
      });
      if (extra) fs.writeFileSync(path.join(pkg, extra.name), extra.content);
      const tgz = path.join(root, 'pkg.tgz');
      await tar.c({ gzip: true, file: tgz, cwd: root }, ['pkg']);
      const bytes = fs.readFileSync(tgz);
      fs.rmSync(root, { recursive: true, force: true });
      return bytes;
    }

    it('still rejects marketplace refs when no download dep is wired', async () => {
      await expect(installer.preview('github:kia-plugins/x')).rejects.toThrow(
        /not available yet/,
      );
      await expect(
        installer.preview('https://example.com/x.tgz'),
      ).rejects.toThrow(/not available yet/);
    });

    it('downloads, pins integrity, and records origin marketplace + pinned ref', async () => {
      const bytes = await tgzBytesOf('1.0.0');
      const download = jest.fn(async () => ({
        bytes,
        pinnedRef: 'github:o/r@v1.0.0',
      }));
      const inst = createInstaller({
        extDir,
        sourceIdOwners: () => owners,
        download,
      });
      const p = await inst.preview('github:o/r');
      expect(download).toHaveBeenCalledWith('github:o/r');
      expect(p.integrity).toMatch(/^sha512-/);
      expect(p.ref).toBe('github:o/r@v1.0.0');
      expect(p.origin).toBe('marketplace');
      const { record } = await inst.commit(p.token);
      expect(record).toMatchObject({
        origin: 'marketplace',
        ref: 'github:o/r@v1.0.0',
        integrity: p.integrity,
      });
    });

    it('TOFU: same id+version with different bytes is rejected; same bytes and version bumps pass', async () => {
      const v1Bytes = await tgzBytesOf('1.0.0');
      const inst1 = createInstaller({
        extDir,
        sourceIdOwners: () => owners,
        download: async () => ({
          bytes: v1Bytes,
          pinnedRef: 'github:o/r@v1.0.0',
        }),
      });
      const p1 = await inst1.preview('github:o/r');
      await inst1.commit(p1.token);

      // Rebuilt v1.0.0 tgz with an extra file -> different bytes, same id+version -> rejected.
      const v1BytesDiff = await tgzBytesOf('1.0.0', {
        name: 'extra.txt',
        content: 'diff',
      });
      const instDiff = createInstaller({
        extDir,
        sourceIdOwners: () => owners,
        download: async () => ({
          bytes: v1BytesDiff,
          pinnedRef: 'github:o/r@v1.0.0',
        }),
      });
      await expect(instDiff.preview('github:o/r')).rejects.toThrow(
        'integrity check failed: bytes differ from the pinned install for this version',
      );

      // Byte-identical v1.0.0 tgz -> ok (same pinned integrity, passes TOFU check).
      const instSame = createInstaller({
        extDir,
        sourceIdOwners: () => owners,
        download: async () => ({
          bytes: v1Bytes,
          pinnedRef: 'github:o/r@v1.0.0',
        }),
      });
      const pSame = await instSame.preview('github:o/r');
      expect(pSame.integrity).toBe(p1.integrity);
      instSame.discardAll();

      // v2.0.0 (different bytes AND different version) -> ok, no TOFU conflict.
      const v2Bytes = await tgzBytesOf('2.0.0');
      const instV2 = createInstaller({
        extDir,
        sourceIdOwners: () => owners,
        download: async () => ({
          bytes: v2Bytes,
          pinnedRef: 'github:o/r@v2.0.0',
        }),
      });
      const pV2 = await instV2.preview('github:o/r');
      expect(pV2.manifest.version).toBe('2.0.0');
      instV2.discardAll();
    });

    it('local refs still work and never pin', async () => {
      const pkg = makeExtDirFixture(tmp);
      const p = await installer.preview(pkg);
      expect(p.integrity).toBeNull();
      expect(p.origin).toBe('dev');
    });

    it('cleans staging and propagates when download rejects', async () => {
      const mkdtempSpy = jest.spyOn(fs, 'mkdtempSync');
      const inst = createInstaller({
        extDir,
        sourceIdOwners: () => owners,
        download: async () => {
          throw new Error('offline');
        },
      });
      await expect(inst.preview('github:o/r')).rejects.toThrow('offline');
      const stagingDir = mkdtempSpy.mock.results[
        mkdtempSpy.mock.results.length - 1
      ].value as string;
      expect(fs.existsSync(stagingDir)).toBe(false);
      mkdtempSpy.mockRestore();
    });

    it('cleans up the sibling staging .tgz even when writeFileSync itself throws mid-write (e.g. disk full)', async () => {
      const bytes = await tgzBytesOf('1.0.0');
      const inst = createInstaller({
        extDir,
        sourceIdOwners: () => owners,
        download: async () => ({ bytes, pinnedRef: 'github:o/r@v1.0.0' }),
      });
      const mkdtempSpy = jest.spyOn(fs, 'mkdtempSync');
      const originalWriteFileSync = fs.writeFileSync;
      const writeSpy = jest
        .spyOn(fs, 'writeFileSync')
        .mockImplementation(
          (file: fs.PathOrFileDescriptor, data: unknown, options?: unknown) => {
            if (typeof file === 'string' && file.endsWith('.tgz')) {
              // Simulate a real disk-full failure: bytes do land on disk
              // before the write call throws, so the only thing that can
              // prevent a leak here is the installer's own cleanup.
              originalWriteFileSync(file, data as never, options as never);
              throw new Error('ENOSPC: no space left on device');
            }
            return originalWriteFileSync(file, data as never, options as never);
          },
        );

      await expect(inst.preview('github:o/r')).rejects.toThrow('ENOSPC');

      const stagingDir = mkdtempSpy.mock.results[
        mkdtempSpy.mock.results.length - 1
      ].value as string;
      expect(fs.existsSync(`${stagingDir}.tgz`)).toBe(false);
      expect(fs.existsSync(stagingDir)).toBe(false);

      writeSpy.mockRestore();
      mkdtempSpy.mockRestore();
    });
  });
});
