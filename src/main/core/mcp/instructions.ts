/**
 * Server instructions advertised in the MCP `initialize` handshake — guidance
 * the calling LLM reads before its first tool call, so it materially shapes
 * how clients drive the tools. Ported from kiagent-ref's
 * src/main/mcp/instructions.ts, ADAPTED to the greenfield tool surface:
 *  - `query_sql`/`get_schema` patterns dropped (not exposed — see tools/).
 *  - "English stemming" dropped: search is FTS5 unicode61 (diacritics-folded)
 *    with NO stemmer, so the text now tells the model to vary word forms.
 *  - Thread dating updated: a greenfield gmail thread's `created_at` IS the
 *    latest message's date (metadata key `lastMessageAt`, camelCase) — the
 *    legacy "old created_at but still active" caveat no longer applies.
 *  - `get_related` gained `children`/`parent` alongside the legacy two.
 */
export const KIA_INSTRUCTIONS = `"Kia" is the nickname users use for this MCP server (kiagent).
When a user addresses you as "kia" or mentions kia in a request,
they are asking you to use these tools to answer.

Kia gives access to an indexed personal/team digital memory —
emails, files, meeting notes, attachments, chats. Use it for any
question about something the user has read, written, sent, received,
saved, or been involved in.

Full-text search: bare terms are ANDed; "quoted phrases" match
exactly; -term excludes; UPPERCASE OR alternates; term* prefix-
matches; parentheses group. There is NO stemming — "invoice" will
not match "invoices" — so prefer prefix matches (invoice*) or
OR-of-variants when word form is uncertain. The digital memory is
multilingual — if a search returns nothing, retry in the likely
source language. Call digital_memory_info to see what languages are
present.

Recency & dates. The digital memory can span many years and holds
outdated, superseded material. Every date — created_at and the
from_date / to_date filters — is when the item was sent, received,
or created at the source, never when Kia indexed it. Unless the
user explicitly asks about the past, treat the newest matching
document as current and older ones as superseded; when several
documents answer the same factual question, prefer the most recent
and give its date. For an open-ended "what's the current..."
question, bias to recent — e.g. restrict to about the last 90 days
with from_date, and widen only if the answer isn't there. State any
window you applied.

Email threads carry their LATEST message's date as created_at (also
metadata.lastMessageAt), so recency ordering reflects activity.
Expand a thread's individual messages with
get_related(thread_messages); its attachments with
get_related(attachments).

Common patterns:
  find / what about X      → search
  recent X / lately        → search + from_date
  what's in your memory    → digital_memory_info
  how many docs per source → count
  full doc body            → search → get
  expand an email thread   → get → get_related(thread_messages)
  email attachments        → get → get_related(attachments)

Batch / parallel queries:
  search and get both accept batched input so you can run N queries
  in a single MCP round-trip. Prefer batching over N sequential
  calls — same result, far less latency.

    get(ids=[idA, idB, idC])            → array of docs (or null per miss)
    search(queries=[{query:"X"}, {query:"X", source:"gmail"}])
                                        → array of result lists, in order

  Typical uses: pulling several search hits' bodies at once, trying
  the same topic across multiple languages, or probing several
  related phrasings in parallel. Independent kia tool calls (e.g.,
  search + digital_memory_info) can already be dispatched in parallel by
  the client — batch mode covers the case where the same tool fires
  multiple times.

Titles often understate body content. If a topic search misses,
search for distinctive body phrases. If results look irrelevant,
vary the wording — synonyms, narrower phrases, related terms —
before concluding nothing exists.

Don't invent documents or details not returned by a tool.
`;
