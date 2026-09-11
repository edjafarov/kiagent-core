/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';

describe('core DB repository boundary', () => {
  it('keeps maintenance-owned table SQL out of the store module', () => {
    const storeSource = fs.readFileSync(
      path.join(__dirname, '../../core/store/store.ts'),
      'utf8',
    );
    expect(storeSource).not.toMatch(/\.map\(\(t\) => \(\{ sql: `DELETE FROM/);
    expect(storeSource).toMatch(/resetCoreStoreTables\(db, accounts, now\)/);
  });
});
