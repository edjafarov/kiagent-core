import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = (f) => join(sdkRoot, '..', '..', 'src', 'shared', f);
const gen = (f) => join(sdkRoot, 'src', 'generated', f);

for (const f of ['contracts.ts', 'source-errors.ts']) {
  test(`generated ${f} is byte-identical to canonical`, () => {
    assert.equal(readFileSync(gen(f), 'utf8'), readFileSync(core(f), 'utf8'));
  });
}

test('compiled entrypoint exposes the taxonomy', async () => {
  assert.ok(existsSync(join(sdkRoot, 'dist', 'index.js')));
  const sdk = await import(join(sdkRoot, 'dist', 'index.js'));
  const e = new sdk.SourceAuthError('x');
  assert.equal(e.code, 'auth');
  assert.equal(sdk.sourceErrorCode(e), 'auth');
});
