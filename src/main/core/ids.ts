import { createHash, randomBytes } from 'crypto';

import type { Id } from '@shared/contracts';

/**
 * UUIDv7 (RFC 9562): 48-bit unix-ms timestamp + version/variant bits + random.
 * Time-ordered, so b-tree index locality is good and ids sort by creation.
 */
export function uuidv7(): string {
  const ts = Date.now();
  const bytes = randomBytes(16);
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = 0x70 | (bytes[6] & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 10
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newId<T extends string>(): Id<T> {
  return uuidv7() as Id<T>;
}

/** An id derived from a natural key, so two devices that create the same row
 *  independently (a new master re-reading a source) end up with the same id and
 *  the pull overwrites instead of duplicating. sha256 of the parts, each
 *  length-prefixed so ("a", "bc") is not ("ab", "c"), truncated to 16 bytes and
 *  laid out as a UUID. For new rows only; existing rows keep the ids they have
 *  (spec 7.2.1). */
export function hashedId<T extends string>(kind: T, parts: string[]): Id<T> {
  const h = createHash('sha256');
  h.update(`${kind}\0`);
  for (const p of parts) h.update(`${Buffer.byteLength(p)}:${p}\0`);
  const bytes = h.digest().subarray(0, 16);
  bytes[6] = 0x80 | (bytes[6] & 0x0f); // version 8: custom
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 10
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as Id<T>;
}
