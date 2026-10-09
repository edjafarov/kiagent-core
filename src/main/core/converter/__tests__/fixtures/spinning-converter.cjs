// A converter child stuck in a synchronous loop (a parser that never
// returns): answers ready, then spins forever on its first request. Proves
// the main event loop keeps turning and the wall-clock timeout kills it.
process.on('disconnect', () => process.exit(0));
process.on('message', () => {
  for (;;) {
    /* spin */
  }
});
process.send({ t: 'ready' });
