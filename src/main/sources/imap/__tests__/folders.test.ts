import { resolveMailboxes } from '../folders';
import type { ImapFolderInfo } from '../types';

function folder(path: string, specialUse?: string): ImapFolderInfo {
  return { path, specialUse, flags: [] };
}

describe('resolveMailboxes', () => {
  it('prefers RFC 6154 special-use flags for all-mail and sent', () => {
    const folders = [
      folder('INBOX'),
      folder('[Gmail]/All Mail', '\\All'),
      folder('[Gmail]/Sent Mail', '\\Sent'),
      folder('[Gmail]/Trash', '\\Trash'),
    ];
    const out = resolveMailboxes(folders);
    expect(out).toEqual([
      { path: '[Gmail]/All Mail', role: 'all' },
      { path: '[Gmail]/Sent Mail', role: 'sent' },
    ]);
  });

  it('falls back to name heuristics when no special-use flags exist', () => {
    const folders = [folder('INBOX'), folder('Sent Items'), folder('Junk'), folder('Archive')];
    const out = resolveMailboxes(folders);
    // No "All"/"All Mail" folder present, so INBOX is used (role 'inbox'),
    // plus Sent Items by name. Archive must NOT be picked as all-mail.
    expect(out).toEqual([
      { path: 'INBOX', role: 'inbox' },
      { path: 'Sent Items', role: 'sent' },
    ]);
  });

  it('prefers a named "All Mail" folder over plain INBOX when no special-use', () => {
    const folders = [folder('INBOX'), folder('All Mail'), folder('Sent')];
    const out = resolveMailboxes(folders);
    expect(out).toEqual([
      { path: 'All Mail', role: 'all' },
      { path: 'Sent', role: 'sent' },
    ]);
  });

  it('skips everything when there is no INBOX and no all-mail folder', () => {
    const folders = [folder('Junk'), folder('Trash')];
    expect(resolveMailboxes(folders)).toEqual([]);
  });

  it('dedupes when special-use All and INBOX resolve to the same path', () => {
    const folders = [folder('INBOX', '\\All')];
    const out = resolveMailboxes(folders);
    expect(out).toEqual([{ path: 'INBOX', role: 'all' }]);
  });

  it('is case-insensitive for name-based Sent detection', () => {
    const folders = [folder('inbox'), folder('SENT')];
    const out = resolveMailboxes(folders);
    expect(out.map((m) => m.path)).toEqual(['inbox', 'SENT']);
  });
});
