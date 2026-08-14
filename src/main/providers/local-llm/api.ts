/**
 * Minimal client for OpenAI-compatible llama-server endpoint.
 * One image in, one description out. No retries — the drain loop owns the
 * attempts ledger.
 */

const DEFAULT_TIMEOUT_MS = 180_000;

// Low temperature: descriptions feed the FTS index; we want deterministic,
// repeatable output, not creative variation.
const VLM_TEMPERATURE = 0.1;

// 1500 tokens leaves room for a fuller retrieval description while still
// discouraging wholesale verbatim transcription (OCR's job).
const VLM_MAX_TOKENS = 1500;

export async function chatText(
  baseUrl: string,
  prompt: string,
  opts?: { maxTokens?: number },
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        temperature: VLM_TEMPERATURE,
        max_tokens: opts?.maxTokens ?? VLM_MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`chat request failed: HTTP ${res.status}`);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('chat returned empty content');
    return content;
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
