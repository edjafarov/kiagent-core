import { accessLine } from '../access-line';

test('version, what it brings in, pages and the risky caps', () => {
  expect(
    accessLine({
      version: '1.0.0',
      caps: ['net', 'ui', 'query'],
      sourceIds: ['google-calendar'],
      ui: [{} as never],
    }),
  ).toBe(
    'v1.0.0 · brings in Google Calendar · adds a page · uses the internet',
  );
  expect(accessLine({ version: '2.0.0', caps: [], sourceIds: [] })).toBe(
    'v2.0.0',
  );
});
