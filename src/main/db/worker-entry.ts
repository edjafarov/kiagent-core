/**
 * Entry point reserved for running the store off the main thread. better-
 * sqlite3 is synchronous; today the store runs in-process, which is fine for
 * the current commit sizes. Moving it here keeps large FTS transactions off
 * the event loop. Tracked in docs/rebuild/LEFTOVERS.md.
 */
export {};
