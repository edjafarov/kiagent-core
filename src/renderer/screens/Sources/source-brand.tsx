import React from 'react';
import { useAppState } from '@renderer/state/app-state';
import { BrandGlyph, sourceBrand, type Brand } from '@shared/web-ui/ui';

/** A source's brand the way every page draws it: the brands table for a
 *  known source, else the contributing extension's own icon, else a neutral
 *  square with initials (`sourceBrand`'s table-first order). */
export function useSourceBrand(sourceId: string, name?: string): Brand {
  const iconDataUrl = useAppState(
    (s) =>
      s.extensions.find((e) => e.sourceIds.includes(sourceId))?.iconDataUrl,
  );
  return sourceBrand(sourceId, {
    ...(name ? { name } : {}),
    ...(iconDataUrl ? { iconDataUrl } : {}),
  });
}

/** The source's brand glyph (for a header, where a hook can't be called
 *  inline). */
export function SourceGlyph(props: {
  sourceId: string;
  size?: 20 | 24 | 32;
}): React.ReactElement {
  return (
    <BrandGlyph brand={useSourceBrand(props.sourceId)} size={props.size} />
  );
}
