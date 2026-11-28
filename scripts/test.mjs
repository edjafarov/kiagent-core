// scripts/test.mjs — `npm test`: every suite in parallel except the ones that
// fork real extension hosts (jest.config.dev.js), then those one at a time
// (jest.config.forks.js --runInBand); see jest.fork-suites.js for why.
// Arguments go to both runs, so `npm test -- src/main/core` filters both.
// Passing your own -c/--config runs plain jest with your arguments.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jest = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'jest.cmd' : 'jest',
);
const args = process.argv.slice(2);
const run = (extra) =>
  spawnSync(jest, [...extra, ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }).status ?? 1;

if (
  args.some((a) => a === '-c' || a === '--config' || a.startsWith('--config='))
) {
  process.exit(run([]));
}
const parallel = run(['-c', 'jest.config.dev.js', '--passWithNoTests']);
const forks = run([
  '-c',
  'jest.config.forks.js',
  '--runInBand',
  '--passWithNoTests',
]);
process.exit(parallel || forks);
