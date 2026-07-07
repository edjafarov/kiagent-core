import React from 'react';
import { Icon } from '@shared/web-ui/icon-sprite';
import { useAppState } from '@renderer/state/app-state';
import { connectorMeta } from './connector-meta';
import { BUILTIN_SOURCE_ICONS } from './builtin-brand-icons';
// Relative (not @renderer alias) so jest's css→identity-obj-proxy mapping
// applies — the alias rule wins first and hands jest raw CSS.
import '../../components/ExtGlyph.css';

/**
 * Source-id glyph — the ONE way a source renders its icon (add-source
 * tiles, source table rows, error cards). Resolution order: the
 * contributing extension's brand icon (manifest `icon`, delivered on
 * ExtensionSnapshot.iconDataUrl, matched via sourceIds) → a builtin
 * source's bundled brand mark (gmail) → the curated connectorMeta sprite
 * glyph. `style` applies to the sprite fallback only — brand marks render
 * as-is.
 */
export function SourceIcon(props: {
  sourceId: string;
  size: number;
  style?: React.CSSProperties;
}): React.ReactElement {
  const { sourceId, size, style } = props;
  const extensionIcon = useAppState(
    (s) =>
      s.extensions.find((e) => e.sourceIds.includes(sourceId))?.iconDataUrl,
  );
  const iconDataUrl = extensionIcon ?? BUILTIN_SOURCE_ICONS[sourceId];
  if (iconDataUrl) {
    return (
      <img
        className="ext-glyph-img"
        src={iconDataUrl}
        alt=""
        aria-hidden="true"
        style={{ width: size, height: size }}
      />
    );
  }
  return <Icon name={connectorMeta(sourceId).icon} size={size} style={style} />;
}
