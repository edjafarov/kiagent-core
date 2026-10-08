/** @jest-environment node */
import Database from 'better-sqlite3';

import {
  MAX_RESULT_BYTES,
  MAX_ROWS,
  MAX_VALUE_BYTES,
  runQuerySql,
  runQuerySqlBounded,
} from '../tools/query-sql';

const MARK = '…[truncated]';
const series = (n: number, cols: string) =>
  `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < ${n}) SELECT ${cols} FROM c`;

describe('runQuerySql bounds', () => {
  let conn: Database.Database;
  beforeEach(() => {
    conn = new Database(':memory:');
  });
  afterEach(() => conn.close());

  it('stops at 500 rows', () => {
    const r = runQuerySql(conn, series(600, 'i'));
    expect(r.rows).toHaveLength(MAX_ROWS);
    expect(r.truncated).toBe(true);
  });

  it('cuts every string value at 64 KiB with a marker and says so', () => {
    const r = runQuerySql(conn, `SELECT hex(randomblob(40000)) AS big`);
    const big = r.rows[0].big as string;
    expect(big.endsWith(MARK)).toBe(true);
    expect(big.length).toBe(65536 + MARK.length); // ASCII: bytes == chars
    expect(r.truncated).toBe(true);
    expect(r.hint).toMatch(/64 KiB/);
  });

  it('cuts non-ASCII values by UTF-8 BYTES, never inside a code point', () => {
    // 'ü' = 2 bytes, '日本' = 3 bytes each, '😀' = 4 bytes (surrogate pair).
    for (const unit of ['ü', '日本', '😀', 'aü日😀']) {
      const text = unit.repeat(Math.ceil(80_000 / Buffer.byteLength(unit)));
      const r = runQuerySql(conn, `SELECT '${text}' AS v`);
      const v = r.rows[0].v as string;
      expect(v.endsWith(MARK)).toBe(true);
      const body = v.slice(0, -MARK.length);
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_VALUE_BYTES);
      expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_VALUE_BYTES - 4);
      expect(body).not.toMatch(/�/); // no split code point
      expect(text.startsWith(body)).toBe(true);
      expect(r.truncated).toBe(true);
    }
  });

  it('does not cut a value of exactly 64 KiB (boundary), cuts one byte more', () => {
    const exact = runQuerySql(
      conn,
      `SELECT '${'a'.repeat(MAX_VALUE_BYTES)}' AS v`,
    );
    expect(exact.rows[0].v).toBe('a'.repeat(MAX_VALUE_BYTES));
    expect(exact.truncated).toBe(false);
    // 2-byte chars landing exactly on the limit are kept whole...
    const twoByte = 'ü'.repeat(MAX_VALUE_BYTES / 2);
    const keep = runQuerySql(conn, `SELECT '${twoByte}' AS v`);
    expect(keep.rows[0].v).toBe(twoByte);
    expect(keep.truncated).toBe(false);
    // ...one more byte cuts.
    const over = runQuerySql(
      conn,
      `SELECT '${'a'.repeat(MAX_VALUE_BYTES + 1)}' AS v`,
    );
    expect((over.rows[0].v as string).endsWith(MARK)).toBe(true);
    expect(over.truncated).toBe(true);
  });

  it('stops at 1 MiB of serialized row data (array brackets and commas included), whichever limit comes first', () => {
    const r = runQuerySql(
      conn,
      series(600, 'i, hex(randomblob(100000)) AS big'),
    );
    expect(r.truncated).toBe(true);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThan(MAX_ROWS);
    // The FULL serialized array, exactly as it is transferred.
    expect(Buffer.byteLength(JSON.stringify(r.rows))).toBeLessThanOrEqual(
      MAX_RESULT_BYTES,
    );
    expect(r.hint).toMatch(/1 MiB/);
  });

  it('accounts for the array overhead: many tiny rows still serialize within 1 MiB', () => {
    // Each row serializes to ~14 bytes + a comma; 500 rows is far below 1 MiB,
    // so make the budget bind with wide-but-legal rows (60 KiB each).
    const r = runQuerySqlBounded(
      conn,
      series(30, `i, hex(randomblob(30000)) AS big`),
    );
    expect(
      Buffer.byteLength(JSON.stringify(r.result.rows)),
    ).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    // `bytes` is the serialized size of the rows array as transferred.
    expect(r.bytes).toBe(Buffer.byteLength(JSON.stringify(r.result.rows)));
    expect(r.result.truncated).toBe(true);
  });

  it('a 500-row cut sets truncated and a hint', () => {
    const r = runQuerySql(conn, series(600, 'i'));
    expect(r.rows).toHaveLength(MAX_ROWS);
    expect(r.truncated).toBe(true);
    expect(r.hint).toMatch(/500 rows/);
  });

  it('returns no rows and says why when ONE row alone exceeds 1 MiB', () => {
    const cols = Array.from(
      { length: 20 },
      (_, i) => `hex(randomblob(40000)) AS c${i}`,
    ).join(', ');
    const r = runQuerySql(conn, `SELECT ${cols}`);
    expect(r.rows).toEqual([]);
    expect(r.truncated).toBe(true);
    expect(r.hint).toMatch(/single row exceeds 1 MiB/);
  });

  it('replaces blobs with a placeholder instead of serializing them', () => {
    const r = runQuerySql(conn, `SELECT randomblob(10) AS b`);
    expect(r.rows).toEqual([{ b: '<blob 10 bytes>' }]);
  });

  it('still gates non-SELECT statements', () => {
    expect(() => runQuerySql(conn, 'DELETE FROM x')).toThrow(/only SELECT/);
  });
});
