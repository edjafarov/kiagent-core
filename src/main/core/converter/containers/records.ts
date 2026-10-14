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

/**
 * Streams `open … close` elements by byte search, independent of line
 * breaks — an ENEX export may hold every note on one line. Bytes between
 * elements are skipped; an element past `maxRecordBytes` keeps its head
 * and is marked truncated (the rest is read and discarded); one left open
 * at EOF is yielded truncated. Same offset contract as `readRecords`.
 */
export async function* readElements(
  path: string,
  offset: number,
  open: string,
  close: string,
  maxRecordBytes: number,
): AsyncGenerator<RawRecord> {
  const O = Buffer.from(open);
  const C = Buffer.from(close);
  const fh = await fs.promises.open(path, 'r');
  try {
    const chunk = Buffer.alloc(CHUNK);
    let pos = offset;
    let buf = Buffer.alloc(0);
    let bufStart = offset; // absolute offset of buf[0]
    let rec: {
      start: number;
      parts: Buffer[];
      size: number;
      truncated: boolean;
    } | null = null;
    const keep = (b: Buffer) => {
      if (!rec || b.length === 0) return;
      const room = maxRecordBytes - rec.size;
      if (b.length > room) rec.truncated = true;
      const take = b.subarray(0, Math.max(0, room));
      if (take.length > 0) {
        rec.parts.push(Buffer.from(take));
        rec.size += take.length;
      }
    };
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await fh.read(chunk, 0, CHUNK, pos);
      const eof = bytesRead === 0;
      if (!eof) {
        buf = Buffer.concat([buf, chunk.subarray(0, bytesRead)]);
        pos += bytesRead;
      }
      let i = 0;
      for (;;) {
        if (!rec) {
          const s = buf.indexOf(O, i);
          if (s < 0) {
            i = Math.max(i, buf.length - (O.length - 1));
            break;
          }
          rec = { start: bufStart + s, parts: [], size: 0, truncated: false };
          i = s;
        }
        const e = buf.indexOf(C, i);
        if (e < 0) {
          const upto = Math.max(i, buf.length - (C.length - 1));
          keep(buf.subarray(i, upto));
          i = upto;
          break;
        }
        keep(buf.subarray(i, e + C.length));
        const done: RawRecord = {
          raw: Buffer.concat(rec.parts),
          start: rec.start,
          end: bufStart + e + C.length,
          truncated: rec.truncated,
        };
        rec = null;
        i = e + C.length;
        yield done;
      }
      buf = Buffer.from(buf.subarray(i));
      bufStart += i;
      if (eof) {
        if (rec) {
          keep(buf);
          yield {
            raw: Buffer.concat(rec.parts),
            start: rec.start,
            end: bufStart + buf.length,
            truncated: true,
          };
        }
        return;
      }
    }
  } finally {
    await fh.close();
  }
}
