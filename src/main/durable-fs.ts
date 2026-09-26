import fs from 'node:fs';

/** Makes a rename or removal in `dir` survive a power cut. Windows cannot
 *  open a directory to sync it (fsync fails with EPERM) and NTFS journals the
 *  rename on its own, so there it is a no-op. */
export function syncDirectory(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
