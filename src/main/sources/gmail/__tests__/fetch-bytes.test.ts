import { gmailSource } from '../gmail-source';
import * as api from '../gmail-api';
import type { GmailApiMessage } from '../parser';

jest.mock('../gmail-api', () => ({
  ...jest.requireActual('../gmail-api'),
  getAttachment: jest.fn(),
  getMessage: jest.fn(),
}));

const session = {
  account: { id: 'a1', source: 'gmail', identifier: 'me@x' },
  signal: new AbortController().signal,
  credentials: async () => ({ accessToken: 't' }),
  log: () => {},
} as never;

const attachmentDoc = {
  id: 'd1',
  type: 'attachment',
  metadata: {
    messageId: 'm1',
    partId: '2',
    attachmentId: 'OLD',
    mime: 'application/pdf',
  },
} as never;

// Fixture: a message with part 2 that has attachmentId 'NEW' (for re-resolve case)
const FIXTURE_MESSAGE_WITH_PART_2_NEW_ID: GmailApiMessage = {
  id: 'm1',
  threadId: 'thread1',
  labelIds: ['INBOX'],
  internalDate: '1704106800000',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'sender@example.com' },
      { name: 'To', value: 'recipient@example.com' },
      { name: 'Subject', value: 'Email with attachments' },
      { name: 'Date', value: 'Mon, 1 Jan 2024 10:00:00 -0800' },
      { name: 'Message-ID', value: '<m1@example.com>' },
    ],
    parts: [
      {
        partId: '0',
        mimeType: 'text/plain',
        body: { data: 'SGVsbG8gd29ybGQ=', size: 12 },
      },
      {
        partId: '2',
        mimeType: 'application/pdf',
        filename: 'document.pdf',
        headers: [
          {
            name: 'Content-Disposition',
            value: 'attachment; filename="document.pdf"',
          },
        ],
        body: { attachmentId: 'NEW', size: 50_000 },
      },
    ],
  },
};

describe('gmail fetchBytes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('decodes base64url attachment bytes', async () => {
    (api.getAttachment as jest.Mock).mockResolvedValue({
      size: 3,
      data: Buffer.from([1, 2, 3]).toString('base64url'),
    });
    const bytes = await gmailSource.fetchBytes!(session, attachmentDoc);
    expect([...bytes!]).toEqual([1, 2, 3]);
    expect(api.getAttachment).toHaveBeenCalledWith(session, 'm1', 'OLD');
  });

  it('decodes base64url with - and _ characters', async () => {
    const payload = [0xff, 0xef, 0xbe];
    (api.getAttachment as jest.Mock).mockResolvedValue({
      size: payload.length,
      data: Buffer.from(payload).toString('base64url'),
    });
    const bytes = await gmailSource.fetchBytes!(session, attachmentDoc);
    expect([...bytes!]).toEqual(payload);
    expect(api.getAttachment).toHaveBeenCalledWith(session, 'm1', 'OLD');
  });

  it('re-resolves a rotated attachmentId via the message part tree', async () => {
    (api.getAttachment as jest.Mock)
      .mockRejectedValueOnce(
        new Error(
          'gmail 404 https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/attachments/OLD {"error": {"message": "Requested entity was not found."}}',
        ),
      )
      .mockResolvedValueOnce({
        size: 1,
        data: Buffer.from([9]).toString('base64url'),
      });
    (api.getMessage as jest.Mock).mockResolvedValue(
      FIXTURE_MESSAGE_WITH_PART_2_NEW_ID,
    );
    const bytes = await gmailSource.fetchBytes!(session, attachmentDoc);
    expect([...bytes!]).toEqual([9]);
    expect(api.getAttachment).toHaveBeenLastCalledWith(session, 'm1', 'NEW');
  });

  it('returns null for docs without attachment metadata', async () => {
    const out = await gmailSource.fetchBytes!(session, {
      id: 'x',
      type: 'email.thread',
      metadata: {},
    } as never);
    expect(out).toBeNull();
  });

  it('propagates non-404 errors from getAttachment', async () => {
    (api.getAttachment as jest.Mock).mockRejectedValueOnce(
      new Error(
        'gmail 500 https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/attachments/OLD {"error": {"message": "Internal Server Error"}}',
      ),
    );
    await expect(
      gmailSource.fetchBytes!(session, attachmentDoc),
    ).rejects.toThrow(/gmail 500/);
    expect(api.getMessage).not.toHaveBeenCalled();
  });
});
