// Plain-CJS echo child for transport tests — no build step needed.
process.on('message', (m) => {
  if (m && m.kind === 'ping') process.send({ kind: 'pong', n: m.n + 1 });
  // Echoes an arbitrary plain-data message back verbatim — used to prove a
  // { kind: 'event', name, payload, meta } message round-trips unchanged
  // through `serialization: 'advanced'` (no class identity, no methods).
  if (m && m.kind === 'echo') process.send({ kind: 'echoed', received: m });
  if (m && m.kind === 'quit') process.exit(0);
});
