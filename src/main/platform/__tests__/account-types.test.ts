import { withAccountTypes } from '../account-types';

test('accounts carry their source descriptor documentTypes', async () => {
  const query = {
    accounts: async () => [
      { id: 'A', source: 'gcal' },
      { id: 'B', source: 'gone' },
    ],
    search: async () => [],
  } as never;
  const sources = {
    get: (id: string) =>
      id === 'gcal'
        ? { descriptor: { documentTypes: ['calendar.event'] } }
        : undefined,
  } as never;
  const wrapped = withAccountTypes(query, sources);
  const accounts = await wrapped.accounts();
  expect(accounts.map((a) => a.documentTypes)).toEqual([
    ['calendar.event'],
    [],
  ]);
  // Every other method is the original query's.
  expect(wrapped.search).toBe((query as { search: unknown }).search);
});
