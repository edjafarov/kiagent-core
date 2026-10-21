import type { OutboxRow } from '@shared/contracts';

import { renderEmailBody } from '../email-body';
import { intentOf } from '../mirror';

describe('intentOf', () => {
  it('carries the rendered HTML with the Markdown', () => {
    const row = {
      accountId: 'a1',
      kind: 'new',
      outboundRef: null,
      to: ['x@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hi',
      bodyMarkdown: '## Plan\n\n- **one**',
      threading: null,
    } as unknown as OutboxRow;
    const intent = intentOf(row);
    expect(intent.bodyMarkdown).toBe(row.bodyMarkdown);
    expect(intent.bodyHtml).toBe(renderEmailBody(row.bodyMarkdown).html);
    expect(intent.bodyHtml).toContain('<strong>one</strong>');
  });
});
