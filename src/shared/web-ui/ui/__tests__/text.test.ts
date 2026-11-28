import { formatBytes, plural } from '../text';

test('plural counts a thing in words', () => {
  expect(plural(1, 'item')).toBe('1 item');
  expect(plural(0, 'item')).toBe('0 items');
  expect(plural(1204, 'item')).toBe('1,204 items');
  expect(plural(2, 'person', 'people')).toBe('2 people');
  expect(plural(1, 'person', 'people')).toBe('1 person');
});

test('formatBytes keeps one decimal under ten of a unit', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(812)).toBe('812 B');
  expect(formatBytes(1536)).toBe('1.5 KB');
  expect(formatBytes(3.2 * 1024 ** 2)).toBe('3.2 MB');
  expect(formatBytes(45.3 * 1024 ** 2)).toBe('45 MB');
  expect(formatBytes(45.3 * 1024 ** 3)).toBe('45 GB');
  expect(formatBytes(1.4 * 1024 ** 4)).toBe('1.4 TB');
  expect(formatBytes(5000 * 1024 ** 4)).toBe('5000 TB');
});
