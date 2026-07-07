/**
 * product.json — the product-identity skeleton (spec 2026-07-07 §3.1.4).
 * The OSS build ships none and runs on DEFAULT_PRODUCT; a product build
 * (e.g. the KIAgent harness) drops product.json into resources. Loading
 * never throws: a broken file logs and degrades to defaults.
 */
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

const schema = z
  .object({
    productName: z.string().min(1).optional(),
    updateFeedUrl: z.string().url().optional(),
    bundledExtensionsDir: z.string().min(1).optional(),
  })
  .strict();

export interface ProductConfig {
  productName: string;
  updateFeedUrl?: string;
  bundledExtensionsDir?: string;
}

export const DEFAULT_PRODUCT: ProductConfig = { productName: 'KIAgent' };

export function loadProductConfig(
  candidates: Array<string | null | undefined>,
  log?: (msg: string) => void,
): ProductConfig {
  for (const c of candidates) {
    if (!c) continue;
    const file = c.endsWith('.json') ? c : path.join(c, 'product.json');
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      return { ...DEFAULT_PRODUCT, ...parsed };
    } catch (e) {
      log?.(
        `invalid product config at ${file}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { ...DEFAULT_PRODUCT };
    }
  }
  return { ...DEFAULT_PRODUCT };
}
