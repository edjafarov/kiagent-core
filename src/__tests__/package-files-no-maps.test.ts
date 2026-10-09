/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
) as { build: { files: string[] } };

test('source maps are excluded from the packaged app', () => {
  const { files } = pkg.build;
  expect(files).toContain('!**/*.map');
  // electron-builder applies patterns in order: the exclusion follows the
  // includes it narrows.
  expect(files.indexOf('!**/*.map')).toBeGreaterThan(files.indexOf('dist'));
  expect(files.indexOf('!**/*.map')).toBeGreaterThan(
    files.indexOf('node_modules'),
  );
});

test('the prod builds still emit maps, for symbolicating crash logs', () => {
  for (const config of [
    'webpack.config.renderer.prod.ts',
    'webpack.config.main.prod.ts',
  ]) {
    expect(
      fs.readFileSync(path.join(ROOT, '.erb', 'configs', config), 'utf8'),
    ).toMatch(/devtool:\s*'source-map'/);
  }
});
