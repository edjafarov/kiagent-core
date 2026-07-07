import type { SourceDescriptor } from '@shared/contracts';

/**
 * Per-source presentation (icon + identity-stripe color) for the two source
 * kinds this build actually registers (`src/main/sources/gmail`,
 * `src/main/sources/local-folder`). The legacy renderer had a static
 * connector registry keyed by a closed set of source ids; the new
 * `SourceDescriptor` is open-ended (extensions can contribute more sources
 * later — see contracts.ts §7), so anything not in this curated map falls
 * back to a neutral glyph/stripe rather than guessing.
 */
export interface ConnectorMeta {
  icon: string; // Icon name (see @shared/web-ui/icon-sprite)
  tag: string; // .src-stripe/.tag-* color key
}

const KNOWN: Record<string, ConnectorMeta> = {
  gmail: { icon: 'mail', tag: 'gmail' },
  // Generic envelope — IMAP is any provider, so no single brand mark fits.
  imap: { icon: 'mail', tag: 'default' },
  'local-folder': { icon: 'folder', tag: 'local' },
};

const FALLBACK: ConnectorMeta = { icon: 'database', tag: 'default' };

export function connectorMeta(sourceId: string): ConnectorMeta {
  return KNOWN[sourceId] ?? FALLBACK;
}

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
