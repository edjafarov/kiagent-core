/* eslint-disable @typescript-eslint/no-explicit-any, no-await-in-loop */
/** Plan-then-run variant of the agentic local Kia (spec 2026-10-05, rev 5):
 *  one schema-constrained plan call, deterministic execution (tolerant
 *  search, reads of the top hits), one numbered-sources answer call, at
 *  most one replan when the answer reports NOT FOUND. No tool-calling. */
import type { Query } from '@shared/contracts';
import { buildBuiltinTools } from '../tools';
import { ME, NOW_ISO, TZ } from './corpus';
import {
  BUDGET,
  KIND_OF,
  KIND_TYPES,
  MAX_TOKENS,
  PERSONA_LOCAL,
  RESERVE,
  STOPWORDS,
  briefHead,
  clipHead,
  clipTail,
  estimateTokens,
  fixedBrief,
  fixedBriefSources,
  localToUtc,
  localWhen,
  windowOf,
  writeBrief,
  type Llm,
  type Source,
  type Turn,
} from './harness';

const AGENT_BUDGET = 8192;
const HISTORY_TOKENS = 2000;
const KINDS = ['any', 'mail', 'calendar', 'files', 'meetings', 'chats'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_OR_EMPTY = '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$';

// ---------- seeded date context ----------
const dayFmt = (d: Date, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, ...o }).format(d);
const isoDay = (d: Date) =>
  dayFmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
const weekday = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long' }).format(d);

/** "Today is Monday 2026-10-05 …": the dates a small model can't compute. */
export function calendarContext(now = new Date(NOW_ISO)): string {
  const at = (n: number) => new Date(now.getTime() + n * 86_400_000);
  const dow = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ].indexOf(weekday(now));
  const mon = at(-dow);
  const week = Array.from({ length: 7 }, (_, i) => at(i - dow))
    .map((d) => `${weekday(d)} ${isoDay(d)}`)
    .join(', ');
  return [
    `Now: ${localWhen(now.toISOString())} (${TZ}).`,
    `Today: ${weekday(now)} ${isoDay(now)}. Yesterday: ${isoDay(at(-1))}. Tomorrow: ${isoDay(at(1))}.`,
    `This week: ${week}.`,
    `Last week: ${isoDay(new Date(mon.getTime() - 7 * 86_400_000))} to ${isoDay(new Date(mon.getTime() - 86_400_000))}. Next week: ${isoDay(new Date(mon.getTime() + 7 * 86_400_000))} to ${isoDay(new Date(mon.getTime() + 13 * 86_400_000))}.`,
  ].join('\n');
}

// ---------- the plan ----------
const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    keywords: { type: 'string' },
    kind: { type: 'string', enum: KINDS },
    from_date: { type: 'string', pattern: DAY_OR_EMPTY },
    to_date: { type: 'string', pattern: DAY_OR_EMPTY },
  },
  required: ['keywords', 'kind', 'from_date', 'to_date'],
  additionalProperties: false,
};
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['answer', 'count', 'draft_reply'] },
    searches: { type: 'array', items: SEARCH_SCHEMA, minItems: 1, maxItems: 3 },
  },
  required: ['action', 'searches'],
  additionalProperties: false,
};
export interface PlannedSearch {
  keywords: string;
  kind: string;
  from_date: string;
  to_date: string;
}
export interface Plan {
  action: 'answer' | 'count' | 'draft_reply';
  searches: PlannedSearch[];
}

const PLAN_RULES = [
  "Plan the searches of the user's memory that will find the answer. Reply with JSON only.",
  'action: "answer" for a question, "count" when they ask how many, "draft_reply" when they ask you to draft or write a reply.',
  'Each search: keywords = 1-4 words that would appear in the document itself: names, companies, products, places, topics. Never generic words such as meeting, call, schedule, plans, events, appointment, email, message, today, tomorrow, week, last, next, latest: kind and dates express those. Empty keywords lists everything of that kind in the date range.',
  'kind: mail, calendar (events, appointments, schedule), files (documents, invoices, reports), meetings (notes and transcripts of past meetings), chats (Slack, WhatsApp), or any when unsure.',
  'from_date/to_date: YYYY-MM-DD local dates, ONLY when the question names a day or period (today, tomorrow, this week, on Friday, in October). "The last X" or "the latest X" means the most recent one, whenever it was: leave dates empty. Use the dates listed above; never guess.',
  'Use a second or third search for another angle: a synonym, another kind, or the person instead of the topic.',
].join('\n');

function planPrompt(q: string, history: string, tried?: string): string {
  return [
    calendarContext(),
    history ? `Conversation so far:\n${history}` : '',
    tried
      ? `These searches did not find the answer:\n${tried}\nPlan different searches: other words, another kind, no dates, or the person's name.`
      : '',
    `Question: ${q}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function parsePlan(text: string): Plan | null {
  try {
    const j = JSON.parse(text);
    if (!j || !Array.isArray(j.searches) || !j.searches.length) return null;
    const action = ['answer', 'count', 'draft_reply'].includes(j.action)
      ? j.action
      : 'answer';
    const searches = j.searches.slice(0, 3).map((s: any) => ({
      keywords: String(s?.keywords ?? '').slice(0, 120),
      kind: KINDS.includes(s?.kind) ? s.kind : 'any',
      from_date: DAY.test(s?.from_date ?? '') ? s.from_date : '',
      to_date: DAY.test(s?.to_date ?? '') ? s.to_date : '',
    }));
    return { action, searches };
  } catch {
    return null;
  }
}

// ---------- execution ----------
const bounds = (s: PlannedSearch) => {
  const from = s.from_date || s.to_date;
  const to = s.to_date || s.from_date;
  return {
    ...(from ? { from_date: localToUtc(from, '00:00') } : {}),
    ...(to
      ? {
          to_date: new Date(
            Date.parse(localToUtc(to, '00:00')) + 86_400_000 - 1,
          ).toISOString(),
        }
      : {}),
  };
};
const words = (k: string) =>
  k
    .split(/[^\p{L}\p{N}%.]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));

/** Calendar bodies carry UTC `When:`; the model must only see local time. */
const localizeEvent = (
  text: string,
  start: string | null | undefined,
  end?: string | null,
) =>
  text.replace(
    /\*\*When:\*\*[^\n]*/g,
    `**When (${TZ}):** ${localWhen(start)}${end ? ` – ${localWhen(end)}` : ''}`,
  );

interface Hit {
  id: string;
  title: string;
  type: string;
  created_at: string;
  snippet: string;
  keyword: boolean;
}

/** Words that describe the kind or the time, not the content: as keywords
 *  they AND away every match ("tomorrow", "plans", "events"). */
const GENERIC = new Set(
  'today tomorrow yesterday tonight week weekend month year next last this coming upcoming recent latest schedule scheduled calendar agenda plans plan events event appointments appointment meetings meeting happens happening going on any my mail email emails message messages'.split(
    ' ',
  ),
);
const keywordsOf = (k: string) =>
  words(k).filter((w) => !GENERIC.has(w.toLowerCase()));

/** Query relaxation, cheapest loss of precision first. Every step runs only
 *  when the previous found nothing:
 *   1. all keywords, the kind, the dates
 *   2. any keyword, the kind, the dates
 *   3. keywords without the dates (a model's date guess is the usual miss)
 *   4. keywords without the kind
 *   5. no keywords: list the kind in the dates.
 *  A keyword search with a kind also takes the best any-kind hits after its
 *  own, because the model's kind guess is often wrong (a flight is mail). */
export async function tolerantSearch(core: any, s: PlannedSearch, limit = 8): Promise<Hit[]> {
  const kindTypes = s.kind !== 'any' && KIND_TYPES[s.kind] ? KIND_TYPES[s.kind] : [undefined];
  const dated = !!(s.from_date || s.to_date);
  const run = async (query: string | undefined, ts: Array<string | undefined>, withDates: boolean) => {
    const all: any[] = [];
    for (const type of ts) {
      const r: any = await core.search({
        ...(query ? { query } : {}),
        ...(type ? { type } : {}),
        ...(withDates ? bounds(s) : {}),
        limit,
      });
      all.push(...(Array.isArray(r) ? r : (r?.results ?? [])));
    }
    if (ts.length > 1) all.sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
    return all;
  };
  const w = keywordsOf(s.keywords);
  const and = w.join(' ');
  const or = w.length > 1 ? w.join(' OR ') : '';
  const kw = async (ts: Array<string | undefined>, withDates: boolean) => {
    const a = await run(and, ts, withDates);
    return a.length || !or ? a : run(or, ts, withDates);
  };
  let all: any[] = [];
  if (and) {
    all = await kw(kindTypes, dated);
    if (!all.length && dated) all = await kw(kindTypes, false);
    if (kindTypes[0] !== undefined) {
      const wide = await kw([undefined], dated && all.length > 0);
      const ids = new Set(all.map((h) => h.id));
      all = [...all, ...(all.length ? wide.filter((h) => !ids.has(h.id)).slice(0, 3) : wide)];
    }
  }
  if (!all.length && (dated || !and)) all = await run(undefined, kindTypes, dated);
  return all.slice(0, limit).map((h) => ({
    id: h.id,
    title: h.title,
    type: h.type,
    created_at: h.created_at,
    snippet: String(h.snippet ?? '').replace(/<\/?b>/g, ''),
    keyword: !!and,
  }));
}

/** Read the documents worth reading: the top keyword hits of each search. */
const READS_PER_SEARCH = 2;
const MAX_READS = 4;

interface Evidence {
  id: string;
  title: string;
  date: string | null;
  kind: string;
  text: string;
  read: boolean;
}

async function gather(
  core: any,
  plan: Plan,
  have: Map<string, Evidence>,
  order: string[],
) {
  const perSearch: Hit[][] = [];
  for (const s of plan.searches) perSearch.push(await tolerantSearch(core, s));
  const toRead: string[] = [];
  // Round-robin by rank so every search's best hit is read first.
  for (let r = 0; r < READS_PER_SEARCH; r += 1)
    for (const hits of perSearch) {
      const h = hits[r];
      if (h && h.keyword && !toRead.includes(h.id) && !have.get(h.id)?.read)
        toRead.push(h.id);
    }
  for (const id of toRead.slice(0, MAX_READS)) {
    const doc: any = await core.get({ id });
    if (!doc) continue;
    const w = windowOf({ ...doc, createdAt: doc.created_at });
    const text =
      doc.type === 'calendar.event'
        ? localizeEvent(w.text, doc.metadata?.start, doc.metadata?.end)
        : w.text;
    have.set(id, {
      id,
      title: doc.title,
      date: doc.created_at,
      kind: KIND_OF[doc.type] ?? doc.type,
      text,
      read: true,
    });
    if (!order.includes(id)) order.push(id);
  }
  for (const r of [0, 1, 2, 3, 4, 5, 6, 7])
    for (const hits of perSearch) {
      const h = hits[r];
      if (!h || have.has(h.id)) continue;
      const text =
        h.type === 'calendar.event'
          ? localizeEvent(h.snippet, h.created_at)
          : h.snippet;
      have.set(h.id, {
        id: h.id,
        title: h.title,
        date: h.created_at,
        kind: KIND_OF[h.type] ?? h.type,
        text,
        read: false,
      });
      order.push(h.id);
    }
  return perSearch;
}

/** Numbered sources, packed into the budget: reads first, then snippets. */
function pack(have: Map<string, Evidence>, order: string[], room: number) {
  const lines: string[] = [];
  const ids: string[] = [];
  const ranked = [
    ...order.filter((id) => have.get(id)!.read),
    ...order.filter((id) => !have.get(id)!.read),
  ];
  for (const id of ranked) {
    const e = have.get(id)!;
    const when =
      e.kind === 'calendar' ? `event ${localWhen(e.date)}` : localWhen(e.date);
    const body = e.read ? clipHead(e.text, 1500) : clipHead(e.text, 120);
    const l = `[S${lines.length + 1}] ${e.title} · ${e.kind} · ${when}\n${body}`;
    const cost = estimateTokens(l) + 2;
    if (cost > room) continue;
    lines.push(l);
    ids.push(id);
    room -= cost;
  }
  return { text: lines.join('\n\n'), ids };
}

const ANSWER_RULES = (email: boolean) =>
  [
    PERSONA_LOCAL,
    `Times are in ${TZ}. ${calendarContext()}`,
    `The user is ${ME}; "I" and "me" in the question mean them.`,
    'Answer the question from the numbered sources. When sources disagree, the newest one wins. Read every source before deciding nothing answers it. Cite the source title you used.',
    'If the sources do not contain the answer, reply with exactly: NOT FOUND',
    email
      ? 'You are answering by email: concise plain text, no markdown.'
      : 'Plain text.',
  ].join('\n');

/** The answer step's "nothing here": the sentinel, or the ways small models
 *  paraphrase it when the whole reply is a refusal. */
const NOT_FOUND =
  /^\s*(NOT FOUND\b|(the )?(provided )?sources? (do|does) not (contain|mention|include|say)|i (could not|couldn't|cannot|can't) find|there is no (information|mention))/i;

export async function planTurn(
  llm: Llm,
  query: Query,
  q: string,
  history: string[] = [],
): Promise<Turn> {
  const t0 = Date.now();
  const drafts: Turn['drafts'] = [];
  const outbound: any = {
    draftReply: async (a: any) => {
      drafts.push({ documentId: a.documentId, body: a.body });
      return { status: 'draft' };
    },
    draftMessage: async () => ({ status: 'draft' }),
    listOutbox: async () => [],
    sendDraft: async () => {
      throw new Error('agent transport cannot send');
    },
  };
  const core = Object.fromEntries(
    buildBuiltinTools(query, outbound).map((t) => [t.name, t.call]),
  );
  const hist = clipTail(history.join('\n\n'), HISTORY_TOKENS);
  const calls: Turn['calls'] = [];
  const have = new Map<string, Evidence>();
  const order: string[] = [];
  const actions: string[] = [];
  let error: string | undefined;

  const makePlan = async (tried?: string): Promise<Plan> => {
    const raw = await llm.complete(
      planPrompt(q, hist, tried),
      `${PLAN_RULES}`,
      400,
      PLAN_SCHEMA,
    );
    const p = parsePlan(raw);
    calls.push({ name: 'plan', args: p ?? raw });
    // A broken plan still searches: the question's own words, any kind.
    return (
      p ?? {
        action: 'answer',
        searches: [
          {
            keywords: words(q).join(' '),
            kind: 'any',
            from_date: '',
            to_date: '',
          },
        ],
      }
    );
  };
  const describe = (p: Plan, found: Hit[][]) =>
    p.searches
      .map(
        (s, i) =>
          `- ${JSON.stringify(s)} → ${
            found[i].length
              ? found[i]
                  .slice(0, 3)
                  .map((h) => h.title)
                  .join('; ')
              : 'nothing'
          }`,
      )
      .join('\n');

  const answer = async (p: Plan): Promise<{ raw: string; ids: string[] }> => {
    const sys = ANSWER_RULES(true);
    const head = `${hist ? `Conversation so far:\n${hist}\n\n` : ''}Question: ${q}\n\n${actions.length ? `What you did:\n${actions.join('\n')}\n\n` : ''}Sources:\n`;
    const room =
      AGENT_BUDGET - estimateTokens(sys) - estimateTokens(head) - RESERVE;
    const packed = pack(have, order, room);
    void p;
    const raw = await llm.complete(`${head}${packed.text}`, sys, MAX_TOKENS);
    return { raw, ids: packed.ids };
  };

  let raw = '';
  let ids: string[] = [];
  let path = 'plan';
  try {
    let plan = await makePlan();
    let found = await gather(core, plan, have, order);
    for (const [i, s] of plan.searches.entries())
      calls.push({ name: 'search', args: s, hits: found[i].length });

    if (plan.action === 'count') {
      const s = plan.searches[0];
      const types =
        s.kind !== 'any' && KIND_TYPES[s.kind]
          ? KIND_TYPES[s.kind]
          : [undefined];
      let total = 0;
      for (const type of types) {
        const r: any = await core.count({
          ...(type ? { type } : {}),
          ...(s.keywords ? { query: words(s.keywords).join(' ') } : {}),
          ...bounds(s),
        });
        total += Array.isArray(r)
          ? r.reduce((n: number, x: any) => n + Number(x?.count ?? 0), 0)
          : Number(r?.count ?? 0);
      }
      actions.push(
        `Counted ${s.kind === 'any' ? 'documents' : s.kind}${s.from_date ? ` from ${s.from_date} to ${s.to_date || s.from_date}` : ''}${s.keywords ? ` matching "${s.keywords}"` : ''}: ${total}.`,
      );
      calls.push({ name: 'count', args: s, hits: total });
    }

    let a = await answer(plan);
    if (NOT_FOUND.test(a.raw)) {
      path = 'plan+replan';
      plan = await makePlan(describe(plan, found));
      found = await gather(core, plan, have, order);
      for (const [i, s] of plan.searches.entries())
        calls.push({ name: 'search', args: s, hits: found[i].length });
      a = await answer(plan);
    }
    raw = a.raw;
    ids = a.ids;

    if (plan.action === 'draft_reply' && !NOT_FOUND.test(raw)) {
      const threads = ids.filter((id) => have.get(id)!.kind === 'mail');
      if (threads.length) {
        const schema = {
          type: 'object',
          properties: {
            thread: { type: 'integer', enum: threads.map((_, i) => i + 1) },
            text: { type: 'string' },
          },
          required: ['thread', 'text'],
          additionalProperties: false,
        };
        const list = threads
          .map(
            (id, i) =>
              `${i + 1}. ${have.get(id)!.title} · ${localWhen(have.get(id)!.date)}\n${clipHead(have.get(id)!.text, 600)}`,
          )
          .join('\n\n');
        const out = await llm.complete(
          `${hist ? `Conversation so far:\n${hist}\n\n` : ''}Request: ${q}\n\nMail threads:\n${list}`,
          `${PERSONA_LOCAL} Pick the thread the user wants to reply to and write the reply body in the user's voice, ready to send. Plain text, no subject line. Reply with JSON only.`,
          800,
          schema,
        );
        try {
          const j = JSON.parse(out);
          const id = threads[Number(j.thread) - 1];
          if (id && String(j.text ?? '').trim()) {
            await core.draft_reply({ document_id: id, body: String(j.text) });
            calls.push({ name: 'draft_reply', args: { id } });
            raw = `I drafted a reply on "${have.get(id)!.title}". It is waiting in your Outbox; nothing was sent.\n\n${String(j.text).trim()}`;
          }
        } catch (e) {
          error = `draft: ${(e as Error).message}`;
        }
      }
    }
  } catch (e) {
    error = (e as Error).message;
  }
  if (NOT_FOUND.test(raw)) raw = "I couldn't find that in your memory.";
  // Small models wrap an emailed answer as an email of its own.
  raw = raw
    .replace(/^\s*Subject:[^\n]*\n+/i, '')
    .replace(/^\s*(Hi|Hello|Dear)\b[^\n]{0,40},\s*\n+/i, '')
    .replace(/\n+\s*(Best|Regards|Kind regards|Best regards|Thanks|Cheers|Sincerely)\b[^\n]*(\n[^\n]{0,40})?\s*$/i, '')
    .trim();
  const invented = [...new Set(raw.match(/\bS(\d+)\b/g) ?? [])].filter(
    (s) => Number(s.slice(1)) > ids.length,
  );
  return {
    answer: raw.replace(/\*\*|__|^#+\s/gm, ''),
    raw,
    ms: Date.now() - t0,
    calls,
    seen: [...have.keys()],
    drafts,
    invented,
    path,
    ...(error ? { error } : {}),
  };
}

// ---------- briefs ----------
const BRIEF_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    searches: { type: 'array', items: SEARCH_SCHEMA, maxItems: 2 },
  },
  required: ['searches'],
  additionalProperties: false,
};

/** Today's fixed sources stay the floor; one plan call adds up to two
 *  searches for what's missing; their top hits are read in full. */
export async function planBrief(
  llm: Llm,
  query: Query,
  ev: any,
): Promise<Turn> {
  const t0 = Date.now();
  const src = await fixedBriefSources(query, ev);
  const floor = [...src].sort((a, b) =>
    (b.date ?? '').localeCompare(a.date ?? ''),
  );
  const core = Object.fromEntries(
    buildBuiltinTools(query).map((t) => [t.name, t.call]),
  );
  const listed =
    floor.map((s) => `- ${s.title} · ${localWhen(s.date)}`).join('\n') ||
    '(nothing found)';
  const raw = await llm.complete(
    `${calendarContext()}\n\n${briefHead(ev)}\n\nAlready found:\n${listed}`,
    `Plan up to two more searches of the user's memory for what is missing to prepare this meeting (the topic's documents, notes of earlier meetings, mail about it). An empty list is fine when nothing is missing. Keywords: 1-4 distinctive words. Leave dates empty unless needed. Reply with JSON only.`,
    300,
    BRIEF_PLAN_SCHEMA,
  );
  let searches: PlannedSearch[] = [];
  try {
    searches = (JSON.parse(raw).searches ?? []).slice(0, 2).map((s: any) => ({
      keywords: String(s?.keywords ?? ''),
      kind: KINDS.includes(s?.kind) ? s.kind : 'any',
      from_date: DAY.test(s?.from_date ?? '') ? s.from_date : '',
      to_date: DAY.test(s?.to_date ?? '') ? s.to_date : '',
    }));
  } catch {
    searches = [];
  }
  const calls: Turn['calls'] = [{ name: 'plan', args: searches }];
  if (!searches.length) {
    const f = await fixedBrief(llm, query, ev);
    return {
      ...f,
      ms: Date.now() - t0,
      calls,
      path: 'plan(nothing missing)→fixed',
    };
  }
  const have = new Map<string, Evidence>();
  const order: string[] = [];
  for (const s of floor)
    have.set(s.id, {
      id: s.id,
      title: s.title,
      date: s.date,
      kind: '',
      text: s.excerpt,
      read: true,
    });
  await gather(core, { action: 'answer', searches }, have, order);
  const extra: Source[] = order
    .map((id) => have.get(id)!)
    .filter((e) => e.read)
    .map((e) => ({
      id: e.id,
      title: e.title,
      date: e.date,
      excerpt: clipHead(e.text, 500),
    }));
  const text = await writeBrief(llm, ev, floor, extra, AGENT_BUDGET);
  void BUDGET;
  return {
    answer: text,
    raw: text,
    ms: Date.now() - t0,
    calls: [...calls, ...searches.map((s) => ({ name: 'search', args: s }))],
    seen: [...floor.map((s) => s.id), ...extra.map((s) => s.id)],
    drafts: [],
    invented: [],
    path: 'plan',
  };
}
