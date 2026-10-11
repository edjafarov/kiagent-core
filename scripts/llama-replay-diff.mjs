// scripts/llama-replay-diff.mjs — dev tool for llama.cpp bumps (not shipped).
// Starts two llama-server binaries with the production chat args (server.ts
// launch()) and the same model, sends the request shapes the app depends on
// (plain chat, json_schema, GBNF + logprobs, thinking off, context overflow)
// and prints both answers side by side.
//
//   node scripts/llama-replay-diff.mjs --old <llama-server> --new <llama-server> \
//     --model <gguf> --mmproj <gguf>
import { spawn } from 'node:child_process';
import net from 'node:net';

const arg = (k) => {
  const i = process.argv.indexOf(`--${k}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${k}`);
  return process.argv[i + 1];
};
const binaries = { old: arg('old'), new: arg('new') };
const model = arg('model');
const mmproj = arg('mmproj');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function start(bin) {
  const port = await freePort();
  const child = spawn(
    bin,
    ['-m', model, '--mmproj', mmproj, '--host', '127.0.0.1', '--port', String(port),
      '-c', '24576', '-ngl', '999', '--cache-ram', '0', '--ctx-checkpoints', '4'],
    { stdio: 'ignore' },
  );
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`${url}/health`)).status === 200) return { child, url };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`${bin} did not become healthy`);
}

const deterministic = { temperature: 0, top_k: 1, top_p: 1, seed: 0, n: 1, max_tokens: 64 };
const user = (text) => [{ role: 'user', content: [{ type: 'text', text }] }];
const REQUESTS = {
  plain: { ...deterministic, chat_template_kwargs: { enable_thinking: false },
    messages: user('Name the capital of France in one word.') },
  schema: { ...deterministic, max_tokens: 256, chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { name: 'out', schema: {
      type: 'object', properties: { circle: { enum: ['work', 'personal'] } }, required: ['circle'] } } },
    messages: user('Ana from Acme Corp sent the Q3 invoice. Is this work or personal?') },
  grammar: { temperature: 0, seed: 0, n: 1, max_tokens: 4, logprobs: true, top_logprobs: 5,
    chat_template_kwargs: { enable_thinking: false }, grammar: 'root ::= "yes" | "no"',
    messages: user('Is "Lunch on Friday?" a personal message? Answer yes or no.') },
  overflow: { ...deterministic, chat_template_kwargs: { enable_thinking: false },
    messages: user('word '.repeat(30000)) },
};

async function run(url, body) {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { status: res.status, errorType: json?.error?.type ?? null };
  const c = json.choices?.[0];
  return {
    status: res.status,
    text: c?.message?.content?.trim(),
    top: c?.logprobs?.content?.[0]?.top_logprobs?.map((t) => `${t.token}:${t.logprob.toFixed(3)}`),
  };
}

const out = {};
for (const [name, bin] of Object.entries(binaries)) {
  const s = await start(bin);
  try {
    for (const [req, body] of Object.entries(REQUESTS)) {
      (out[req] ??= {})[name] = await run(s.url, body);
    }
  } finally {
    s.child.kill();
  }
}
for (const [req, r] of Object.entries(out)) {
  console.log(`\n== ${req}`);
  console.log(`  old: ${JSON.stringify(r.old)}`);
  console.log(`  new: ${JSON.stringify(r.new)}`);
}
