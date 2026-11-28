// Only the suites in jest.fork-suites.js. Run with --runInBand (scripts/test.mjs
// does): one forked host at a time, nothing else competing for the cores.
const base = require('./package.json').jest;
const FORK_SUITES = require('./jest.fork-suites');

module.exports = {
  ...base,
  testMatch: FORK_SUITES.map((p) => `<rootDir>/${p}`),
};
