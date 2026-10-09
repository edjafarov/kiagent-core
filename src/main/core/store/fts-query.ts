/**
 * Compile user search text into an FTS5 MATCH expression.
 *
 * Supported syntax:
 *   term term            — implicit AND
 *   AND / OR / NOT       — boolean operators (UPPERCASE only; lowercase
 *                          and/or/not are ordinary search terms)
 *   -term                — exclude (shorthand for NOT)
 *   "a phrase"           — exact phrase
 *   term*                — prefix match
 *   ( … )                — grouping
 *
 * Every term is emitted as a quoted FTS5 string, so raw FTS5 syntax
 * (bare `-`, `:`, NEAR, column filters) can never leak through and throw.
 * Structural mistakes (unbalanced parens, negation with nothing positive
 * beside it) throw descriptive Errors — the MCP registry forwards those
 * to the calling LLM, which can then correct the query.
 */
type FtsToken =
  | { kind: 'op'; op: 'AND' | 'OR' | 'NOT' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'str'; value: string; prefix: boolean; negated: boolean };

function tokenizeFts(text: string): FtsToken[] {
  const out: FtsToken[] = [];
  const re = /(-)?"([^"]*)"\s*(\*)?|(\()|(\))|([^\s()]+)/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text)) !== null) {
    if (m[2] !== undefined) {
      const value = m[2].trim();
      if (value)
        out.push({
          kind: 'str',
          value,
          prefix: m[3] === '*',
          negated: m[1] === '-',
        });
    } else if (m[4]) out.push({ kind: 'lparen' });
    else if (m[5]) out.push({ kind: 'rparen' });
    else {
      let word = m[6];
      if (word === 'AND' || word === 'OR' || word === 'NOT') {
        out.push({ kind: 'op', op: word });
        continue;
      }
      const negated = word.startsWith('-');
      if (negated) word = word.slice(1);
      const prefix = word.endsWith('*');
      if (prefix) word = word.replace(/\*+$/, '');
      word = word.replace(/["*]/g, '');
      if (word) out.push({ kind: 'str', value: word, prefix, negated });
    }
  }
  return out;
}

export function ftsQuery(
  text: string,
  expand?: (term: string) => string[],
): string {
  const tokens = tokenizeFts(text);
  let pos = 0;

  // andGroup := (term | NOT term | ( orExpr ))+ — implicit AND between
  // operands. FTS5 has no unary NOT, so negations are emitted as trailing
  // binary NOTs: `a AND b NOT c NOT d` (associativity is irrelevant — any
  // grouping yields "matches a and b, minus c, minus d").
  const parseAnd = (): string => {
    const positives: string[] = [];
    const negatives: string[] = [];
    let pendingNot = false;
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t.kind === 'rparen' || (t.kind === 'op' && t.op === 'OR')) break;
      pos += 1;
      if (t.kind === 'op') {
        // AND is the implicit joiner anyway; NOT flags the next operand.
        if (t.op === 'NOT') pendingNot = true;
        continue;
      }
      let operand: string;
      let negated = pendingNot;
      pendingNot = false;
      if (t.kind === 'lparen') {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        operand = parseOr();
        if (tokens[pos]?.kind === 'rparen') pos += 1;
        else throw new Error('search query: missing closing ")"');
        if (!operand) continue; // empty group — ignore
      } else {
        negated = negated || t.negated;
        const quoted = `"${t.value.replace(/"/g, '""')}"${t.prefix ? ' *' : ''}`;
        // Stem expansion widens POSITIVE plain terms only: phrases (value
        // contains whitespace), prefix terms and negations stay raw so their
        // exact semantics survive.
        const variants =
          expand && !negated && !t.prefix && !/\s/.test(t.value)
            ? expand(t.value)
            : [];
        operand = variants.length
          ? `(${[
              quoted,
              ...variants.map((v) => `"${v.replace(/"/g, '""')}"`),
            ].join(' OR ')})`
          : quoted;
      }
      (negated ? negatives : positives).push(operand);
    }
    if (negatives.length && !positives.length)
      throw new Error(
        'search query: negation (-term / NOT) needs at least one positive term alongside it',
      );
    if (!positives.length) return '';
    let expr = positives.join(' AND ');
    for (const n of negatives) expr = `${expr} NOT ${n}`;
    return positives.length + negatives.length > 1 ? `(${expr})` : expr;
  };

  const parseOr = (): string => {
    const branches: string[] = [parseAnd()];
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t.kind !== 'op' || t.op !== 'OR') break;
      pos += 1;
      branches.push(parseAnd());
    }
    const parts = branches.filter(Boolean);
    if (parts.length === 0) return '';
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  };

  const expr = parseOr();
  if (pos < tokens.length) throw new Error('search query: unmatched ")"');
  return expr || '""';
}
