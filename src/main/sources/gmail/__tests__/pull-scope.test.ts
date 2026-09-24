import type { Account, Session } from '@shared/contracts';

import * as api from '../gmail-api';
import { pull } from '../gmail-source';
import type { GmailThreadItem } from '../to-document';

jest.mock('../gmail-api', () => ({
  ...jest.requireActual('../gmail-api'),
  fetchProfile: jest.fn(),
  listThreadsPage: jest.fn(),
  getThread: jest.fn(),
  listHistoryPage: jest.fn(),
}));

const mocked = api as jest.Mocked<typeof api>;

function msg(threadId: string, labelIds: string[]) {
  return {
    id: `${threadId}-m`,
    threadId,
    labelIds,
    internalDate: '1704106800000',
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'Subject', value: threadId }],
      body: { data: 'SGk=', size: 2 },
    },
  };
}

const THREADS: Record<string, string[][]> = {
  N: [['INBOX']],
  T: [['TRASH'], ['TRASH', 'Label_1']], // fully trashed
  S: [['SPAM']],
};

function makeSession(config: Record<string, unknown>): Session {
  const account: Account = {
    id: 'acc-1' as Account['id'],
    source: 'gmail',
    identifier: 'owner@example.com',
    config,
    status: 'connecting',
    cursor: null,
    createdAt: new Date().toISOString(),
  };
  return {
    account,
    signal: new AbortController().signal,
    credentials: async () => ({ accessToken: 't' }),
    log: () => {},
  };
}

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

beforeEach(() => {
  jest.resetAllMocks();
  mocked.getThread.mockImplementation(async (_s, id) => {
    if (id === 'GONE')
      throw new Error(
        'gmail 404 https://x/threads/GONE {"error":{"message":"Requested entity was not found."}}',
      );
    return { id, messages: THREADS[id].map((l) => msg(id, l)) } as never;
  });
  mocked.listHistoryPage.mockResolvedValue({
    historyId: '43',
    history: ['N', 'T', 'S', 'GONE'].map((threadId) => ({
      messagesAdded: [{ message: { threadId } }],
    })),
  } as never);
  mocked.fetchProfile.mockResolvedValue({
    emailAddress: 'owner@example.com',
    historyId: '42',
    threadsTotal: 3,
  } as never);
});

const DELTA = { mode: 'delta', historyId: '42' } as never;
const itemIds = (batches: Array<{ items: GmailThreadItem[] }>) =>
  batches.flatMap((b) => b.items.map((i) => i.id)).sort();
const deletionIds = (
  batches: Array<{ deletions?: Array<{ externalId: string }> }>,
) => batches.flatMap((b) => (b.deletions ?? []).map((d) => d.externalId));

describe('gmail pull — unselected buckets are SKIPPED, never deleted (spec §4)', () => {
  it('default selection: a fully trashed or spam thread yields no item and no deletion', async () => {
    const batches = await drain(pull(makeSession({}), DELTA));
    expect(itemIds(batches)).toEqual(['N']);
    expect(deletionIds(batches)).toEqual(['GONE']); // a 404 is still a deletion
  });

  it('with Trash selected, the trashed thread is emitted', async () => {
    const batches = await drain(
      pull(
        makeSession({
          folderRoots: [
            { id: 'mail', name: 'All mail' },
            { id: 'TRASH', name: 'Trash' },
          ],
        }),
        DELTA,
      ),
    );
    expect(itemIds(batches)).toEqual(['N', 'T']);
  });

  it('the backfill applies the same gate', async () => {
    mocked.listThreadsPage.mockResolvedValue({
      threads: [{ id: 'N' }, { id: 'S' }],
    } as never);
    mocked.listHistoryPage.mockResolvedValue({ historyId: '42' } as never);
    const batches = await drain(pull(makeSession({}), null));
    expect(itemIds(batches)).toEqual(['N']);
  });
});
