import fs from 'node:fs/promises';
import path from 'node:path';
import { syncDirectory } from '@main/durable-fs';

export const PROFILE_STORAGE_VERSION = 1;
const MARKER_RELATIVE_PATH = path.join('data', 'storage-version.json');

type VersionMarker = { version: number };
type StorageVersionErrorCode =
  | 'PROFILE_STORAGE_VERSION_INVALID'
  | 'PROFILE_STORAGE_VERSION_UNSUPPORTED';

function fail(message: string, code: StorageVersionErrorCode): never {
  throw Object.assign(new Error(message), { code });
}

function parseVersionMarker(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      'profile shared-storage marker is not an object',
      'PROFILE_STORAGE_VERSION_INVALID',
    );
  }
  const { version } = value as { version?: unknown };
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    return fail(
      'profile shared-storage marker has an invalid version',
      'PROFILE_STORAGE_VERSION_INVALID',
    );
  }
  return version as number;
}

async function markerPath(profileDir: string): Promise<string> {
  const parent = path.join(profileDir, 'data');
  await fs.mkdir(parent, { recursive: true });
  return path.join(profileDir, MARKER_RELATIVE_PATH);
}

export async function assertProfileStorageVersion(
  profileDir: string,
  supportedVersion: number,
): Promise<void> {
  if (!Number.isSafeInteger(supportedVersion) || supportedVersion < 1) {
    fail(
      'unsupported shared-storage version',
      'PROFILE_STORAGE_VERSION_INVALID',
    );
  }
  const filename = path.join(profileDir, MARKER_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(filename, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A profile with no marker is only fresh when the shared DB ledger also
      // has no active/imported entries; bootstrap owns that reconciliation.
      return;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(
      'profile shared-storage marker is not valid JSON',
      'PROFILE_STORAGE_VERSION_INVALID',
    );
  }
  const version = parseVersionMarker(value);
  if (version !== supportedVersion) {
    fail(
      `profile shared-storage version ${version} does not match supported version ${supportedVersion}`,
      'PROFILE_STORAGE_VERSION_UNSUPPORTED',
    );
  }
}

export async function markProfileStorageVersion(
  profileDir: string,
  version: number,
): Promise<void> {
  if (!Number.isSafeInteger(version) || version < 1) {
    fail(
      'profile shared-storage marker version must be a positive integer',
      'PROFILE_STORAGE_VERSION_INVALID',
    );
  }
  const filename = await markerPath(profileDir);
  const temp = `${filename}.${process.pid}.${Date.now()}.tmp`;
  const marker: VersionMarker = { version };
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, filename);
  syncDirectory(path.dirname(filename));
}
