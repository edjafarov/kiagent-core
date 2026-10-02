import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Import from the BUILT root entrypoint (`dist/index.js`), not `src` — this
// is the test that matters most in the SDK: contracts.ts and
// source-errors.ts are types and error classes, so nothing else proves the
// generated copy of file-indexability.ts ships working RUNTIME code.
const sdk = await import(join(sdkRoot, 'dist', 'index.js'));
const { decideFileIndexing } = sdk;

test('cloud mp3 is cloud-media', () => {
  assert.deepEqual(
    decideFileIndexing({
      profile: 'cloud-drive',
      filename: 'song.mp3',
      mime: 'audio/mpeg',
      sizeBytes: 100,
    }),
    { kind: 'ignore', reason: 'cloud-media' },
  );
});

test('local mp3 is audio', () => {
  assert.deepEqual(
    decideFileIndexing({
      profile: 'local-folder',
      filename: 'meeting.mp3',
      mime: 'audio/mpeg',
      sizeBytes: 100,
      path: '/d/meeting.mp3',
    }),
    { kind: 'index', pipeline: 'audio', bytes: 'eager' },
  );
});

test('zip is archive', () => {
  assert.deepEqual(
    decideFileIndexing({
      profile: 'cloud-drive',
      filename: 'backup.zip',
      mime: 'application/zip',
      sizeBytes: 1,
    }),
    { kind: 'ignore', reason: 'archive' },
  );
});

test('a 30 MiB local pdf is a deferred converter row', () => {
  assert.deepEqual(
    decideFileIndexing({
      profile: 'local-folder',
      filename: 'big.pdf',
      mime: 'application/pdf',
      sizeBytes: 30 * 1024 * 1024,
      path: '/d/big.pdf',
    }),
    { kind: 'index', pipeline: 'converter', bytes: 'deferred' },
  );
});

test('exports the bytes-aware policy', () => {
  assert.equal(sdk.FILE_POLICY_VERSION, 2);
  assert.equal(sdk.MAX_FETCH_BYTES, 100 * 1024 * 1024);
  assert.deepEqual(
    sdk.decideFileIndexing({
      profile: 'cloud-drive',
      filename: 'a.pdf',
      mime: 'application/pdf',
      sizeBytes: 60 * 1024 * 1024,
    }),
    { kind: 'index', pipeline: 'converter', bytes: 'deferred' },
  );
});
