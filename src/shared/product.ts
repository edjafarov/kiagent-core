/**
 * Product identity constants shared by main and renderer.
 *
 * The resolved product name travels main → renderer over `app:info`; this
 * module holds the fallback both sides use when no product.json supplies one,
 * so a renderer that has not yet received `app:info` cannot render a different
 * name than main resolved. It is deliberately free of node builtins — the
 * renderer imports it directly, and `src/main/product.ts` (which reads `fs`)
 * imports the same constant rather than redeclaring it.
 */

/** The OSS core's own identity — what a build with no product.json is called. */
export const DEFAULT_PRODUCT_NAME = 'KIAcore';
