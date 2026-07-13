/**
 * `get_schema` — render SCHEMA_DOC as one markdown document. Pure; no DB
 * access (the drift test guarantees SCHEMA_DOC matches live SQLite). Markdown
 * rather than JSON keeps it scan-friendly for the model and lets prose like
 * prep_notes read naturally. Ported from kiagent-ref's get-schema.ts.
 */
import { SCHEMA_DOC } from './schema-doc';

export const getSchemaDescription = `Annotated schema of the digital-memory database — tables, columns, enum values, relations, and prep notes. Call this before \`query_sql\` when search/count/get_related aren't expressive enough and you need custom SQL. Key relation: a document's source is \`accounts.source\`, joined via \`documents.account_id = accounts.id\`. For live counts/sync state use \`digital_memory_info\` instead — this tool is layout, not contents. Returns markdown.`;

export function renderSchema(): string {
  const lines: string[] = [];
  lines.push('# Kia digital memory schema', '');
  lines.push(SCHEMA_DOC.overview, '');

  for (const t of SCHEMA_DOC.tables) {
    lines.push(`## ${t.name}`, '');
    lines.push(t.description, '');
    lines.push('| Column | Type | Notes |');
    lines.push('|---|---|---|');
    for (const c of t.columns) {
      const notes = c.notes.replace(/\|/g, '\\|');
      lines.push(`| \`${c.name}\` | ${c.type} | ${notes} |`);
    }
    if (t.relations && t.relations.length) {
      lines.push('', '**Relations:**');
      for (const r of t.relations) lines.push(`- ${r}`);
    }
    if (t.prep_notes) lines.push('', `**Prep notes:** ${t.prep_notes}`);
    lines.push('');
  }

  lines.push('### Enums', '');
  for (const e of SCHEMA_DOC.enums) {
    const vals = e.values.map((v) => `\`${v}\``).join(', ');
    const tail = e.notes ? ` — ${e.notes}` : '';
    lines.push(`- **${e.name}**: ${vals}${tail}`);
  }

  return lines.join('\n');
}
