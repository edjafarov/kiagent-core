import type { DocumentInput } from '@shared/contracts';

import type { SharedRoot } from '../../core/shared-folders/paths';
import type { LocalFileItem } from '../local-folder/to-document';
import { toDocument as localToDocument } from '../local-folder/to-document';

/** What `pull()` builds per shared file: the parsed file (read from this
 *  Mac's own copy) and the identity the manifest gives it. */
export interface SharedFileItem {
  file: LocalFileItem;
  root: SharedRoot;
  relPath: string;
  /** The hash of the bytes `file` was parsed from. */
  sha256: string;
}

/** A shared file's document id is the same on every Mac: root and path inside it. */
export const sharedExternalId = (root: string, relPath: string): string => `${root}/${relPath}`;

/** `local-folder`'s mapping for everything but identity: no absolute path and
 *  no `file://` link (both differ per Mac), the manifest's root and path in
 *  their place, and the hash of the parsed bytes. */
export function toDocument(item: SharedFileItem): DocumentInput {
  const doc = localToDocument(item.file) as DocumentInput;
  const { url: _url, scopeRootId: _scope, metadata, ...rest } = doc;
  const { absPath: _abs, ...kept } = (metadata ?? {}) as Record<string, unknown>;
  return {
    ...rest,
    externalId: sharedExternalId(item.root, item.relPath),
    metadata: { ...kept, root: item.root, relPath: item.relPath, sha256: item.sha256 },
  };
}
