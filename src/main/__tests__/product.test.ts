/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DEFAULT_PRODUCT, loadProductConfig } from '../product';

describe('loadProductConfig', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'product-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns defaults when no candidate exists', () => {
    expect(loadProductConfig([null, path.join(tmp, 'nope')])).toEqual(
      DEFAULT_PRODUCT,
    );
  });

  it('loads the first existing product.json and merges over defaults', () => {
    fs.writeFileSync(
      path.join(tmp, 'product.json'),
      JSON.stringify({
        productName: 'Acme',
        updateFeedUrl: 'https://u.example/feed',
      }),
    );
    expect(loadProductConfig([tmp])).toEqual({
      productName: 'Acme',
      updateFeedUrl: 'https://u.example/feed',
    });
  });

  it('accepts a direct file path candidate', () => {
    const f = path.join(tmp, 'custom.json');
    fs.writeFileSync(f, JSON.stringify({ productName: 'Custom' }));
    expect(loadProductConfig([f]).productName).toBe('Custom');
  });

  it('falls back to defaults (and logs) on invalid JSON', () => {
    fs.writeFileSync(path.join(tmp, 'product.json'), '{nope');
    const logs: string[] = [];
    expect(loadProductConfig([tmp], (m) => logs.push(m))).toEqual(
      DEFAULT_PRODUCT,
    );
    expect(logs.length).toBe(1);
  });

  it('falls back to defaults (and logs) on schema violation', () => {
    fs.writeFileSync(
      path.join(tmp, 'product.json'),
      JSON.stringify({ productName: '', unknownKey: 1 }),
    );
    const logs: string[] = [];
    expect(loadProductConfig([tmp], (m) => logs.push(m))).toEqual(
      DEFAULT_PRODUCT,
    );
    expect(logs.length).toBe(1);
  });
});
