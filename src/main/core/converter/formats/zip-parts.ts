/** Bounded reads of named parts from an OOXML/ODF/EPUB zip. Only the parts a
 *  parser asks for are inflated; media never are. Pure (converter child). */
import JSZip from 'jszip';

export const MAX_ZIP_PART_BYTES = 20 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024;

export interface ZipParts {
  has(name: string): boolean;
  text(name: string): Promise<string | null>;
}

/** JSZip keeps the central-directory size on an internal field (and checks
 *  the inflated length against it), so it bounds the part before inflating. */
const declaredSize = (f: JSZip.JSZipObject): number | null => {
  const n = (f as unknown as { _data?: { uncompressedSize?: unknown } })._data
    ?.uncompressedSize;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

export async function openZipParts(bytes: Uint8Array): Promise<ZipParts> {
  const zip = await JSZip.loadAsync(bytes);
  let inflated = 0;
  const charge = (name: string, n: number) => {
    if (n > MAX_ZIP_PART_BYTES) throw new Error(`zip part too large: ${name}`);
    inflated += n;
    if (inflated > MAX_ZIP_TOTAL_BYTES)
      throw new Error('zip inflate budget exceeded');
  };
  return {
    has: (name) => zip.file(name) != null,
    async text(name) {
      const f = zip.file(name);
      if (!f) return null;
      const declared = declaredSize(f);
      if (declared != null) charge(name, declared);
      const s = await f.async('string');
      if (declared == null) charge(name, s.length);
      return s;
    },
  };
}
