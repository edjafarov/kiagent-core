/** @jest-environment node */
import type { OutboxRow } from '@shared/contracts';
import { changedFields } from '../mirror';

describe('changedFields', () => {
  const row = (over: Partial<OutboxRow>) =>
    ({
      to: ['ann@x.example'],
      cc: [],
      bcc: [],
      subject: 'Re: Lunch',
      bodyMarkdown: 'Hi',
      attachments: [],
      ...over,
    }) as unknown as OutboxRow;

  it('names the fields that differ, by the provider comparison', () => {
    expect(
      changedFields(
        row({}),
        row({ to: ['Ann <ann@x.example>'], subject: 'RE: Lunch' }),
      ),
    ).toEqual([]);
    expect(
      changedFields(
        row({}),
        row({ to: ['bob@x.example'], bodyMarkdown: 'Yo' }),
      ),
    ).toEqual(['to', 'body']);
  });
});
