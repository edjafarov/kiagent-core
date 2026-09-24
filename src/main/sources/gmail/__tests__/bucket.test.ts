import { selectedBuckets, threadBucket } from '../bucket';

describe('threadBucket — one scope bucket per thread (spec §4)', () => {
  it('is TRASH only when every message is in Trash or Spam and one is in Trash', () => {
    expect(
      threadBucket([
        { labelIds: ['TRASH'] },
        { labelIds: ['TRASH', 'IMPORTANT'] },
      ]),
    ).toBe('TRASH');
    expect(threadBucket([{ labelIds: ['SPAM', 'TRASH'] }])).toBe('TRASH');
  });

  it('is mail when any message is outside both Trash and Spam', () => {
    expect(threadBucket([{ labelIds: ['TRASH'] }, { labelIds: [] }])).toBe(
      'mail',
    );
    expect(
      threadBucket([{ labelIds: ['SPAM'] }, { labelIds: ['INBOX'] }]),
    ).toBe('mail');
  });

  it('is SPAM when every message is in Spam and none in Trash', () => {
    expect(threadBucket([{ labelIds: ['SPAM'] }])).toBe('SPAM');
  });

  it('treats drafts, chats and label-less messages as mail', () => {
    expect(threadBucket([{ labelIds: ['DRAFT'] }])).toBe('mail');
    expect(threadBucket([{ labelIds: ['CHAT'] }])).toBe('mail');
    expect(threadBucket([{}])).toBe('mail');
  });
});

describe('selectedBuckets', () => {
  it('is {mail} for a config that declares no scope', () => {
    expect([...selectedBuckets({})]).toEqual(['mail']);
  });

  it('always includes mail and ignores unknown ids', () => {
    expect(
      selectedBuckets({
        folderRoots: [
          { id: 'TRASH', name: 'Trash' },
          { id: 'Label_9', name: 'Nope' },
        ],
      }),
    ).toEqual(new Set(['mail', 'TRASH']));
  });
});
