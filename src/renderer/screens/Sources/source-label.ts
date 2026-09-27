import type { SourceDescriptor } from '@shared/contracts';

/** Display label for a source id — the registered descriptor's `name` when
 *  known, else a title-cased fallback from the raw id so an unrecognized
 *  (e.g. extension-contributed) source still reads as a label, not a slug. */
export function sourceLabel(
  sourceId: string,
  descriptors: readonly SourceDescriptor[] | null,
): string {
  const found = descriptors?.find((d) => d.id === sourceId);
  if (found) return found.name;
  return sourceId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}
