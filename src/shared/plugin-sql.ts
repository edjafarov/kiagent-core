const LOGICAL_RE = /^[a-z][a-z0-9_]*$/;

export function pluginIdentifier(id: string, name: string): string {
  if (!LOGICAL_RE.test(name)) throw new Error(`invalid logical identifier: ${name}`);
  const prefix = `p_${Buffer.from(id, 'utf8').toString('hex')}__${name}`;
  return `"${prefix}"`;
}

/** Replace only explicit markers in SQL code. SQL quoted strings and comments
 * are opaque, so user values such as '{{name}}' survive unchanged. */
export function formatPluginSql(
  id: string,
  sql: string,
  objects: readonly string[],
): string {
  const known = new Set(objects);
  for (const object of known) {
    if (!LOGICAL_RE.test(object)) throw new Error(`invalid logical identifier: ${object}`);
  }
  let out = '';
  let i = 0;
  let state: 'code' | 'single' | 'double' | 'backtick' | 'bracket' | 'line' | 'block' = 'code';
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (state === 'code') {
      if (c === "'") { state = 'single'; out += c; i++; continue; }
      if (c === '"') { state = 'double'; out += c; i++; continue; }
      if (c === '`') { state = 'backtick'; out += c; i++; continue; }
      if (c === '[') { state = 'bracket'; out += c; i++; continue; }
      if (c === '-' && n === '-') { state = 'line'; out += '--'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '/*'; i += 2; continue; }
      if (c === '{' || c === '}') {
        if (c !== '{' || n !== '{') throw new Error('malformed SQL marker');
        const end = sql.indexOf('}}', i + 2);
        if (end < 0) throw new Error('malformed SQL marker');
        const name = sql.slice(i + 2, end);
        if (!LOGICAL_RE.test(name) || !known.has(name)) throw new Error(`unknown SQL marker: ${name}`);
        out += pluginIdentifier(id, name);
        i = end + 2;
        continue;
      }
      out += c; i++; continue;
    }
    out += c;
    if (state === 'line') { if (c === '\n') state = 'code'; i++; continue; }
    if (state === 'block') { if (c === '*' && n === '/') { out += '/'; i += 2; state = 'code'; } else i++; continue; }
    const terminator = state === 'single' ? "'" : state === 'double' ? '"' : state === 'backtick' ? '`' : ']';
    if (c === terminator) {
      if ((state === 'single' || state === 'double' || state === 'backtick') && n === c) { out += n; i += 2; continue; }
      state = 'code';
    }
    i++;
  }
  return out;
}
