// The parallel lane: package.json's "jest" config minus the suites that fork
// real extension hosts, which starve when they run beside everything else.
//
// `npm test` (scripts/test.mjs) runs this config, then the left-out suites
// one at a time with jest.config.forks.js, so nothing is skipped.
const base = require('./package.json').jest;

// The fork-heavy suites run in their own lane (jest.config.forks.js); see
// jest.fork-suites.js for why.
const HEAVY_SUITES = require('./jest.fork-suites');

module.exports = {
  ...base,
  testPathIgnorePatterns: [...base.testPathIgnorePatterns, ...HEAVY_SUITES],
};
