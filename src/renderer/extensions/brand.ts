// An extension's brand: a store repo stands for its brand-table entry
// (`slack-kia-connector` → Slack), so its colour holds across install;
// anything else falls back to its icon or letter.
import { sourceBrand, type Brand } from '@shared/web-ui/ui';
import { parseGithubRef, storeBrandId } from './match';

export function extensionBrand(e: {
  id: string;
  name: string;
  ref?: string;
  iconDataUrl?: string;
}): Brand {
  const gh = parseGithubRef(e.ref);
  return sourceBrand(gh ? storeBrandId(gh.repo) : e.id, {
    name: e.name,
    iconDataUrl: e.iconDataUrl,
  });
}
