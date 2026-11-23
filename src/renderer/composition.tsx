// PRODUCT FILE. A product built on this core replaces this whole file with
// its own copy; core's copy is the empty product.
import type { ScreenDefinitions } from '@renderer/screen-registry';
import type { ProductShell } from '@renderer/product-shell';

/** The product's screens, by route id. Merged over core's, so an entry for
 *  a core route replaces that screen. */
export const PRODUCT_SCREENS: ScreenDefinitions = {};

/** The product's own sign-in screen, sidebar, window gate and root hook. */
export const PRODUCT_SHELL: ProductShell = {};
