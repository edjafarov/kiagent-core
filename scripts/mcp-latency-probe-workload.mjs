/** Workload helpers for scripts/mcp-latency-probe.mjs (#146). */
export const EXPECTED_IDS = 10;

/** Per-cycle sample counts the fixed workload promises. */
const PER_CYCLE = { search: 12, get: 10, count: 2, info: 1, loop: 1 };

/** Setup (BEFORE any measurement): up to `want` distinct valid document ids
 *  from the text queries. */
export async function collectIds(call, queries, want = EXPECTED_IDS) {
  const ids = [];
  for (const q of queries) {
    const hits = await call('search', { query: q, limit: 10 });
    if (!Array.isArray(hits)) throw new Error(`search "${q}" returned a non-array result; cannot collect get ids`);
    for (const h of hits) if (ids.length < want && !ids.includes(h.id)) ids.push(h.id);
    if (ids.length >= want) break;
  }
  return ids;
}

/** A `get` result counts as a document only when it is a non-empty object
 *  without an `error` field (null / {} / error payloads are FAILED samples). */
export const isDocument = (r) =>
  r != null && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length > 0 && !('error' in r);

/** The concurrent part of a cycle. BOTH `count` group_by calls (they reach
 *  Query.countBy over the whole corpus) are STARTED FIRST, then the gets are
 *  issued, so the gets overlap the aggregates. `timed(kind, fn)` records one
 *  sample per call. Returns the ids whose `get` did NOT return a document (the
 *  caller turns any of them into exit 3: a failed get is never a fast success). */
export async function runGetsAndCounts({ call, timed, ids }) {
  const bad = [];
  const counts = [
    timed('count', () => call('count', { group_by: 'label' })),
    timed('count', () => call('count', { group_by: 'from' })),
  ];
  const gets = ids.map((id) =>
    timed('get', async () => {
      let r = null;
      try {
        r = await call('get', { id });
      } catch {
        /* a throwing get is a failed get, same as null */
      }
      if (!isDocument(r)) bad.push(id);
      return r;
    }),
  );
  await Promise.all([...counts, ...gets]);
  return bad;
}

/** Setup validation of the `get` ids: exactly `EXPECTED_IDS` DISTINCT ids, each
 *  of which returns a document. Returns problem messages (empty = valid). */
export async function validateIds(call, ids) {
  const problems = [];
  if (!Array.isArray(ids) || new Set(ids).size !== EXPECTED_IDS || ids.length !== EXPECTED_IDS) {
    problems.push(`need exactly ${EXPECTED_IDS} DISTINCT get ids, have ${Array.isArray(ids) ? `${new Set(ids).size} distinct of ${ids.length}` : 0}`);
    return problems;
  }
  for (const id of ids) {
    try {
      if (!isDocument(await call('get', { id }))) problems.push(`get ${id} returned no document`);
    } catch (e) {
      problems.push(`get ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return problems;
}

/** The fuzzy term must really EXECUTE the fuzzy pass on this corpus, and the
 *  search must return something. The proof is the app's own counter
 *  (`reads.fuzzyRuns` in the read diagnostics), not a reimplementation of
 *  stemming here: `readRuns(sinceMs)` resolves the counter from a diagnostics
 *  snapshot taken at or after `sinceMs`. Returns a problem message or null. */
export async function validateFuzzy(call, term, readRuns) {
  const before = await readRuns(Date.now());
  const hits = await call('search', { query: term, limit: 10 });
  const after = await readRuns(Date.now());
  const n = Array.isArray(hits) ? hits.length : 0;
  if (!(after > before) || n === 0) {
    return `fuzzy term "${term}" is not fuzzy-only on this corpus; pick a misspelling (fuzzy runs ${before} -> ${after}, search hits ${n})`;
  }
  return null;
}

/** A baseline report is only comparable if it is itself a complete run. */
export function checkBaseline(base) {
  const problems = [];
  const cycles = Number(base?.cycles ?? 0);
  if (!(cycles > 0)) return ['baseline report has no cycles'];
  for (const p of checkSamples(base.kinds ?? {}, cycles)) problems.push(`baseline ${p}`);
  for (const k of ['search', 'get']) {
    if (!(base.kinds?.[k]?.p95 > 0)) problems.push(`baseline ${k} p95 is not > 0`);
  }
  return problems;
}

/** Returns one message per kind whose sample count differs from the fixed
 *  workload (an empty array = complete). `kinds` is `{ [kind]: { n } }`. */
export function checkSamples(kinds, cycles) {
  const problems = [];
  for (const [kind, per] of Object.entries(PER_CYCLE)) {
    const want = per * cycles;
    const got = kinds[kind]?.n ?? 0;
    if (got !== want) problems.push(`${kind}: ${got} samples, expected ${want}`);
  }
  return problems;
}
