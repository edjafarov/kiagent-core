// PRODUCT FILE. A product built on this core replaces this whole file with
// its own copy; core's copy is the empty product. Data only: main, the
// database worker and the renderer all import it.

/** The product's own routed screens, added to core's five. */
export const PRODUCT_ROUTES = {} as const satisfies Record<
  string,
  { title: string }
>;

/** Navigation params the product's screens read, on top of core's. */
export type ProductViewParams = Record<never, never>;

/** The view a fresh window opens on; `null` keeps core's (`sources`). */
export const PRODUCT_INITIAL_VIEW: string | null = null;

/** Where an attention item may navigate. Core admits nothing by default. */
export const ATTENTION_ACTION_POLICY: {
  readonly views: readonly string[];
  readonly paramKeys: readonly string[];
} = { views: [], paramKeys: [] };

/** What the product decides about the Sources pages: source ids it manages
 *  elsewhere, and whether the list shows the get-started checklist. */
export const SOURCES_POLICY: {
  readonly hidden: readonly string[];
  readonly showGetStarted: boolean;
} = { hidden: [], showGetStarted: true };
