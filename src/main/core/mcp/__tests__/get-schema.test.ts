/** @jest-environment node */
import { renderSchema } from '../tools/get-schema';

describe('renderSchema', () => {
  it('renders markdown covering the queryable tables and the source enum', () => {
    const md = renderSchema();
    expect(md).toContain('## documents');
    expect(md).toContain('## accounts');
    // The join every by-source query needs must be spelled out.
    expect(md).toContain('accounts.source');
    // The source enum values are present.
    expect(md).toMatch(/`gmail`/);
    expect(md).toMatch(/`local-folder`/);
    expect(md).toMatch(/`imap`/);
  });
});
