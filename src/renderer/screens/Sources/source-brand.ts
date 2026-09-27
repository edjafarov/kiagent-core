import type { ExtensionSnapshot } from '@shared/contracts';
import { sourceBrand, type Brand } from '@shared/web-ui/ui';

/** A source's brand the way every page draws it: the brands table for a
 *  known source, else the contributing extension's own icon, else a
 *  neutral square with the name's initials (`sourceBrand`'s order). */
export function sourceBrandOf(
  sourceId: string,
  name: string,
  extensions: readonly Pick<ExtensionSnapshot, 'sourceIds' | 'iconDataUrl'>[],
): Brand {
  const owner = extensions.find((e) => e.sourceIds.includes(sourceId));
  return sourceBrand(sourceId, { name, iconDataUrl: owner?.iconDataUrl });
}
