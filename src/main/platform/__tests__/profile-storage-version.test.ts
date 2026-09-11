/** @jest-environment node */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertProfileStorageVersion,
  markProfileStorageVersion,
} from '../profile-storage-version';

describe('profile shared-storage version gate', () => {
  let profileDir: string;

  beforeEach(async () => {
    profileDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'kiagent-profile-version-'),
    );
  });

  afterEach(async () => {
    await fs.rm(profileDir, { recursive: true, force: true });
  });

  it('marks a fresh profile at version one and accepts it under the same gate', async () => {
    await markProfileStorageVersion(profileDir, 1);
    await expect(
      assertProfileStorageVersion(profileDir, 1),
    ).resolves.toBeUndefined();
  });

  it('rejects a profile marked for a newer or older shared-storage version', async () => {
    await markProfileStorageVersion(profileDir, 2);
    await expect(
      assertProfileStorageVersion(profileDir, 1),
    ).rejects.toMatchObject({
      code: 'PROFILE_STORAGE_VERSION_UNSUPPORTED',
    });

    await markProfileStorageVersion(profileDir, 1);
    await expect(
      assertProfileStorageVersion(profileDir, 2),
    ).rejects.toMatchObject({
      code: 'PROFILE_STORAGE_VERSION_UNSUPPORTED',
    });
  });

  it('fails closed on a malformed marker instead of treating the profile as fresh', async () => {
    await fs.mkdir(path.join(profileDir, 'data'), { recursive: true });
    await fs.writeFile(
      path.join(profileDir, 'data', 'storage-version.json'),
      JSON.stringify({ version: '1' }),
      'utf8',
    );
    await expect(
      assertProfileStorageVersion(profileDir, 1),
    ).rejects.toMatchObject({
      code: 'PROFILE_STORAGE_VERSION_INVALID',
    });
  });

  it('writes the marker atomically and rejects an invalid version', async () => {
    await expect(
      markProfileStorageVersion(profileDir, 0),
    ).rejects.toMatchObject({
      code: 'PROFILE_STORAGE_VERSION_INVALID',
    });
    await expect(
      markProfileStorageVersion(profileDir, 1.5),
    ).rejects.toMatchObject({
      code: 'PROFILE_STORAGE_VERSION_INVALID',
    });
  });
});
