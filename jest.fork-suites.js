// Suites that fork real extension-host children. Run alongside ~500 other
// suites they starve: a fork parked in S state for minutes, then a 180 s
// timeout on a registration that is synchronous once the child runs. They
// pass alone every time, so they get their own lane instead of longer waits
// (which would relabel a real host-start timeout as a slow pass):
// jest.config.dev.js leaves them out, jest.config.forks.js runs only them,
// and scripts/test.mjs (`npm test`) runs the second with --runInBand.
module.exports = [
  'src/main/platform/__tests__/extension-e2e.test.ts',
  'src/main/platform/__tests__/extension-outbound-e2e.test.ts',
  'src/main/platform/__tests__/attention-e2e.test.ts',
];
