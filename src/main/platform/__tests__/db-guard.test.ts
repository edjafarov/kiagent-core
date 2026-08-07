/** @jest-environment node */
import {
  assertAllowedSql,
  splitSqlStatements,
  SqlPolicyError,
} from '../db-guard';

const allows = (sql: string) =>
  expect(() => assertAllowedSql(sql)).not.toThrow();
const refuses = (sql: string, match?: RegExp) =>
  expect(() => assertAllowedSql(sql)).toThrow(match ?? SqlPolicyError);

describe('splitSqlStatements', () => {
  it('splits on top-level semicolons only', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2 ;;')).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
  });

  it('ignores semicolons inside literals, quoted identifiers and comments', () => {
    expect(
      splitSqlStatements(`SELECT ';', "a;b", \`c;d\`, [e;f]`),
    ).toHaveLength(1);
    expect(splitSqlStatements("SELECT 'it''s; fine'")).toHaveLength(1);
    expect(splitSqlStatements('SELECT 1 -- ; not a split\n; SELECT 2')).toEqual(
      ['SELECT 1 -- ; not a split', 'SELECT 2'],
    );
    expect(splitSqlStatements('SELECT /* ; */ 1')).toHaveLength(1);
  });
});

describe('assertAllowedSql', () => {
  it('allows ordinary DML and DDL against the private database', () => {
    allows('CREATE TABLE t (a TEXT)');
    allows('INSERT INTO t VALUES (?)');
    allows('SELECT a FROM t WHERE a = ?');
    allows('UPDATE t SET a = 1');
    allows('DELETE FROM t');
    allows('DROP TABLE t');
    allows('ALTER TABLE t ADD COLUMN b TEXT');
    allows('CREATE INDEX i ON t (a)');
    allows('WITH x AS (SELECT 1) SELECT * FROM x');
    allows('BEGIN; INSERT INTO t VALUES (1); COMMIT;');
    allows('  \n  -- leading comment\n  SELECT 1');
    allows('/* block */ SELECT 1');
  });

  it('refuses ATTACH — the escape this policy exists for', () => {
    refuses("ATTACH DATABASE '/tmp/pwned.db' AS x", /ATTACH/);
    refuses("attach database '/tmp/pwned.db' as x", /ATTACH/);
    refuses("  \n\tATTACH '/tmp/x.db' AS y");
    refuses("-- innocent\nATTACH '/tmp/x.db' AS y");
    refuses("/* innocent */ ATTACH '/tmp/x.db' AS y");
    refuses('DETACH DATABASE x', /DETACH/);
  });

  it('refuses an ATTACH hidden behind an allowed leading statement', () => {
    refuses("SELECT 1; ATTACH DATABASE '/tmp/pwned.db' AS x", /ATTACH/);
    refuses("CREATE TABLE t (a); ATTACH '/tmp/x.db' AS y; SELECT 1");
  });

  it('refuses an ATTACH that tries to hide behind a semicolon in a literal', () => {
    refuses("SELECT ';'; ATTACH '/tmp/x.db' AS y", /ATTACH/);
  });

  it('refuses VACUUM INTO but allows a bare VACUUM', () => {
    refuses("VACUUM INTO '/tmp/corpus-copy.db'", /VACUUM INTO/);
    refuses("VACUUM main INTO '/tmp/x.db'");
    allows('VACUUM');
    allows('VACUUM main');
  });

  it('refuses EXPLAIN used as a wrapper around a denied statement', () => {
    refuses("EXPLAIN ATTACH '/tmp/x.db' AS y", /ATTACH/);
    refuses("EXPLAIN QUERY PLAN ATTACH '/tmp/x.db' AS y", /ATTACH/);
    allows('EXPLAIN SELECT 1');
    allows('EXPLAIN QUERY PLAN SELECT 1');
  });

  it('allows only self-scoped pragmas', () => {
    allows('PRAGMA user_version');
    allows('PRAGMA user_version = 3');
    allows('PRAGMA main.user_version = 3');
    allows('PRAGMA table_info(t)');
    allows('PRAGMA integrity_check');
    refuses("PRAGMA temp_store_directory = '/tmp'", /PRAGMA/);
    refuses("PRAGMA data_store_directory = '/tmp'");
    refuses('PRAGMA journal_mode = WAL');
    refuses('PRAGMA database_list');
  });

  it('refuses unknown or malformed leading tokens rather than passing them through', () => {
    refuses('ATTACHX 1');
    refuses('!!!');
  });

  it('allows a CREATE TRIGGER whose body the semicolon split breaks apart', () => {
    allows(
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES (1); END',
    );
  });

  it('accepts empty and whitespace-only input as a no-op', () => {
    allows('');
    allows('   \n  ');
    allows(';;');
  });
});
