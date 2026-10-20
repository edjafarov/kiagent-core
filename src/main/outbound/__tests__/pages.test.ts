import type { AccountId, OutboxRow } from '@shared/contracts';

import { shapeOutboundError } from '../error-copy';
import { failedPage, resultPage, reviewPage } from '../pages';

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
    createdBy: null,
    createdAt: '2026-07-01T00:00:00Z',
    sentAt: null,
    expiresAt: '2026-07-02T00:00:00Z',
    revision: 1,
    bcc: [],
    attachments: [],
    mirror: null,
    sendAt: null,
    ...overrides,
  };
}

describe('reviewPage', () => {
  it('lists every file with its size and where it came from', () => {
    const html = reviewPage(
      baseRow({
        mirror: {
          ref: { accountId: 'acc-1' as AccountId, id: 'd1' },
          provider: 'Gmail',
        },
        attachments: [
          {
            filename: 'Vertrag.pdf',
            mime: 'application/pdf',
            size: 2048,
            from: { kind: 'document', documentId: 'doc1' },
          },
          { filename: 'logo<1>.png', mime: 'image/png', size: 10 },
        ],
      }),
      { confirmPath: '/c', cancelPath: '/x' },
    );
    expect(html).toContain('class="ob-attachments"');
    expect(html).toContain(
      'Vertrag.pdf <span>· 2 KB · from your indexed documents</span>',
    );
    expect(html).toContain(
      'logo&lt;1&gt;.png <span>· 10 B · added in Gmail</span>',
    );
  });

  it('says where the draft also lives, or why not', () => {
    const paths = { confirmPath: '/c', cancelPath: '/x' };
    const ref = { accountId: 'acc-1' as AccountId, id: 'd1' };
    expect(
      reviewPage(baseRow({ mirror: { ref, provider: 'Gmail' } }), paths),
    ).toContain('In Gmail Drafts');
    expect(
      reviewPage(
        baseRow({
          mirror: { ref: null, error: 'offline', provider: 'Outlook' },
        }),
        paths,
      ),
    ).toContain('Not synced: offline');
    expect(reviewPage(baseRow(), paths)).not.toContain('ob-mirror"');
  });

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

  it('carries the kia brand row and stays sharp-cornered (brand: no radius)', () => {
    const html = reviewPage(baseRow(), {
      confirmPath: '/outbox/confirm/tok',
      cancelPath: '/outbox/cancel/tok',
    });
    expect(html).toContain('sh-min__brand');
    expect(html).toContain('>kia</span>');
    // Outbox's own CSS (the <style> block inside <body>) must not soften
    // corners — tokens.css mandates sharp radii; the shared sheet in <head>
    // keeps its own radius rules (e.g. the round spinner ring).
    expect(html.split('<body>')[1]).not.toContain('border-radius');
  });

  it('shows Bcc, carries the revision, and says when the draft changed', () => {
    const html = reviewPage(
      baseRow({ bcc: ['hid@example.com'], revision: 3 }),
      {
        confirmPath: '/outbox/confirm/tok/3',
        cancelPath: '/outbox/cancel/tok',
        changed: true,
      },
    );
    expect(html).toContain('hid@example.com');
    expect(html).toContain('action="/outbox/confirm/tok/3"');
    expect(html).toContain('ob-changed');
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

describe('failedPage', () => {
  it('retryable: title "Not sent", human message, a Review again form, the summary in <details>, warn icon', () => {
    const shaped = shapeOutboundError(
      'rate-limited: the mail service rejected the send (HTTP 403) — nothing was sent',
    );
    expect(shaped.canRetry).toBe(true);
    const row = baseRow({ status: 'failed', error: shaped.summary });
    const html = failedPage(row, {
      shaped,
      reopenPath: '/outbox/reopen/tok3',
    });
    expect(html).toContain('Not sent');
    expect(html).toContain(shaped.message);
    expect(html).toContain('<form method="POST" action="/outbox/reopen/tok3">');
    expect(html).toContain('Review again');
    expect(html).toContain('<details class="ob-detail">');
    expect(html).toContain(shaped.summary);
    expect(html).toContain('stroke="#c2410c"'); // warn icon
  });

  it('unknown (ambiguous): no form, no "Try again", "Delivery uncertain" title matching the check-Sent-folder copy, warn icon', () => {
    const shaped = shapeOutboundError('send failed: boom');
    expect(shaped.kind).toBe('unknown');
    expect(shaped.canRetry).toBe(false);
    const row = baseRow({ status: 'failed', error: shaped.summary });
    const html = failedPage(row, {
      shaped,
      reopenPath: '/outbox/reopen/tok4',
    });
    expect(html).not.toContain('method="POST"');
    expect(html).not.toContain('Review again');
    expect(html).toContain('Delivery uncertain');
    expect(html).not.toContain('<h1 class="sh-min__h1">Not sent</h1>');
    expect(html).toMatch(/could not confirm delivery|sent folder/i);
    expect(html).toContain(
      "If it's not in your Sent folder, ask your assistant to create a new draft.",
    );
    // Amber warn, not red error: this page's whole point is uncertainty,
    // mirroring the delivery_unknown status page's icon.
    expect(html).toContain('stroke="#c2410c"');
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
      reopenPath: '/outbox/reopen/tok5',
    });
    expect(html).toContain('<h1 class="sh-min__h1">Not sent</h1>');
    expect(html).not.toContain('Delivery uncertain');
    expect(html).not.toContain('method="POST"');
    expect(html).not.toContain('Review again');
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
    expect(html).toContain('stroke="#0d9488"'); // success icon
    expect(html).toContain('You can close this page.');
  });

  it('back-compat: renders fine with only title + message', () => {
    const html = resultPage('T', 'M');
    expect(html).toContain('T');
    expect(html).toContain('M');
  });
});
