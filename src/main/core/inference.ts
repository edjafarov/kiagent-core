import {
  ModelChangedError,
  type Inference,
  type InferenceProvider,
  type Lane,
} from '@shared/contracts';

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
}

export interface InferencePlane extends Inference {
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
    },
  ): Promise<CompletionMeta>;
  /** Resolves the provider that WOULD answer `kind` right now, exactly as
   *  the call path's `pick(kind)` does, and reports its model identity plus
   *  the plane's current generation — so a caller can compute a cache key
   *  BEFORE calling, and later pass the generation back to `complete`/
   *  `completeWithMeta` to be rejected if the model changed underneath it.
   *  `null` when no ready provider supports the kind; never throws. */
  describe(kind: 'complete' | 'see' | 'read' | 'hear'): Promise<{
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
  /** Scheduler-controlled: false closes the background lane (battery, user
   *  active, outside the processing window) — background requests then fail
   *  fast with LaneClosedError. Interactive always flows. */
  setBackgroundOpen(open: boolean): void;
  /** Fires on every REAL flip of the boolean the plane owns (never on a
   *  no-op setBackgroundOpen call with the same value). The plane knows
   *  nothing about prefs, so it reports only its own boolean — resolving
   *  that into a `LaneState` (and telling 'battery' from 'disabled' from
   *  'until-night' etc.) happens above it, in the extension platform, via
   *  the injected `laneState()` resolver. */
  onLaneChange(cb: (open: boolean) => void): () => void;
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

/** Normalizes a provider's `complete` result: every provider today returns
 *  a plain string, so it maps to usage-less meta; a provider that opts into
 *  the richer shape (task 3's local provider) is passed through as-is. */
function normalizeCompletion(raw: unknown): {
  text: string;
  promptTokens: number | null;
  completionTokens: number | null;
  truncated: boolean;
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
  };
  // Preserve the old String(out) coercion as a fallback: a provider that
  // returns a non-string, non-`{text}` shape still yields SOME text rather
  // than `undefined`.
  return {
    text: typeof r.text === 'string' ? r.text : String(raw),
    promptTokens: r.promptTokens ?? null,
    completionTokens: r.completionTokens ?? null,
    truncated: r.truncated ?? false,
  };
}

/**
 * ONE front door to models. Requests route to the first ready provider that
 * supports the kind; background requests flow only while the scheduler holds
 * the lane open, and throw LaneClosedError otherwise.
 */
export function createInference(
  logs: LogSink,
  config?: { generationSeed?: number },
): InferencePlane {
  const providers: InferenceProvider[] = [];
  let backgroundOpen = true;
  const laneSubs = new Set<(open: boolean) => void>();

  // Random start so a process restart is a new generation by construction —
  // nothing persists it across boots. Seed is injectable so tests are
  // deterministic; never use a fixed default in production.
  let generation =
    config?.generationSeed ?? 1 + Math.floor(Math.random() * 1_000_000);
  const bump = (): void => {
    generation += 1;
  };

  const gate = (lane: Lane): void => {
    if (lane !== 'interactive' && !backgroundOpen) throw new LaneClosedError();
  };

  const pick = (
    kind: 'complete' | 'see' | 'read' | 'hear',
  ): InferenceProvider => {
    const p = providers.find(
      (x) => x.supports.includes(kind) && x.status() === 'ready',
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

  /** What `describe(kind)` last told a caller: the generation it reported,
   *  and the modelId it resolved AT THAT MOMENT. `completeWithMeta` threads
   *  the recorded value forward as `payload.expectModelId` (fix round,
   *  post-review) instead of recomputing a fresh `modelIdOf(p, kind)` at
   *  call time — recomputing fresh made the provider-side check in
   *  `handle()` structurally unreachable, since both reads happened
   *  synchronously in the same JS turn with nothing able to mutate state
   *  in between. Threading the RECORDED value means the provider's own
   *  check compares "what the caller saw at describe() time" against "what
   *  handle() resolves now" — the actual guarantee issue #107 asks for. */
  const describedAt = new Map<
    'complete' | 'see' | 'read' | 'hear',
    { generation: number; modelId: string }
  >();

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
    throw new ModelChangedError(expected, generation, modelIdOf(p, kind));
  };

  const completeWithMeta: InferencePlane['completeWithMeta'] = async (
    prompt,
    opts,
  ) => {
    const lane = opts?.lane ?? 'interactive';
    gate(lane);
    const p = pick('complete');
    checkGeneration(p, 'complete', opts?.generation);
    const modelId = modelIdOf(p, 'complete');
    const profile: CompletionProfile = opts?.profile ?? 'default';
    // `expectModelId`: when the caller passed a `generation`, prefer what
    // THEIR OWN `describe()` call recorded (`describedAt`) over the fresh
    // `modelId` just computed above — as long as that record's generation
    // still matches the one they passed (defensive: it should always match
    // once `checkGeneration` has passed, but a caller could pass a
    // `generation` it never actually got from `describe()`). Recomputing
    // fresh here would make this field always equal what `handle()` itself
    // resolves moments later (see `describedAt`'s comment) — forwarding the
    // RECORDED value is what keeps the provider's own re-check meaningful.
    const recorded = describedAt.get('complete');
    const expectModelId =
      opts?.generation !== undefined
        ? recorded?.generation === opts.generation
          ? recorded.modelId
          : modelId
        : undefined;
    const raw = await p.handle({
      kind: 'complete',
      payload: {
        prompt,
        maxTokens: opts?.maxTokens,
        profile,
        system: opts?.system,
        generation: opts?.generation,
        expectModelId,
      },
      lane,
    });
    const normalized = normalizeCompletion(raw);
    return {
      text: normalized.text,
      providerId: p.id,
      modelId,
      generation,
      profile,
      promptTokens: normalized.promptTokens,
      completionTokens: normalized.completionTokens,
      truncated: normalized.truncated,
    };
  };

  return {
    async complete(prompt, opts) {
      const meta = await completeWithMeta(prompt, opts);
      return meta.text;
    },
    completeWithMeta,
    async describe(kind) {
      let p: InferenceProvider;
      try {
        p = pick(kind);
      } catch (err) {
        if (err instanceof NoProviderError) return null;
        throw err;
      }
      const modelId = modelIdOf(p, kind);
      describedAt.set(kind, { generation, modelId });
      return { providerId: p.id, modelId, generation };
    },
    generation: () => generation,
    async see(image, prompt, opts) {
      const lane = opts?.lane ?? 'interactive';
      gate(lane);
      const p = pick('see');
      const out = await p.handle({
        kind: 'see',
        payload: { image, prompt, mime: opts?.mime },
        lane,
      });
      return String(out);
    },
    async read(image, opts) {
      const lane = opts?.lane ?? 'interactive';
      gate(lane);
      const p = pick('read');
      const out = await p.handle({
        kind: 'read',
        payload: { image, mime: opts?.mime },
        lane,
      });
      return String(out);
    },
    async hear(audio, opts) {
      const lane = opts?.lane ?? 'interactive';
      gate(lane);
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
        bump();
      };
    },
    providers: () => [...providers],
    setBackgroundOpen(open) {
      if (open === backgroundOpen) return;
      backgroundOpen = open;
      laneSubs.forEach((cb) => cb(open));
    },
    onLaneChange(cb) {
      laneSubs.add(cb);
      return () => {
        laneSubs.delete(cb);
      };
    },
  };
}
