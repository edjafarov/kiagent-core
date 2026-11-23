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

/** IPC channels the product's extensions answer themselves, with their
 *  request and response types. The window may call them; core registers no
 *  handler for them (the extension does, when it activates). */
export type ProductInvokes = Record<never, never>;

/** Every `ProductInvokes` channel, as data (the values carry nothing). */
export const PRODUCT_INVOKE_CHANNELS = {} as const satisfies Record<
  keyof ProductInvokes,
  0
>;

/** Push channels the product's extensions send to the window. */
export type ProductPushes = Record<never, never>;

/** Every `ProductPushes` channel, as data. */
export const PRODUCT_PUSH_CHANNELS = {} as const satisfies Record<
  keyof ProductPushes,
  0
>;
