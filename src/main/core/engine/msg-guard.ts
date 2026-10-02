/**
 * Bounds @kenjiuno/msgreader's walk over a .msg's own structure. A .msg is a
 * Compound File (CFB): sector chains (FAT, mini FAT) and a red-black
 * directory tree, all pointers read from the file. msgreader follows them
 * without cycle checks, so ONE corrupt pointer (a FAT entry naming itself, a
 * directory sibling naming itself) loops synchronously until the main
 * process runs out of heap — a crash no try/catch can stop, repeated on
 * every rescan of the file. These guards turn each such loop into a throw,
 * which the converter records as `failed`.
 *
 * Installed per instance (own properties shadowing the prototype), on the
 * reader msgreader itself constructs: a subpath require of its `lib/Reader`
 * could be bundled as a second copy (webpack externals list package names
 * only), and per-instance state needs no global patch.
 */

/** The private Reader methods guarded below (msgreader 1.28.0, pinned). */
interface CfbReader {
  ds: { byteLength: number };
  getNextBlockInner(offset: number, table: number[]): number;
  readProperty(p: { sizeBlock: number }): Uint8Array;
  createPropertyHierarchy(props: unknown[], node: unknown): void;
}

const GUARDED = Symbol('kia.msg.guarded');

export function guardCfbReader(reader: unknown): void {
  const r = reader as CfbReader;
  const fileBytes = r.ds.byteLength;

  // Every chain walk (directory, root/mini stream, mini FAT, each property's
  // stream) steps through getNextBlockInner. A well-formed file visits each
  // sector a small, bounded number of times: 64-byte mini sectors are the
  // finest unit, so 8× that count is a generous ceiling.
  const nextInner = r.getNextBlockInner;
  const budget = 8 * Math.ceil(fileBytes / 64) + 4096;
  let steps = 0;
  r.getNextBlockInner = function guardedNext(offset, table) {
    steps += 1;
    if (steps > budget) throw new Error('msg: sector chain does not terminate');
    return nextInner.call(this, offset, table);
  };

  // A stream cannot be larger than the file holding it; a corrupt size would
  // otherwise allocate up to 4 GiB before reading a byte.
  const { readProperty } = r;
  r.readProperty = function guardedRead(p) {
    if (p.sizeBlock > fileBytes)
      throw new Error('msg: stream larger than the file');
    return readProperty.call(this, p);
  };

  // The directory walk indexes `props` by sibling/child ids from the file; a
  // cycle revisits entries forever. A tree visits each entry at most twice
  // (walk + push), so cap the total lookups across the whole (recursive) walk.
  const hierarchy = r.createPropertyHierarchy;
  r.createPropertyHierarchy = function guardedHierarchy(props, node) {
    if ((props as { [GUARDED]?: true })[GUARDED])
      return hierarchy.call(this, props, node);
    const limit = 4 * props.length + 16;
    let lookups = 0;
    const counted = new Proxy(props, {
      get(target, key, receiver) {
        if (key === GUARDED) return true;
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          lookups += 1;
          if (lookups > limit)
            throw new Error('msg: directory tree has a cycle');
        }
        return Reflect.get(target, key, receiver);
      },
    });
    return hierarchy.call(this, counted, node);
  };
}
