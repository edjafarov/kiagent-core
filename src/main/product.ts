/**
 * product.json — the product-identity skeleton (spec 2026-07-07 §3.1.4).
 * The OSS build ships none and runs on DEFAULT_PRODUCT; a product build
 * (e.g. the KIAgent harness) drops product.json into resources. Loading
 * never throws: a broken file logs and degrades to defaults.
 */
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DEFAULT_PRODUCT_NAME } from '@shared/product';

const schema = z
  .object({
    productName: z.string().min(1).optional(),
    updateFeedUrl: z.string().url().optional(),
    bundledExtensionsDir: z.string().min(1).optional(),
    macUpdatesEnabled: z.boolean().optional(),
  })
  .strict();

export interface ProductConfig {
  /** User-facing name: About pane, Notification titles. */
  productName: string;
  updateFeedUrl?: string;
  bundledExtensionsDir?: string;
  /**
   * macOS auto-update opt-in. electron-updater cannot update an unsigned
   * macOS build ("Could not get code signature"), so the gate stays CLOSED
   * unless a product build that ships a Developer ID signature opens it.
   * Absent/false → macOS updates disabled ('unsigned-macos'). Other platforms
   * ignore this entirely.
   */
  macUpdatesEnabled?: boolean;
}

export const DEFAULT_PRODUCT: ProductConfig = {
  productName: DEFAULT_PRODUCT_NAME,
};

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
