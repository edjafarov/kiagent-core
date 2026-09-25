import { createContext, useContext } from 'react';
import { nextResolved as nextResolvedOf, type Resolved } from './navigation';

/**
 * Routed screens. Deliberately small: Sources owns its own in-screen
 * navigation. Settings is a routed page; its pane is the `pane` param.
 *
 * `ROUTE_META` is the catalog pattern (see the extension-UI design spec,
 * "the product has already generalised routing; core has not"), populated
 * here with CORE'S OWN routes only — the product's own copy carries
 * more. A route added to `ROUTE_META` becomes a `KnownView` everywhere with
 * no second edit: the union and the runtime list cannot disagree,
 * structurally, the same way the product's ROUTE_META comment describes.
 */
export interface RouteMeta {
  title: string;
}

export const ROUTE_META = {
  sources: { title: 'Sources' },
  connection: { title: 'Connection' },
  logs: { title: 'Logs' },
  outbox: { title: 'Outbox' },
  marketplace: { title: 'Marketplace' },
  settings: { title: 'Settings' },
} as const satisfies Record<string, RouteMeta>;

export type KnownView = keyof typeof ROUTE_META;
export const KNOWN_VIEWS = Object.keys(ROUTE_META) as readonly KnownView[];

export function isKnownView(v: string): v is KnownView {
  return Object.prototype.hasOwnProperty.call(ROUTE_META, v);
}

/**
 * B3: an extension-contributed view id, `ext:<extension id>/<contribution
 * id>`. The page itself is loaded at runtime (`contributed-page.tsx`);
 * this module only makes the type exist and gives it one collision-free
 * encoding for every routing site to share.
 *
 * Collision-free by construction:
 * - **Cannot collide with a `KnownView`.** Every `ExtView` starts with the
 *   literal `ext:` prefix and no core route id does (`KNOWN_VIEWS` is a
 *   fixed, spelled-out list), so `isKnownView`/`isExtView` partition the
 *   `string` space rather than merely usually disagreeing.
 * - **Cannot be forged.** `EXTENSION_ID_RE` and `CONTRIBUTION_ID_RE` both
 *   exclude '/' from their charsets, and exactly one literal '/' separates
 *   them in `EXT_VIEW_RE`. So a string that parses at all decomposes into
 *   its two halves in exactly one way: there is no pair of inputs
 *   `(extensionId, contributionId)` and `(extensionId2, contributionId2)`,
 *   both valid under their own charsets, whose composed strings collide —
 *   an attempt to smuggle a second '/'-delimited segment inside either half
 *   is rejected by the charset before the string is ever built, and a
 *   crafted string with an extra '/' simply fails to match `EXT_VIEW_RE`
 *   at all (`parseExtView` returns `null`) rather than parsing two ways.
 */
export type ExtView = `ext:${string}/${string}`;

const EXT_VIEW_PREFIX = 'ext:';

// Keep in lockstep with src/main/platform/manifest.ts's ID_RE (extension
// id) and CONTRIBUTION_ID_RE (contribution id charset) — all three copies
// must accept exactly the same characters, and none may ever accept '/',
// or the collision-freedom proof above breaks.
const EXTENSION_ID_RE = /^[a-z0-9-]+\.[a-z0-9-]+$/;
const CONTRIBUTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const EXT_VIEW_RE = /^ext:([a-z0-9-]+\.[a-z0-9-]+)\/([a-z0-9][a-z0-9-]{0,31})$/;

/** Builds a contributed view id from its two validated halves. Throws on an
 *  id outside either charset — this is the ONE place a view id is composed,
 *  so a malformed id can never reach `EXT_VIEW_RE` from this function. */
export function makeExtView(
  extensionId: string,
  contributionId: string,
): ExtView {
  if (!EXTENSION_ID_RE.test(extensionId)) {
    throw new Error(
      `invalid extension id for a contributed view: ${extensionId}`,
    );
  }
  if (!CONTRIBUTION_ID_RE.test(contributionId)) {
    throw new Error(
      `invalid contribution id for a contributed view: ${contributionId}`,
    );
  }
  return `${EXT_VIEW_PREFIX}${extensionId}/${contributionId}`;
}

/** The one parser every routing site must use instead of `split('/')` —
 *  splitting naively would let a maliciously-shaped id smuggle an extra
 *  separator. Returns `null` for anything that isn't a well-formed
 *  contributed view id, including a `KnownView`. */
export function parseExtView(
  v: string,
): { extensionId: string; contributionId: string } | null {
  const m = EXT_VIEW_RE.exec(v);
  if (!m) return null;
  return { extensionId: m[1], contributionId: m[2] };
}

export function isExtView(v: string): v is ExtView {
  return EXT_VIEW_RE.test(v);
}

export type View = KnownView | ExtView;

export interface ViewParams {
  accountId?: string;
  anchor?: string;
  /** Settings pane id. */
  pane?: string;
}

export interface ViewContextValue {
  view: View;
  params: ViewParams;
  navigate: (to: View, params?: ViewParams) => void;
  back: () => void;
  /** Opens the Settings page, on `pane` or the pane last shown. */
  openSettings: (pane?: string) => void;
  /** Replaces the current view's params without remounting it or adding
   *  a history entry (e.g. switching Settings panes). */
  replaceParams: (params: ViewParams) => void;
}

export const ViewContext = createContext<ViewContextValue>({
  view: 'sources',
  params: {},
  navigate: () => {},
  back: () => {},
  openSettings: () => {},
  replaceParams: () => {},
});

export function useView(): ViewContextValue {
  return useContext(ViewContext);
}

/** A concrete navigation target; see state/navigation.ts. */
export type ResolvedView = Resolved<View, ViewParams>;

/** The navigate transition, typed for this app's routes. */
export function nextResolved(
  prev: ResolvedView | null,
  to: View,
  params?: ViewParams,
): { next: ResolvedView; push: boolean } {
  return nextResolvedOf<View, ViewParams>(prev, to, params);
}

/** The first view to show, from an optional `#view=<id>&params=<json>`
 *  location hash. Production never sets a hash, so this is `null` there;
 *  tools that render the app with fixture data use it to open a view. */
export function resolveInitialView(
  hash: string = typeof window !== 'undefined' ? window.location.hash : '',
): ResolvedView | null {
  if (!hash || hash.length < 2) return null;
  const q = new URLSearchParams(hash.slice(1));
  const view = q.get('view');
  if (!view || !(isKnownView(view) || isExtView(view))) return null;
  let params: ViewParams | undefined;
  const raw = q.get('params');
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        params = parsed as ViewParams;
      }
    } catch {
      params = undefined;
    }
  }
  return { view, params, epoch: 0 };
}
