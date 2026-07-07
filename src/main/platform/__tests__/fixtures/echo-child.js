// Plain-CJS echo child for transport tests — no build step needed.
process.on('message', (m) => {
  if (m && m.kind === 'ping') process.send({ kind: 'pong', n: m.n + 1 });
  if (m && m.kind === 'quit') process.exit(0);
});
