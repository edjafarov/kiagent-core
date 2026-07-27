import type { AccountId, OutboxRow } from '@shared/contracts';

import { shapeOutboundError } from '../error-copy';
import { failedPage, linkPage, resultPage, reviewPage } from '../pages';

function baseRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'draft-1',
    accountId: 'acc-1' as AccountId,
    kind: 'new',
    replyToDocumentId: null,
    outboundRef: null,
    recipientDisplay: 'Bob <bob@example.com>',
    to: ['bob@example.com'],
    cc: [],
    subject: 'Hi',
    bodyMarkdown: 'body text',
    threading: null,
    confirmMode: 'review',
    status: 'draft',
    error: null,
    externalMessageId: null,
    createdVia: 'mcp-local',
    createdAt: '2026-07-01T00:00:00Z',
    sentAt: null,
    expiresAt: '2026-07-02T00:00:00Z',
    ...overrides,
  };
}

describe('reviewPage', () => {
  it('renders recipient, subject, body, the send form, cancel form, status div, and the inline script', () => {
    const row = baseRow({ recipientDisplay: 'Alice <alice@example.com>' });
    const html = reviewPage(row, {
      confirmPath: '/outbox/confirm/tok',
      cancelPath: '/outbox/cancel/tok',
    });
    expect(html).toContain('Alice &lt;alice@example.com&gt;');
    expect(html).toContain('Hi');
    expect(html).toContain('body text');
    expect(html).toContain(
      '<form id="ob-send" method="POST" action="/outbox/confirm/tok">',
    );
    expect(html).toMatch(
      /<button id="ob-send-btn"[^>]*class="btn primary ob-btn ob-disable"/,
    );
    expect(html).toContain('action="/outbox/cancel/tok"');
    expect(html).toContain('id="ob-status"');
    expect(html).toContain('<script>');
  });

  it('escapes a script-bearing subject and body', () => {
    const row = baseRow({
      subject: '<script>alert(1)</script>',
      bodyMarkdown: '<script>alert(2)</script>',
    });
    const html = reviewPage(row, {
      confirmPath: '/outbox/confirm/tok',
      cancelPath: '/outbox/cancel/tok',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });
});

describe('linkPage', () => {
  it('renders recipient + send form + script, but no body preview', () => {
    const row = baseRow({
      recipientDisplay: 'Carol <carol@example.com>',
      bodyMarkdown: 'the secret body should not preview here',
    });
    const html = linkPage(row, { confirmPath: '/outbox/confirm/tok2' });
    expect(html).toContain('Carol &lt;carol@example.com&gt;');
    expect(html).toContain(
      '<form id="ob-send" method="POST" action="/outbox/confirm/tok2">',
    );
    expect(html).toContain('<script>');
    expect(html).not.toContain('the secret body should not preview here');
  });
});

describe('failedPage', () => {
  it('retryable: title "Not sent", human message, a Try again form, the summary in <details>, warn icon', () => {
    const shaped = shapeOutboundError(
      'rate-limited: the mail service rejected the send (HTTP 403) — nothing was sent',
    );
    expect(shaped.canRetry).toBe(true);
    const row = baseRow({ status: 'failed', error: shaped.summary });
    const html = failedPage(row, {
      shaped,
      confirmPath: '/outbox/confirm/tok3',
    });
    expect(html).toContain('Not sent');
    expect(html).toContain(shaped.message);
    expect(html).toContain(
      '<form id="ob-send" method="POST" action="/outbox/confirm/tok3">',
    );
    expect(html).toContain('Try again');
    expect(html).toContain('<details class="ob-detail">');
    expect(html).toContain(shaped.summary);
    expect(html).toContain('stroke="#d97706"'); // warn icon
  });

  it('unknown (ambiguous): no form, no "Try again", "Delivery uncertain" title matching the check-Sent-folder copy, warn icon', () => {
    const shaped = shapeOutboundError('send failed: boom');
    expect(shaped.kind).toBe('unknown');
    expect(shaped.canRetry).toBe(false);
    const row = baseRow({ status: 'failed', error: shaped.summary });
    const html = failedPage(row, {
      shaped,
      confirmPath: '/outbox/confirm/tok4',
    });
    expect(html).not.toContain('method="POST"');
    expect(html).not.toContain('Try again');
    expect(html).toContain('Delivery uncertain');
    expect(html).not.toContain('<h1 class="sh-min__h1">Not sent</h1>');
    expect(html).toMatch(/could not confirm delivery|sent folder/i);
    expect(html).toContain(
      "If it's not in your Sent folder, ask your assistant to create a new draft.",
    );
    // Amber warn, not red error: this page's whole point is uncertainty,
    // mirroring the delivery_unknown status page's icon.
    expect(html).toContain('stroke="#d97706"');
    expect(html).not.toContain('stroke="#e11d48"');
  });

  it('unsupported: certain failure, still title "Not sent", no retry form', () => {
    const shaped = shapeOutboundError(
      "sending from 'slack' accounts is not supported yet — supported: gmail, imap",
    );
    expect(shaped.kind).toBe('unsupported');
    expect(shaped.canRetry).toBe(false);
    const row = baseRow({ status: 'failed', error: shaped.summary });
    const html = failedPage(row, {
      shaped,
      confirmPath: '/outbox/confirm/tok5',
    });
    expect(html).toContain('<h1 class="sh-min__h1">Not sent</h1>');
    expect(html).not.toContain('Delivery uncertain');
    expect(html).not.toContain('method="POST"');
    expect(html).not.toContain('Try again');
    expect(html).toContain('Ask your assistant to create a new draft.');
    expect(html).toContain('stroke="#e11d48"'); // certain failure keeps the error icon
  });
});

describe('resultPage', () => {
  it('renders the icon svg and the footNote text when given', () => {
    const html = resultPage('All done', 'It worked.', {
      icon: 'success',
      footNote: 'You can close this page.',
    });
    expect(html).toContain('All done');
    expect(html).toContain('It worked.');
    expect(html).toContain('stroke="#059669"'); // success icon
    expect(html).toContain('You can close this page.');
  });

  it('back-compat: renders fine with only title + message', () => {
    const html = resultPage('T', 'M');
    expect(html).toContain('T');
    expect(html).toContain('M');
  });
});
