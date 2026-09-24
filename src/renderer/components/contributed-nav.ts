import type { ExtensionSnapshot } from '@shared/contracts';
import { makeExtView, type View } from '@renderer/state/view';

/** One sidebar row for an extension's contributed page. */
export interface ContributedNavRow {
  label: string;
  view: View;
  icon: string;
  group: 'Memory' | 'System';
  order: number;
}

/** Rows for every page of every enabled extension. The manifest's nav is a
 *  suggestion: an unknown icon falls back to 'puzzle', an unknown group to
 *  'Memory'. Sorted by order, then title. */
export function contributedNavRows(
  extensions: readonly ExtensionSnapshot[],
  knownIcons: ReadonlySet<string>,
): ContributedNavRow[] {
  return extensions
    .filter((e) => e.enabled)
    .flatMap((e) =>
      (e.ui ?? []).map((c) => ({
        label: c.title,
        view: makeExtView(e.id, c.id),
        icon: c.nav?.icon && knownIcons.has(c.nav.icon) ? c.nav.icon : 'puzzle',
        group:
          c.nav?.group === 'System' ? ('System' as const) : ('Memory' as const),
        order: c.nav?.order ?? 0,
      })),
    )
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}
