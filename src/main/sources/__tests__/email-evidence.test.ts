import { extractMessageEvidence } from '../../../shared/message-evidence';

describe('extractMessageEvidence', () => {
  it('retains the author signature while normal body remains cleaned', () => {
    const evidence = extractMessageEvidence({
      messageKey: 'm1',
      author: 'alex@example.com',
      at: '2026-09-09T08:00:00Z',
      plain:
        'Renewal ready.\n\n-- \nAlex Example\nHead of Procurement\nExample Company',
      html: null,
    });
    expect(evidence.signature).toContain('Head of Procurement');
    expect(evidence.author).toBe('alex@example.com');
    expect(evidence.excerpt).toBe('Renewal ready.');
  });

  it('extracts HTML-only signatures and excludes quoted or forwarded senders', () => {
    const evidence = extractMessageEvidence({
      messageKey: 'm2',
      author: 'maria@example.de',
      at: null,
      plain: '',
      html: '<p>Guten Morgen,</p><p>Die Unterlagen sind fertig.</p><p>Viele Grüße<br>Maria Beispiel<br>Einkauf</p><blockquote>Von Bob &lt;bob@example.com&gt;:</blockquote>',
    });
    expect(evidence.excerpt).toContain('Die Unterlagen sind fertig.');
    expect(evidence.signature).toContain('Einkauf');
    expect(evidence.signature).not.toContain('Bob');
  });

  it('recognizes German sign-offs and leaves signature-free messages without evidence', () => {
    const german = extractMessageEvidence({
      messageKey: 'm-de',
      author: 'greta@example.de',
      at: null,
      plain: 'Die Freigabe ist erfolgt.\n\nViele Grüße\nGreta\nEinkauf',
      html: null,
    });
    expect(german.signature).toContain('Viele Grüße');
    expect(german.excerpt).toBe('Die Freigabe ist erfolgt.');

    const none = extractMessageEvidence({
      messageKey: 'm-none',
      author: 'greta@example.de',
      at: null,
      plain: 'Nur eine kurze Nachricht ohne Grußformel.',
      html: null,
    });
    expect(none.signature).toBeNull();
  });

  it('does not treat a repeated signature as additional authored body', () => {
    const evidence = extractMessageEvidence({
      messageKey: 'm-repeat',
      author: 'alex@example.com',
      at: null,
      plain:
        'Status folgt.\n\n--\nAlex Example\nProcurement\n\n> Status folgt.\n> --\n> Alex Example\n> Procurement',
      html: null,
    });
    expect(evidence.excerpt).toBe('Status folgt.');
    expect(evidence.signature).toBe('Alex Example\nProcurement');
  });

  it('rejects malformed authors and boilerplate-only signatures', () => {
    const evidence = extractMessageEvidence({
      messageKey: 'm3',
      author: 'Alex Example',
      at: null,
      plain:
        'Please see the attached file.\n\n--\nThis email and any attachments are confidential.',
      html: null,
    });
    expect(evidence.author).toBe('');
    expect(evidence.signature).toBeNull();
    expect(evidence.excerpt).toBe('Please see the attached file.');
  });

  it('bounds fields and fingerprints canonical evidence deterministically', () => {
    const plain = `Body\n\n--\n${'A'.repeat(2000)}`;
    const a = extractMessageEvidence({
      messageKey: 'm4',
      author: 'A@EXAMPLE.COM',
      at: null,
      plain,
      html: null,
    });
    const b = extractMessageEvidence({
      messageKey: 'm4',
      author: 'a@example.com',
      at: null,
      plain,
      html: null,
    });
    expect(a.signature?.length).toBeLessThanOrEqual(1200);
    expect(a.excerpt.length).toBeLessThanOrEqual(800);
    expect(a.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});
