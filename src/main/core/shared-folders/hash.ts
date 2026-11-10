import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** The sha256 of a file's bytes, streamed. */
export function sha256File(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(abs)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
