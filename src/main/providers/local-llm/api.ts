/**
 * Minimal client for OpenAI-compatible llama-server endpoint.
 * One image in, one description out. No retries — the drain loop owns the
 * attempts ledger.
 */

import { ContextOverflowError } from '@shared/contracts';

const DEFAULT_TIMEOUT_MS = 180_000;

// Low temperature: descriptions feed the FTS index; we want deterministic,
// repeatable output, not creative variation.
const VLM_TEMPERATURE = 0.1;

// 1500 tokens leaves room for a fuller retrieval description while still
// discouraging wholesale verbatim transcription (OCR's job).
const VLM_MAX_TOKENS = 1500;

// Thinking-enabled chat templates (gemma's thinking=1) fill max_tokens with
// reasoning_content before any visible content — a bounded-budget call can
// finish with content empty. Every consumer here wants the answer, not the
// deliberation; llama-server ignores the kwarg on templates without a
// thinking branch. (reasoning_effort / reasoning_budget do not disable it.)
const CHAT_TEMPLATE_KWARGS = { enable_thinking: false };

export type ChatProfile = 'default' | 'deterministic';

/** Classification-style callers need reproducible output; this is the
 *  deliberate ceiling (spec D1) on how much of that a single deterministic
 *  request may generate. Not configurable, not silently clamped — a caller
 *  that asks for more is rejected before the request reaches the model. */
export const DETERMINISTIC_MAX_TOKENS = 512;

export interface ChatResult {
  text: string;
  promptTokens: number | null;
  completionTokens: number | null;
  truncated: boolean;
  /** top_logprobs of the first generated token, when requested. */
  firstTokens?: { token: string; logprob: number }[];
}

/** Resolves a profile into the request fields that control decoding.
 *  `default` is exactly today's hardcoded behaviour (temperature 0.1, the
 *  existing max-tokens default) — untouched so every existing caller keeps
 *  today's output. `deterministic` requires an integer `maxTokens` capped at
 *  `DETERMINISTIC_MAX_TOKENS`; a missing, non-integer, or too-large value is
 *  rejected here, before any network call is made. */
const profileBody = (
  profile: ChatProfile,
  maxTokens?: number,
): Record<string, unknown> => {
  if (profile === 'default') {
    return {
      temperature: VLM_TEMPERATURE,
      max_tokens: maxTokens ?? VLM_MAX_TOKENS,
    };
  }
  if (
    typeof maxTokens !== 'number' ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1
  ) {
    throw new Error(
      "the 'deterministic' profile requires an integer maxTokens",
    );
  }
  if (maxTokens > DETERMINISTIC_MAX_TOKENS) {
    throw new Error(
      `the 'deterministic' profile caps maxTokens at ${DETERMINISTIC_MAX_TOKENS} (got ${maxTokens})`,
    );
  }
  return {
    temperature: 0,
    top_k: 1,
    top_p: 1,
    seed: 0,
    n: 1,
    max_tokens: maxTokens,
  };
};

/** llama-server's error for a failed chat request. Both ways a request can
 *  outgrow the context become `ContextOverflowError`: one request larger
 *  than the context (HTTP 400, `exceed_context_size_error`, at once) and the
 *  shared KV cache exhausted by concurrent requests (HTTP 500, "Context size
 *  has been exceeded.", after the server waited for room). */
async function chatError(res: Response): Promise<Error> {
  let error: { type?: unknown; message?: unknown } | undefined;
  try {
    error = ((await res.json()) as { error?: typeof error }).error;
  } catch {
    error = undefined;
  }
  const message = typeof error?.message === 'string' ? error.message : '';
  if (
    error?.type === 'exceed_context_size_error' ||
    /context size has been exceeded/i.test(message)
  ) {
    return new ContextOverflowError(
      `chat request exceeds the model context: ${message || `HTTP ${res.status}`}`,
    );
  }
  return new Error(
    `chat request failed: HTTP ${res.status}${message ? ` (${message.slice(0, 200)})` : ''}`,
  );
}

export async function chatText(
  baseUrl: string,
  prompt: string,
  opts?: {
    maxTokens?: number;
    profile?: ChatProfile;
    system?: string;
    /** JSON Schema the reply must match (llama-server compiles it to a
     *  grammar). Dropped silently by the server when it can't compile it. */
    schema?: Record<string, unknown>;
    /** GBNF grammar constraining decoding. Exclusive with `schema`. */
    grammar?: string;
    /** Return the top-N alternatives of the first generated token. */
    topLogprobs?: number;
  },
): Promise<ChatResult> {
  if (opts?.grammar && opts?.schema) {
    throw new Error('grammar and schema are mutually exclusive');
  }
  // Resolved (and, for `deterministic`, validated) BEFORE the AbortController
  // and the request are built — a too-large maxTokens must never reach the
  // model.
  const body = profileBody(opts?.profile ?? 'default', opts?.maxTokens);
  // Probe 2026-10-08 (10 signature fixtures, Gemma 4 E4B b9585): adding
  // top_k:1/top_p:1 moved first-token probabilities by up to 0.016. Callers
  // that read confidence from logprobs get the unfiltered distribution.
  if (opts?.topLogprobs) {
    delete body.top_k;
    delete body.top_p;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const messages =
      opts?.system !== undefined
        ? [
            { role: 'system', content: [{ type: 'text', text: opts.system }] },
            { role: 'user', content: [{ type: 'text', text: prompt }] },
          ]
        : [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        ...body,
        chat_template_kwargs: CHAT_TEMPLATE_KWARGS,
        ...(opts?.schema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'out', schema: opts.schema },
              },
            }
          : {}),
        ...(opts?.grammar ? { grammar: opts.grammar } : {}),
        ...(opts?.topLogprobs
          ? { logprobs: true, top_logprobs: opts.topLogprobs }
          : {}),
        messages,
      }),
    });
    if (!res.ok) throw await chatError(res);
    const json = (await res.json()) as {
      choices?: {
        message?: { content?: string };
        finish_reason?: string;
        logprobs?: {
          content?: {
            top_logprobs?: { token: string; logprob: number }[];
          }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('chat returned empty content');
    return {
      text: content,
      promptTokens: json.usage?.prompt_tokens ?? null,
      completionTokens: json.usage?.completion_tokens ?? null,
      truncated: json.choices?.[0]?.finish_reason === 'length',
      ...(opts?.topLogprobs
        ? {
            firstTokens: (
              json.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs ?? []
            ).map((t) => ({ token: t.token, logprob: t.logprob })),
          }
        : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function describeImage(
  baseUrl: string,
  image: Uint8Array,
  prompt: string,
  opts?: { mime?: string },
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const base64Image = Buffer.from(image).toString('base64');
    // The contract threads the source mime down; label the data URL with it
    // so the server decodes the bytes as what they actually are (PDF pages
    // rasterize to PNG, so image/png remains the sensible fallback).
    const mime = opts?.mime ?? 'image/png';
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        temperature: VLM_TEMPERATURE,
        max_tokens: VLM_MAX_TOKENS,
        chat_template_kwargs: CHAT_TEMPLATE_KWARGS,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mime};base64,${base64Image}`,
                },
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`vlm request failed: HTTP ${res.status}`);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('vlm returned empty content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}
