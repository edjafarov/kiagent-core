// What an installed extension can do, in one plain line:
// "v1.0.0 · brings in Google Calendar · adds a page · uses the internet".
import type { ExtensionSnapshot } from '@shared/contracts';
import { sourceBrand } from '@shared/web-ui/ui';

export function accessLine(
  e: Pick<ExtensionSnapshot, 'version' | 'caps' | 'sourceIds' | 'ui'>,
): string {
  const names = e.sourceIds.map((id) => sourceBrand(id).name);
  return [
    `v${e.version}`,
    names.length > 0 ? `brings in ${names.join(' and ')}` : null,
    (e.ui ?? []).length > 0 ? 'adds a page' : null,
    e.caps.includes('files') ? 'reads files you choose' : null,
    e.caps.includes('send') ? 'sends messages you confirm' : null,
    e.caps.includes('inference') ? 'uses local AI' : null,
    e.caps.includes('net') ? 'uses the internet' : null,
  ]
    .filter((p): p is string => p !== null)
    .join(' · ');
}
