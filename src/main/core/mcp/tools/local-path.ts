import type { Document } from '@shared/contracts';

/** Where a shared-folder document lives on THIS Mac (null when it is not there). */
export type LocalPathOf = (doc: { accountId: string; externalId: string }) => Promise<string | null>;

/** A document's link: its own `url`, or, for a shared-folder document (which
 *  carries no absolute path because that differs per Mac), the `file://` link
 *  of the file on this Mac. Null when neither exists. */
export async function sourceUrlOf(
  d: Pick<Document, 'url' | 'accountId' | 'externalId'>,
  source: string | undefined,
  localPathOf?: LocalPathOf,
): Promise<string | null> {
  if (d.url) return d.url;
  if (source !== 'shared-folder' || !localPathOf) return null;
  try {
    const abs = await localPathOf({ accountId: d.accountId, externalId: d.externalId });
    return abs ? `file://${encodeURI(abs)}` : null;
  } catch {
    return null;
  }
}
