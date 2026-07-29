/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DEFAULT_PRODUCT_NAME } from '@shared/product';

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

  it('defaults to the OSS core identity with macOS updates closed', () => {
    // The absent-config shape IS core's standalone behaviour: it brands itself
    // KIAcore and never auto-updates on macOS (no Developer ID signature).
    expect(DEFAULT_PRODUCT).toEqual({ productName: DEFAULT_PRODUCT_NAME });
    expect(DEFAULT_PRODUCT.macUpdatesEnabled).toBeUndefined();
  });

  it('leaves the new fields absent for a config that omits them', () => {
    // An older product.json (name + feed only) must resolve byte-for-byte as
    // it did before macUpdatesEnabled existed.
    fs.writeFileSync(
      path.join(tmp, 'product.json'),
      JSON.stringify({
        productName: 'Acme',
        updateFeedUrl: 'https://u.example/feed',
      }),
    );
    const cfg = loadProductConfig([tmp]);
    expect(cfg.macUpdatesEnabled).toBeUndefined();
    expect(Object.keys(cfg).sort()).toEqual(['productName', 'updateFeedUrl']);
  });

  it('carries macUpdatesEnabled through when a product opts in', () => {
    fs.writeFileSync(
      path.join(tmp, 'product.json'),
      JSON.stringify({ productName: 'Acme', macUpdatesEnabled: true }),
    );
    expect(loadProductConfig([tmp])).toEqual({
      productName: 'Acme',
      macUpdatesEnabled: true,
    });
  });

  it('carries an explicit macUpdatesEnabled: false', () => {
    fs.writeFileSync(
      path.join(tmp, 'product.json'),
      JSON.stringify({ productName: 'Acme', macUpdatesEnabled: false }),
    );
    expect(loadProductConfig([tmp]).macUpdatesEnabled).toBe(false);
  });

  it('rejects a non-boolean macUpdatesEnabled and degrades to defaults', () => {
    fs.writeFileSync(
      path.join(tmp, 'product.json'),
      JSON.stringify({ macUpdatesEnabled: 'yes' }),
    );
    const logs: string[] = [];
    expect(loadProductConfig([tmp], (m) => logs.push(m))).toEqual(
      DEFAULT_PRODUCT,
    );
    expect(logs.length).toBe(1);
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
