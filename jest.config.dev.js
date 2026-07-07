// Jest config for the CI test gate (.github/workflows/kiagent-core-ci.yml).
//
// It reuses the full base config from package.json's "jest" field but can skip
// heavyweight integration suites that are unreliable on a shared 4-core CI
// runner (real child processes, HTTPS servers, etc. flake under CPU contention
// even though they pass on a developer machine).
//
// Suites listed here are NOT skipped locally — plain `npm test` still runs the
// whole suite. The greenfield rebuild has no such suites yet; add paths as
// timing-sensitive integration tests appear.
const base = require('./package.json').jest;

const HEAVY_SUITES = [];

module.exports = {
  ...base,
  testPathIgnorePatterns: [...base.testPathIgnorePatterns, ...HEAVY_SUITES],
};
