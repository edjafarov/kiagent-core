import {
  ModelChangedError,
  type ActiveCallOp,
  type Inference,
  type InferenceProvider,
  type Lane,
} from '@shared/contracts';

import { abortError } from './abort';
import { createActiveCalls, type ActiveCalls } from './active-calls';
import type { LogSink } from './engine/engine';

/** The two decoding profiles a caller can ask for. `'deterministic'` is for
 *  classification-style prompts that want repeatable output; `'default'`
 *  is today's behavior, unchanged. Applied by the provider, not the plane —
 *  the plane only threads the value through. */
export type CompletionProfile = 'default' | 'deterministic';

/** Everything `completeWithMeta` adds over `complete`'s bare string: which
 *  provider/model actually answered, the generation it answered under, and
 *  whatever usage/truncation info the provider reported (`null`/`false`
 *  when a provider returns a plain string, as every provider does today). */
export interface CompletionMeta {
  text: string;
  providerId: string;
  modelId: string;
  generation: number;
  profile: CompletionProfile;
  promptTokens: number | null;
  completionTokens: number | null;
  truncated: boolean;
  firstTokens?: { token: string; logprob: number }[];
}

export interface InferencePlane extends Inference {
  /** Local calls executing right now (complete/see/read; `hear` is recorded
   *  by the local-ASR pump). Remote providers never appear. */
  readonly activeCalls: ActiveCalls;
  complete(
    prompt: string,
    opts?: {
      maxTokens?: number;
      lane?: Lane;
      profile?: CompletionProfile;
      system?: string;
      /** A generation obtained from `describe()`. When present, the plane
       *  re-checks it against the CURRENT generation right after resolving
       *  the provider (before any request reaches the model) and rejects
       *  with ModelChangedError on a mismatch. */
      generation?: number;
      /** Caller-owned task id and budget key, threaded to the provider. */
      task?: string;
      budgetKey?: string;
      /** JSON Schema the reply must match. The local provider constrains
       *  decoding to it (llama-server `response_format: json_schema`);
       *  remote providers ignore it. Best effort: llama-server drops a
       *  schema its grammar converter can't compile (e.g. a `\\d` in a
       *  `pattern`; use `[0-9]`), so callers still validate the reply. */
      schema?: Record<string, unknown>;
      /** GBNF grammar constraining local decoding (exclusive with `schema`);
       *  remote providers ignore it. */
      grammar?: string;
      /** Local only: return the top-N alternatives of the first generated
       *  token as `firstTokens` (completeWithMeta). */
      topLogprobs?: number;
      /** Background lane only: cancels the call while it waits at the gate
       *  (rejects AbortError; the provider is never invoked). Not forwarded
       *  to providers. */
      signal?: AbortSignal;
    },
  ): Promise<string>;
  /** Same request as `complete`, but returns identity + usage alongside the
   *  text instead of a bare string. */
  completeWithMeta(
    prompt: string,
    opts?: {
      maxTokens?: number;
      lane?: Lane;
      profile?: CompletionProfile;
      system?: string;
      generation?: number;
      task?: string;
      budgetKey?: string;
      /** JSON Schema the reply must match. The local provider constrains
       *  decoding to it (llama-server `response_format: json_schema`);
       *  remote providers ignore it. Best effort: llama-server drops a
       *  schema its grammar converter can't compile (e.g. a `\\d` in a
       *  `pattern`; use `[0-9]`), so callers still validate the reply. */
      schema?: Record<string, unknown>;
      /** GBNF grammar constraining local decoding (exclusive with `schema`);
       *  remote providers ignore it. */
      grammar?: string;
      /** Local only: return the top-N alternatives of the first generated
       *  token as `firstTokens` (completeWithMeta). */
      topLogprobs?: number;
      /** Background lane only: cancels the call while it waits at the gate
       *  (rejects AbortError; the provider is never invoked). Not forwarded
       *  to providers. */
      signal?: AbortSignal;
    },
  ): Promise<CompletionMeta>;
  /** `see`, plus the provider and model that described the image. */
  seeWithMeta(
    image: Uint8Array,
    prompt: string,
    opts?: {
      mime?: string;
      lane?: Lane;
      task?: string;
      budgetKey?: string;
      /** Background lane only: cancels the call while it waits at the gate
       *  (rejects AbortError; the provider is never invoked). Not forwarded
       *  to providers. */
      signal?: AbortSignal;
    },
  ): Promise<{ text: string; providerId: string; modelId: string }>;
  /** Resolves the provider that WOULD answer `kind` right now, exactly as
   *  the call path's `pick(kind)` does, and reports its model identity plus
   *  the plane's current generation — so a caller can compute a cache key
   *  BEFORE calling, and later pass the generation back to `complete`/
   *  `completeWithMeta` to be rejected if the model changed underneath it.
   *  `null` when no ready provider supports the kind; never throws. */
  describe(
    kind: 'complete' | 'see' | 'read' | 'hear',
    task?: string,
  ): Promise<{
    providerId: string;
    modelId: string;
    generation: number;
  } | null>;
  /** Current generation token. One integer per plane, monotonically
   *  increasing, never persisted — a restart is a new generation by
   *  construction (see `createInference`'s seed). */
  generation(): number;
  register(provider: InferenceProvider): () => void;
  providers(): InferenceProvider[];
  /** A local provider of `kind` is downloading or says it may become ready
   *  on its own (`InferenceProvider.mayBecomeReady`). Remote ones never count. */
  mayBecomeReady(kind: 'complete' | 'see' | 'read' | 'hear'): boolean;
  /** Route a caller-owned task to a registered provider (typically a
   *  remote one), or clear it with `null`. In memory only; the owner
   *  re-applies routes after a restart. Never bumps the generation. A
   *  provider's disposer clears the routes naming it. */
  setRoute(task: string, providerId: string | null): void;
  /** The current routes, for a user-facing "some tasks leave this
   *  machine" line. */
  routes(): Array<{ task: string; providerName: string; remote: boolean }>;
  /** Bind the ONE background-lane policy (boot.ts `backgroundLaneOpen`).
   *  `gate()` calls it on every background request — no cached boolean, so
   *  admission is never staler than the policy's inputs. Unbound = closed. */
  setLanePolicy(fn: () => boolean): void;
  /** Bind the foreground wait (#147 §2 rule 1): every background request
   *  awaits it after the lane check — a bounded WAIT (admission caps it at
   *  MAX_FOREGROUND_WAIT_MS), never a throw, so a foreground burst never
   *  discards an already-done fetch/raster/OCR. The caller's `signal` ends
   *  the wait (AbortError). Unbound = no wait. */
  setForegroundIdle(fn: (signal?: AbortSignal) => Promise<void>): void;
}

/** Thrown by the routing layer when NO ready provider supports a kind — as
 *  opposed to a provider/helper that IS present but crashes mid-request.
 *  The two-pass vision worker relies on the distinction: "no provider" means
 *  the capability simply isn't available yet (fall through / try the next
 *  pass), whereas a crash is a transient fault to DEFER and retry so a doc
 *  isn't left permanently un-extracted. */
export class NoProviderError extends Error {
  readonly kind: 'complete' | 'see' | 'read' | 'hear';

  constructor(kind: 'complete' | 'see' | 'read' | 'hear') {
    super(
      `no inference provider available for '${kind}' — install or enable one in Settings`,
    );
    this.name = 'NoProviderError';
    this.kind = kind;
  }
}

/** Thrown to background-lane callers while the lane is closed. Fail-fast on
 *  purpose: parking the request as a pending promise would pin the caller's
 *  entire async chain — including batches of loaded documents — in memory
 *  until the lane reopens (observed as ~1.5 GB held for a full daytime
 *  window). Workers catch this and DEFER the change to the ledger instead. */
export class LaneClosedError extends Error {
  constructor() {
    super(
      'background inference lane is closed — outside the processing window',
    );
    this.name = 'LaneClosedError';
  }
}

// `ModelChangedError` itself now lives in `@shared/contracts.ts` — a
// provider (e.g. `src/main/providers/local-llm/provider.ts`) throws the
// SAME class from its own `handle()`, and a provider must not depend on
// this module (the plane), so the one shared shape lives at the layer
// both already import from. Re-exported here so existing importers of
// `'../inference'` keep compiling unchanged.
export { ModelChangedError };

/** What a remote provider throws when it can't serve a call right now
 *  (disconnected, over budget, busy). The plane answers the call locally
 *  instead. Callers across RPC discriminate by `name`. */
export class RemoteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteUnavailableError';
  }
}

/** Normalizes a provider's `complete` result: every provider today returns
 *  a plain string, so it maps to usage-less meta; a provider that opts into
 *  the richer shape (task 3's local provider) is passed through as-is. */
function normalizeCompletion(raw: unknown): {
  text: string;
  promptTokens: number | null;
  completionTokens: number | null;
  truncated: boolean;
  firstTokens?: { token: string; logprob: number }[];
} {
  if (typeof raw === 'string') {
    return {
      text: raw,
      promptTokens: null,
      completionTokens: null,
      truncated: false,
    };
  }
  const r = raw as {
    text?: string;
    promptTokens?: number | null;
    completionTokens?: number | null;
    truncated?: boolean;
    firstTokens?: { token: string; logprob: number }[];
  };
  // Preserve the old String(out) coercion as a fallback: a provider that
  // returns a non-string, non-`{text}` shape still yields SOME text rather
  // than `undefined`.
  return {
    text: typeof r.text === 'string' ? r.text : String(raw),
    promptTokens: r.promptTokens ?? null,
    completionTokens: r.completionTokens ?? null,
    truncated: r.truncated ?? false,
    ...(r.firstTokens ? { firstTokens: r.firstTokens } : {}),
  };
}

/**
 * ONE front door to models. Requests route to the first ready provider that
 * supports the kind; background requests flow only while the bound lane
 * policy answers open, and throw LaneClosedError otherwise.
 */
export function createInference(
  logs: LogSink,
  config?: { generationSeed?: number },
): InferencePlane {
  const providers: InferenceProvider[] = [];
  const activeCalls = createActiveCalls();
  /** Executing local calls only; remote providers are not this indicator's business. */
  const tracked = async <T>(
    p: InferenceProvider,
    op: ActiveCallOp,
    task: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> => {
    if (p.remote) return fn();
    const leave = activeCalls.enter(op, task ?? null);
    try {
      return await fn();
    } finally {
      leave();
    }
  };
  const routeTable = new Map<string, string>();
  let lanePolicy: () => boolean = () => false;
  let foregroundIdle: (signal?: AbortSignal) => Promise<void> = () =>
    Promise.resolve();

  // Random start so a process restart is a new generation by construction —
  // nothing persists it across boots. Seed is injectable so tests are
  // deterministic; never use a fixed default in production.
  let generation =
    config?.generationSeed ?? 1 + Math.floor(Math.random() * 1_000_000);

  /** What `describe(kind)` recorded for the CURRENT generation: the
   *  modelId the FIRST `describe(kind)` call at this generation resolved.
   *  `completeWithMeta` threads this recorded value forward as
   *  `payload.expectModelId` (fix round 1, post-review) instead of
   *  recomputing a fresh `modelIdOf(p, kind)` at call time — recomputing
   *  fresh made the provider-side check in `handle()` structurally
   *  unreachable, since both reads happened synchronously in the same JS
   *  turn with nothing able to mutate state in between.
   *
   *  Keyed by `kind` alone, not `(kind, generation)`, because the map is
   *  actively kept to hold ONLY entries for the CURRENT generation —
   *  `bump()` below clears it outright the instant the generation moves,
   *  since `checkGeneration` will then reject every caller citing the old
   *  generation and nothing can ever look an old entry up again. This
   *  bounding is explicit (a `clear()` call), not an inferred consequence
   *  of `checkGeneration`'s own rejection.
   *
   *  Write policy is FIRST-WRITE-WINS per generation (fix round 2,
   *  post-review): once an entry exists for a kind at the current
   *  generation, a LATER `describe(kind)` call must not overwrite it.
   *  This is not an incidental choice — it is what makes the
   *  provider-level check able to catch the exact bug class it exists
   *  for. Scenario: caller A calls `describe('complete')` at generation
   *  G and this map records modelId X. The underlying model then drifts
   *  to Y WITHOUT any `onChange` firing (the coverage-gap bug itself), so
   *  `generation` stays G. If a SECOND caller B now calls
   *  `describe('complete')` (also at generation G, since it hasn't
   *  moved) and this map were overwritten with B's fresh read (Y), A's
   *  later `complete(prompt, {generation: G})` would compare against Y —
   *  the value the bug ALREADY corrupted — and pass clean. The overwrite
   *  would erase the one piece of evidence (X) that could have caught
   *  the drift. First-write-wins keeps X in the map until the next real
   *  bump, so A's later call still trips. `describe()`'s own RETURN
   *  value is unaffected by this policy — it always reports a live,
   *  freshly-computed `modelId` to whoever calls it (B still truthfully
   *  sees Y); only this internal bookkeeping record is pinned to the
   *  first observer. */
  const describedAt = new Map<
    string,
    { generation: number; modelId: string; providerId: string }
  >();
  /** One record per (kind, task): a task's describe never overwrites the
   *  task-less one a caller without that task will compare against. */
  const describedKey = (kind: string, task: string | undefined): string =>
    `${kind}|${task ?? ''}`;

  const bump = (): void => {
    generation += 1;
    describedAt.clear();
  };

  /** Interactive: returns synchronously — no suspension, so an interactive
   *  call registers in `activeCalls` in the same tick as before (the
   *  inference-active-calls suite pins that). Background: lane check, the
   *  bounded and cancellable foreground wait, then the lane and the signal
   *  re-checked, since either may have changed during the (≤ 10 s) wait. */
  const gate = (
    lane: Lane,
    signal?: AbortSignal,
  ): Promise<void> | undefined => {
    if (lane === 'interactive') return undefined;
    // Lane first: a closed lane fails fast (LaneClosedError's memory
    // rationale above) and never waits.
    if (!lanePolicy()) throw new LaneClosedError();
    if (signal?.aborted) throw abortError();
    return (async () => {
      await foregroundIdle(signal);
      if (signal?.aborted) throw abortError();
      if (!lanePolicy()) throw new LaneClosedError();
    })();
  };

  /** A task with a route goes to its provider when that provider serves
   *  the kind and says it can take the task now. Everything else — and a
   *  routed task whose provider can't — goes to the first ready LOCAL
   *  provider: a remote one is never chosen by kind alone. */
  const pick = (
    kind: 'complete' | 'see' | 'read' | 'hear',
    task?: string,
  ): InferenceProvider => {
    const routedId = task === undefined ? undefined : routeTable.get(task);
    const routed =
      routedId === undefined
        ? undefined
        : providers.find((x) => x.id === routedId);
    if (
      routed &&
      routed.supports.includes(kind) &&
      routed.status(task) === 'ready'
    ) {
      return routed;
    }
    const p = providers.find(
      (x) => !x.remote && x.supports.includes(kind) && x.status() === 'ready',
    );
    if (!p) {
      throw new NoProviderError(kind);
    }
    return p;
  };

  const modelIdOf = (
    p: InferenceProvider,
    kind: 'complete' | 'see' | 'read' | 'hear',
  ): string => p.describe?.(kind)?.modelId ?? p.id;

  /** Throws BEFORE `p.handle(...)` when the caller passed a `generation`
   *  from `describe()` and the plane has moved on since. Checked AFTER
   *  `pick()` — i.e. against the provider that would actually serve this
   *  call — per issue #107's binding rule. This is the PRIMARY guarantee:
   *  it catches every real model switch, because register/unregister and
   *  every provider `onChange` fire all bump the generation. The
   *  provider-level `expectModelId` re-check inside `handle()` (task 3) is
   *  a BACKSTOP for the one case this can't cover — a provider whose model
   *  drifts without calling `onChange` (an onChange-coverage bug) — not a
   *  second, independent closer of the same race; see `describedAt` above
   *  for how that backstop is kept reachable. */
  const checkGeneration = (
    p: InferenceProvider,
    kind: 'complete' | 'see' | 'read' | 'hear',
    expected: number | undefined,
  ): void => {
    if (expected === undefined || expected === generation) return;
    throw new ModelChangedError(
      expected,
      generation,
      modelIdOf(p, kind),
      'generation',
    );
  };

  /** Runs `attempt` on the provider `pick(kind, task)` resolves. When that
   *  is a REMOTE provider and it fails — "not now" (RemoteUnavailableError)
   *  or anything else, since a remote failure never has a local meaning —
   *  the call is retried exactly once on the local order, as if it had no
   *  task, after re-checking the lane. The plane's own fences
   *  (ModelChangedError, LaneClosedError) propagate. A local failure is
   *  never retried anywhere. */
  const withLocalFallback = async <T>(
    kind: 'complete' | 'see',
    task: string | undefined,
    lane: Lane,
    attempt: (p: InferenceProvider, task: string | undefined) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const p = pick(kind, task);
    try {
      return await attempt(p, task);
    } catch (err) {
      const name = (err as Error)?.name;
      if (
        !p.remote ||
        name === 'ModelChangedError' ||
        name === 'LaneClosedError' ||
        name === 'AbortError'
      ) {
        throw err;
      }
      const waited = gate(lane, signal);
      if (waited) await waited;
      logs.log(
        'inference',
        'info',
        `${p.id} can't serve ${task ?? kind} now — answering locally`,
      );
      return attempt(pick(kind), undefined);
    }
  };

  const completeWithMeta: InferencePlane['completeWithMeta'] = async (
    prompt,
    opts,
  ) => {
    const lane = opts?.lane ?? 'interactive';
    const waited = gate(lane, opts?.signal);
    if (waited) await waited;
    const profile: CompletionProfile = opts?.profile ?? 'default';
    return withLocalFallback(
      'complete',
      opts?.task,
      lane,
      async (p, task) => {
        checkGeneration(p, 'complete', opts?.generation);
        const modelId = modelIdOf(p, 'complete');
        // `expectModelId`: when the caller passed a `generation`, prefer the
        // FIRST-WRITE-WINS value some `describe('complete')` call recorded for
        // the current generation (`describedAt`) over the fresh `modelId` just
        // computed above — as long as a record actually exists and its
        // generation still matches the one the caller passed (it always will
        // once `checkGeneration` has passed AND an entry exists, per
        // `describedAt`'s clear-on-bump invariant; the fallback only matters
        // when a caller passes a `generation` nothing ever recorded, e.g. one
        // it never actually got from `describe()`). Recomputing fresh here
        // would make this field always equal what `handle()` itself resolves
        // moments later (see `describedAt`'s comment) — forwarding the
        // RECORDED value is what keeps the provider's own re-check meaningful.
        const recorded = describedAt.get(describedKey('complete', task));
        // Only a record made for THIS provider: a routed task that ends up
        // local never carries the remote's model id into the local check.
        const expectModelId =
          opts?.generation !== undefined
            ? recorded?.generation === opts.generation &&
              recorded.providerId === p.id
              ? recorded.modelId
              : modelId
            : undefined;
        const raw = await tracked(p, 'complete', task, () =>
          p.handle({
            kind: 'complete',
            payload: {
              prompt,
              maxTokens: opts?.maxTokens,
              profile,
              system: opts?.system,
              generation: opts?.generation,
              expectModelId,
              task: opts?.task,
              budgetKey: opts?.budgetKey,
              schema: opts?.schema,
              grammar: opts?.grammar,
              topLogprobs: opts?.topLogprobs,
            },
            lane,
          }),
        );
        const normalized = normalizeCompletion(raw);
        return {
          text: normalized.text,
          providerId: p.id,
          // A remote provider learns its model from the call itself.
          modelId: p.remote ? modelIdOf(p, 'complete') : modelId,
          generation,
          profile,
          promptTokens: normalized.promptTokens,
          completionTokens: normalized.completionTokens,
          truncated: normalized.truncated,
          ...(normalized.firstTokens
            ? { firstTokens: normalized.firstTokens }
            : {}),
        };
      },
      opts?.signal,
    );
  };

  const seeWithMeta: InferencePlane['seeWithMeta'] = async (
    image,
    prompt,
    opts,
  ) => {
    const lane = opts?.lane ?? 'interactive';
    const waited = gate(lane, opts?.signal);
    if (waited) await waited;
    return withLocalFallback(
      'see',
      opts?.task,
      lane,
      async (p, task) => {
        const modelId = modelIdOf(p, 'see');
        const out = await tracked(p, 'see', task, () =>
          p.handle({
            kind: 'see',
            payload: {
              image,
              prompt,
              mime: opts?.mime,
              task: opts?.task,
              budgetKey: opts?.budgetKey,
            },
            lane,
          }),
        );
        return {
          text: String(out),
          providerId: p.id,
          modelId: p.remote ? modelIdOf(p, 'see') : modelId,
        };
      },
      opts?.signal,
    );
  };

  return {
    activeCalls,
    async complete(prompt, opts) {
      const meta = await completeWithMeta(prompt, opts);
      return meta.text;
    },
    completeWithMeta,
    async describe(kind, task) {
      let p: InferenceProvider;
      try {
        p = pick(kind, task);
      } catch (err) {
        if (err instanceof NoProviderError) return null;
        throw err;
      }
      const modelId = modelIdOf(p, kind);
      // First-write-wins per generation (see describedAt's doc comment):
      // the map only ever holds CURRENT-generation entries (bump()
      // clears it), so "already has this kind" means an EARLIER caller
      // already recorded one this generation — keep it. The RETURN value
      // below is unaffected: this caller still gets the live,
      // freshly-resolved modelId regardless of who wrote first.
      const key = describedKey(kind, task);
      if (!describedAt.has(key)) {
        describedAt.set(key, { generation, modelId, providerId: p.id });
      }
      return { providerId: p.id, modelId, generation };
    },
    generation: () => generation,
    async see(image, prompt, opts) {
      return (await seeWithMeta(image, prompt, opts)).text;
    },
    seeWithMeta,
    async read(image, opts) {
      const lane = opts?.lane ?? 'interactive';
      const waited = gate(lane, opts?.signal);
      if (waited) await waited;
      const p = pick('read');
      const out = await tracked(p, 'read', undefined, () =>
        p.handle({
          kind: 'read',
          payload: { image, mime: opts?.mime },
          lane,
        }),
      );
      return String(out);
    },
    async hear(audio, opts) {
      const lane = opts?.lane ?? 'interactive';
      const waited = gate(lane, opts?.signal);
      if (waited) await waited;
      const p = pick('hear');
      const out = await p.handle({
        kind: 'hear',
        payload: {
          audio,
          format: opts?.format,
          timestamps: opts?.timestamps,
          vad: opts?.vad,
          language: opts?.language,
          detectLanguage: opts?.detectLanguage,
          model: opts?.model,
        },
        lane,
      });
      return String(out);
    },
    mayBecomeReady(kind) {
      return providers.some((p) => {
        if (p.remote || !p.supports.includes(kind)) return false;
        const st = p.status();
        return (
          (typeof st === 'object' && 'downloading' in st) ||
          p.mayBecomeReady?.() === true
        );
      });
    },
    register(provider) {
      // No caller can hold a valid `describe()` generation before ANY
      // provider exists (describe() resolves null with an empty plane), so
      // the very first registration has nothing to invalidate and does not
      // bump. Every registration after that — and every unregister — is a
      // real change to what a held generation might now resolve to.
      const hadAny = providers.length > 0;
      providers.push(provider);
      logs.log('inference', 'info', `provider registered: ${provider.id}`);
      if (hadAny) bump();
      const offChange = provider.onChange?.(bump);
      return () => {
        const i = providers.indexOf(provider);
        if (i >= 0) providers.splice(i, 1);
        offChange?.();
        for (const [task, id] of routeTable) {
          if (id === provider.id) routeTable.delete(task);
        }
        bump();
      };
    },
    providers: () => [...providers],
    setRoute(task, providerId) {
      if ((routeTable.get(task) ?? null) === providerId) return;
      // No bump: a route decides only which provider serves its task;
      // pinned callers are fenced per provider (describedAt.providerId),
      // so a flip must not fail unrelated in-flight work.
      if (providerId === null) routeTable.delete(task);
      else routeTable.set(task, providerId);
    },
    routes: () =>
      [...routeTable].map(([task, id]) => {
        const p = providers.find((x) => x.id === id);
        return {
          task,
          providerName: p?.name ?? id,
          remote: p ? p.remote === true : true,
        };
      }),
    setLanePolicy(fn) {
      lanePolicy = fn;
    },
    setForegroundIdle(fn) {
      foregroundIdle = fn;
    },
  };
}
