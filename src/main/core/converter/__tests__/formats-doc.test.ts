/** @jest-environment node */
import fs from 'fs';
import path from 'path';

import { parse } from '../parsers';

const fixture = (n: string) =>
  new Uint8Array(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'formats', n)),
  );

describe('doc (Word 97)', () => {
  it('extracts the body with umlauts', async () => {
    const md = await parse(
      fixture('sample.doc'),
      'application/msword',
      'r.doc',
    );
    expect(md).toContain('Quarterly report');
    expect(md).toContain('Grüße aus München.');
    expect(md).toContain('Second paragraph.');
  });
  it('a corrupt file throws an Error', async () => {
    await expect(
      parse(
        new TextEncoder().encode('not a word file'),
        'application/msword',
        'r.doc',
      ),
    ).rejects.toBeInstanceOf(Error);
  });
});
