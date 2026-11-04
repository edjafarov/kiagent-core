// Built-bundle check for the compiled test gate (__KIA_TEST_HOOKS__).
//
//   node --test scripts/test-hooks-bundle.test.mjs
//
// Builds the production main bundle twice into temp dirs: without
// KIA_TEST_BUILD (must contain NO `kia-test-hooks:on`) and with it (must
// contain it, which proves the scan can actually see the string). Run from the
// project root of the repo that owns the webpack configs; the release
// packaging check should call this before shipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SENTINEL = 'kia-test-hooks:on';
const root = process.cwd();

function build(env) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-hooks-bundle-'));
  const cleanEnv = { ...process.env, ...env };
  if (!env.KIA_TEST_BUILD) delete cleanEnv.KIA_TEST_BUILD;
  const r = spawnSync(
    'npx',
    [
      'webpack',
      '--config',
      './.erb/configs/webpack.config.main.prod.ts',
      '--output-path',
      out,
      // A missing optional dep must not hide the bundle from the scan.
      '--optimization-emit-on-errors',
    ],
    {
      cwd: root,
      env: {
        ...cleanEnv,
        NODE_ENV: 'production',
        TS_NODE_TRANSPILE_ONLY: 'true',
        NODE_OPTIONS: '-r ts-node/register --no-warnings',
      },
      encoding: 'utf8',
    },
  );
  const files = fs.existsSync(out)
    ? fs.readdirSync(out).filter((f) => f.endsWith('.js'))
    : [];
  assert.ok(
    files.includes('main.js'),
    `no main.js emitted (status ${r.status}): ${(r.stdout + r.stderr).slice(-600)}`,
  );
  const hits = files.filter((f) =>
    fs.readFileSync(path.join(out, f), 'utf8').includes(SENTINEL),
  );
  fs.rmSync(out, { recursive: true, force: true });
  return hits;
}

test('a production build without KIA_TEST_BUILD has no test-hooks sentinel', () => {
  assert.deepEqual(build({}), []);
});

test('control: a KIA_TEST_BUILD=1 build does contain it', () => {
  assert.ok(build({ KIA_TEST_BUILD: '1' }).length > 0);
});
