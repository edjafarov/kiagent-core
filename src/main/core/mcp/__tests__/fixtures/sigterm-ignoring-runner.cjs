// Test double for a runner child that cannot be stopped politely: says ready,
// then spins forever on the first request and ignores SIGTERM.
process.on('SIGTERM', () => {});
process.on('disconnect', () => process.exit(0));
process.on('message', () => {
  for (;;) {
    /* busy */
  }
});
process.send({ t: 'ready' });
