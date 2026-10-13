/** Bounded reads of named parts from an OOXML/ODF/EPUB zip. Only the parts a
 *  parser asks for are inflated; media never are. Inflation is streamed and
 *  counted, so a forged size in the zip directory cannot smuggle a bomb past
 *  the caps. Pure (converter child). */
import JSZip from 'jszip';

export const MAX_ZIP_PART_BYTES = 20 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024;
/** Spreadsheets go to SheetJS, which inflates every member itself: a
 *  bomb guard only, sized above real workbooks' XML. */
export const MAX_SPREADSHEET_INFLATE_BYTES = 200 * 1024 * 1024;

export interface ZipParts {
  has(name: string): boolean;
  text(name: string): Promise<string | null>;
}

/** JSZip's documented streaming API, missing from its typings. */
interface ZipStream {
  on(ev: 'data', cb: (chunk: Uint8Array) => void): ZipStream;
  on(ev: 'error', cb: (e: Error) => void): ZipStream;
  on(ev: 'end', cb: () => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
}

/** Inflate one entry, calling `charge(n)` per chunk (it throws to abort). */
function inflate(
  f: JSZip.JSZipObject,
  charge: (n: number) => void,
  keep: boolean,
): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const stream = (
      f as unknown as { internalStream(t: 'uint8array'): ZipStream }
    ).internalStream('uint8array');
    stream
      .on('data', (chunk: Uint8Array) => {
        try {
          charge(chunk.length);
        } catch (e) {
          stream.pause();
          reject(e);
          return;
        }
        if (keep) chunks.push(chunk);
      })
      .on('error', reject)
      .on('end', () => resolve(chunks))
      .resume();
  });
}

const decode = (chunks: Uint8Array[]): string =>
  new TextDecoder().decode(Buffer.concat(chunks));

export async function openZipParts(bytes: Uint8Array): Promise<ZipParts> {
  const zip = await JSZip.loadAsync(bytes);
  let inflated = 0;
  return {
    has: (name) => zip.file(name) != null,
    async text(name) {
      const f = zip.file(name);
      if (!f) return null;
      let part = 0;
      const chunks = await inflate(
        f,
        (n) => {
          part += n;
          inflated += n;
          if (part > MAX_ZIP_PART_BYTES)
            throw new Error(`zip part too large: ${name}`);
          if (inflated > MAX_ZIP_TOTAL_BYTES)
            throw new Error('zip inflate budget exceeded');
        },
        true,
      );
      return decode(chunks);
    },
  };
}

/** Throws unless every member of the zip inflates to at most `max` bytes in
 *  total. Run before handing a zip to a library that inflates it whole. */
export async function assertZipInflatesWithin(
  bytes: Uint8Array,
  max: number,
): Promise<void> {
  const zip = await JSZip.loadAsync(bytes);
  let total = 0;
  for (const f of Object.values(zip.files)) {
    if (f.dir) continue;
    // eslint-disable-next-line no-await-in-loop -- sequential: one running total
    await inflate(
      f,
      (n) => {
        total += n;
        if (total > max) throw new Error('zip inflate budget exceeded');
      },
      false,
    );
  }
}
