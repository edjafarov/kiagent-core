import { peakIncreaseMB } from '../mem-probe';

it('peak increase is the high-water mark over the pre-step RSS, in MB', () => {
  expect(peakIncreaseMB(100 * 1024 * 1024, { maxRSS: 600 * 1024 })).toBe(500);
  expect(peakIncreaseMB(700 * 1024 * 1024, { maxRSS: 600 * 1024 })).toBe(0);
});
