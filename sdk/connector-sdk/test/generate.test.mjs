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

// `scripts/generate.mjs` copies these three files VERBATIM, and the SDK's
// tsconfig has `rootDir: "src"` and nothing else on the include path. An
// import in any of them resolves against `src/generated/`, where the imported
// module was never copied, so `tsc` fails with a TS2307 naming a generated
// path — and never mentions the core file that actually caused it. Guard the
// invariant here so the failure names the real culprit.
//
// This checks the GENERATED copy, which `npm test` regenerates from core
// immediately before this file runs; for `contracts.ts` and `source-errors.ts`
// the byte-identity tests above additionally pin that copy to the canonical
// file, so for those two the check is transitively a check of `src/shared/`.
const IMPORTISH = /^\s*(?:import\s|export\s[^=]*\sfrom\s|.*\brequire\s*\()/;

for (const f of ['contracts.ts', 'source-errors.ts', 'file-indexability.ts']) {
  test(`generated ${f} has zero imports`, () => {
    const offenders = readFileSync(gen(f), 'utf8')
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => IMPORTISH.test(line));
    assert.deepEqual(
      offenders,
      [],
      `src/shared/${f} must stay import-free — it is copied verbatim into the SDK`,
    );
  });
}
