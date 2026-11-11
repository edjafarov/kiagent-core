import path from 'path';

import { normalizeRel, STAGING_DIR, toAbs, toRel } from '../paths';

const root = path.join(path.sep, 'r', 'Incoming');
const NFD = 'Cafe\u0301.pdf';
const NFC = 'Caf\u00e9.pdf';

it('toRel gives a posix NFC path and toAbs maps it back', () => {
  const abs = path.join(root, 'sub', NFD);
  expect(toRel(root, abs)).toBe(`sub/${NFC}`);
  expect(toAbs(root, `sub/${NFC}`)).toBe(path.join(root, 'sub', NFC));
});

it('normalizeRel converts NFD and backslashes', () => {
  expect(normalizeRel(NFD)).toBe(NFC);
  expect(normalizeRel('a\\b.txt')).toBe('a/b.txt');
});

it('toRel is null outside the root, for the root itself and inside the staging dir', () => {
  expect(toRel(root, path.join(path.sep, 'r', 'Other', 'x'))).toBeNull();
  expect(toRel(root, path.join(path.sep, 'r', 'Incoming2', 'x'))).toBeNull();
  expect(toRel(root, root)).toBeNull();
  expect(toRel(root, path.join(root, STAGING_DIR, 'tmp'))).toBeNull();
  expect(toRel(root, path.join(root, STAGING_DIR))).toBeNull();
  expect(toRel(root, path.join(root, `${STAGING_DIR}x`, 'f'))).toBe(`${STAGING_DIR}x/f`);
});

it('toAbs rejects escapes, absolute paths and empty segments', () => {
  expect(() => toAbs(root, '../x')).toThrow();
  expect(() => toAbs(root, 'a/../../x')).toThrow();
  expect(() => toAbs(root, '/x')).toThrow();
  expect(() => toAbs(root, 'a//b')).toThrow();
  expect(() => toAbs(root, '')).toThrow();
});
