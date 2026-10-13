/** Streams the records of a line-oriented container (mbox, vCard, ENEX)
 *  from a byte offset, holding at most one capped record plus one chunk.
 *  Offsets are BYTES, so a record's `start` can be handed back as a resume
 *  point. Pure (converter child). */
import fs from 'node:fs';

const CHUNK = 1024 * 1024;
/** A line longer than this is handled in fragments: only its first
 *  fragment is tested as a start/end marker. */
const LINE_FRAGMENT = 64 * 1024;

export interface RawRecord {
  raw: Buffer;
  /** Byte offset of the record's first line. */
  start: number;
  /** Byte offset just past the record (its last line, or the next start). */
  end: number;
  /** Lines past `maxRecordBytes` were dropped. */
  truncated: boolean;
}

export interface RecordRules {
  /** `prevBlank`: the previous line was empty (true at `offset`). */
  isStart(line: Buffer, prevBlank: boolean): boolean;
  /** Inclusive end line; when absent, a record runs to the next start. */
  isEnd?(line: Buffer): boolean;
  maxRecordBytes: number;
}

const isBlank = (line: Buffer): boolean =>
  line.length === 0 ||
  (line.length === 1 && line[0] === 0x0a) ||
  (line.length === 2 && line[0] === 0x0d && line[1] === 0x0a);

export async function* readRecords(
  path: string,
  offset: number,
  rules: RecordRules,
): AsyncGenerator<RawRecord> {
  const fh = await fs.promises.open(path, 'r');
  try {
    let pos = offset; // next byte to read from the file
    let carry = Buffer.alloc(0); // incomplete line
    let carryStart = offset; // absolute offset of carry[0]
    let midLine = false; // carry continues a line already fragmented
    let prevBlank = true;
    let rec: {
      parts: Buffer[];
      size: number;
      start: number;
      truncated: boolean;
    } | null = null;

    const finish = (end: number): RawRecord | null => {
      if (!rec) return null;
      const out = {
        raw: Buffer.concat(rec.parts),
        start: rec.start,
        end,
        truncated: rec.truncated,
      };
      rec = null;
      return out;
    };
    const append = (buf: Buffer) => {
      if (!rec) return;
      if (rec.size + buf.length > rules.maxRecordBytes) {
        rec.truncated = true;
        return;
      }
      rec.parts.push(buf);
      rec.size += buf.length;
    };
    /** One line (or line fragment) at absolute offset `at`. */
    const onLine = function* onLine(
      buf: Buffer,
      at: number,
      head: boolean,
    ): Generator<RawRecord> {
      if (head && rules.isStart(buf, prevBlank)) {
        // A start closes an open record — also in end-marker mode, where it
        // means the previous record lost its end line.
        const done = finish(at);
        if (done) yield done;
        rec = { parts: [], size: 0, start: at, truncated: false };
      }
      append(buf);
      if (head && rec && rules.isEnd?.(buf)) {
        const done = finish(at + buf.length);
        if (done) yield done;
      }
      if (head) prevBlank = isBlank(buf);
    };

    const chunk = Buffer.alloc(CHUNK);
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await fh.read(chunk, 0, CHUNK, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      let data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      let base = carryStart;
      let from = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, from);
        if (nl < 0) break;
        const l = Buffer.from(data.subarray(from, nl + 1));
        yield* onLine(l, base + from, !midLine);
        midLine = false;
        from = nl + 1;
      }
      carry = Buffer.from(data.subarray(from));
      carryStart = base + from;
      if (carry.length > LINE_FRAGMENT) {
        yield* onLine(carry, carryStart, !midLine);
        midLine = true;
        carryStart += carry.length;
        carry = Buffer.alloc(0);
      }
      data = Buffer.alloc(0);
      base = carryStart;
    }
    if (carry.length > 0) yield* onLine(carry, carryStart, !midLine);
    const last = finish(pos);
    if (last) yield last;
  } finally {
    await fh.close();
  }
}
