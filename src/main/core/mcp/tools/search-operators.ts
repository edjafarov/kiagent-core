/**
 * Gmail-style operator pre-parse for the `search` tool. Runs BEFORE the
 * remainder text reaches Query.search's boolean FTS grammar, so the store
 * never sees operator syntax. Deliberately conservative: anything that is
 * not exactly `op:value` on a recognized op (including `-from:x`,
 * `(from:x`, `from:` with no value, `has:` with a value other than
 * `attachment`) stays literal FTS text — colons occur in real content.
 */
export interface ParsedQuery {
  text: string;
  from: string[];
  to: string[];
  participant: string[];
  label: string[];
  filename: string[];
  ext: string[];
  hasAttachment: boolean;
  source?: string;
  type?: string;
  order?: 'newest' | 'relevance';
}

// Token scanner: `from:"Roman Kaplun"` and `"term sheet"` are single tokens.
const TOKEN_RE = /[^\s"]*"[^"]*"|\S+/g;
const OP_RE = /^([A-Za-z_]+):(.+)$/;

export function parseOperators(raw: string): ParsedQuery {
  const out: ParsedQuery = {
    text: '',
    from: [],
    to: [],
    participant: [],
    label: [],
    filename: [],
    ext: [],
    hasAttachment: false,
  };
  const rest: string[] = [];
  for (const tok of raw.match(TOKEN_RE) ?? []) {
    const m = OP_RE.exec(tok);
    if (!m) {
      rest.push(tok);
      continue;
    }
    const op = m[1].toLowerCase();
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (!value) {
      rest.push(tok);
      continue;
    }
    switch (op) {
      case 'from':
        out.from.push(value);
        break;
      case 'to':
        out.to.push(value);
        break;
      case 'participant':
        out.participant.push(value);
        break;
      case 'label':
        out.label.push(value);
        break;
      case 'filename':
        out.filename.push(value);
        break;
      case 'ext':
        out.ext.push(value.replace(/^\./, '').toLowerCase());
        break;
      case 'has':
        if (value.toLowerCase() === 'attachment') out.hasAttachment = true;
        else rest.push(tok);
        break;
      case 'in':
      case 'source':
        out.source = value;
        break;
      case 'type':
        out.type = value;
        break;
      case 'order': {
        const v = value.toLowerCase();
        if (v === 'newest' || v === 'relevance') out.order = v;
        else rest.push(tok);
        break;
      }
      default:
        rest.push(tok);
    }
  }
  out.text = rest.join(' ');
  return out;
}
