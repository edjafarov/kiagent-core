/**
 * Statement policy for the extension `db` capability.
 *
 * `db` is documented — and consented to — as an extension's *own* private
 * database: `private.db` under its own `dataDir`. SQLite does not respect that
 * framing on its own, and the surface passed SQL through unfiltered, so
 * `ATTACH DATABASE '/any/path' AS x` opened (creating it if absent) any file on
 * disk through the same handle, and `VACUUM INTO '/any/path'` wrote one. The
 * corpus is a file on disk like any other. In practice "your own database"
 * meant the whole filesystem plus the corpus.
 *
 * Policy: default-deny by leading keyword. Ordinary DML, DDL and transaction
 * control are allowed; anything that can name a second database file is not.
 * `PRAGMA` is refused except for a small set that only reads or writes the
 * private database's own header and schema — `user_version` in particular,
 * because the standard migration idiom needs it. `VACUUM` is allowed only in
 * its bare form, never `VACUUM INTO`.
 *
 * Loading native extensions is separately blocked by better-sqlite3 (`not
 * authorized`), so the blast radius never included code execution — but every
 * row of the corpus is plaintext, which is the part that mattered.
 */

export class SqlPolicyError extends Error {}

/** Leading keywords an extension may run against its own database. `END` is
 *  here as COMMIT's alias, which also lets `CREATE TRIGGER … BEGIN … END`
 *  bodies through the per-statement split below. */
const ALLOWED_KEYWORDS = new Set([
  'SELECT',
  'VALUES',
  'WITH',
  'INSERT',
  'REPLACE',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'ANALYZE',
  'REINDEX',
]);

/** Pragmas that cannot name a file or reach outside `private.db`. */
const ALLOWED_PRAGMAS = new Set([
  'application_id',
  'foreign_key_list',
  'foreign_keys',
  'freelist_count',
  'index_info',
  'index_list',
  'integrity_check',
  'page_count',
  'quick_check',
  'table_info',
  'table_list',
  'table_xinfo',
  'user_version',
]);

/** `VACUUM` or `VACUUM main` — but never `VACUUM INTO 'file'`. */
const BARE_VACUUM = /^VACUUM(\s+[A-Za-z_][A-Za-z_0-9]*)?$/i;

const PRAGMA_NAME =
  /^PRAGMA\s+(?:[A-Za-z_][A-Za-z_0-9]*\s*\.\s*)?([A-Za-z_][A-Za-z_0-9]*)/i;

/**
 * Splits `sql` on top-level `;`, correctly skipping semicolons that sit inside
 * string literals, quoted identifiers or comments — the whole point is that a
 * denied statement cannot hide behind `'…;…'` and be missed.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  const n = sql.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i += 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < n) {
        if (sql[i] === c) {
          // A doubled quote is an escaped quote, not the end of the literal.
          if (sql[i + 1] === c) i += 2;
          else break;
        } else i += 1;
      }
      i += 1;
    } else if (c === '[') {
      i += 1;
      while (i < n && sql[i] !== ']') i += 1;
      i += 1;
    } else if (c === ';') {
      out.push(sql.slice(start, i));
      i += 1;
      start = i;
    } else {
      i += 1;
    }
  }
  out.push(sql.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Strips leading whitespace and comments so the first real token is visible. */
function stripLeading(stmt: string): string {
  let i = 0;
  const n = stmt.length;
  for (;;) {
    while (i < n && /\s/.test(stmt[i])) i += 1;
    if (stmt[i] === '-' && stmt[i + 1] === '-') {
      i += 2;
      while (i < n && stmt[i] !== '\n') i += 1;
    } else if (stmt[i] === '/' && stmt[i + 1] === '*') {
      i += 2;
      while (i < n && !(stmt[i] === '*' && stmt[i + 1] === '/')) i += 1;
      i += 2;
    } else break;
  }
  return stmt.slice(i);
}

function refuse(keyword: string): never {
  throw new SqlPolicyError(
    `db: "${keyword}" is not allowed. The db capability is your extension's own private database, not a filesystem or corpus handle — statements that can name another database file (ATTACH, DETACH, VACUUM INTO) are refused.`,
  );
}

/**
 * Throws unless every statement in `sql` is permitted. Applied to both `exec`
 * and `query`, since either can carry an `ATTACH`.
 */
export function assertAllowedSql(sql: string): void {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) return;
  for (const raw of statements) {
    let stmt = stripLeading(raw);
    // EXPLAIN prefixes another statement; judge what it wraps, not the prefix.
    for (;;) {
      const explain = /^EXPLAIN\b(\s+QUERY\s+PLAN\b)?/i.exec(stmt);
      if (!explain) break;
      stmt = stripLeading(stmt.slice(explain[0].length));
    }
    const keyword = (
      /^[A-Za-z_][A-Za-z_0-9]*/.exec(stmt)?.[0] ?? ''
    ).toUpperCase();
    if (keyword === '')
      refuse(stripLeading(raw).slice(0, 20) || raw.slice(0, 20));
    if (keyword === 'PRAGMA') {
      const name = PRAGMA_NAME.exec(stmt)?.[1]?.toLowerCase();
      if (!name || !ALLOWED_PRAGMAS.has(name)) {
        throw new SqlPolicyError(
          `db: PRAGMA ${name ?? ''} is not allowed. Only pragmas scoped to your own database are permitted: ${[...ALLOWED_PRAGMAS].join(', ')}.`,
        );
      }
    } else if (keyword === 'VACUUM') {
      if (!BARE_VACUUM.test(stmt.trim())) refuse('VACUUM INTO');
    } else if (!ALLOWED_KEYWORDS.has(keyword)) {
      refuse(keyword);
    }
  }
}
