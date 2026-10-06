/** The vision worker's identity, dependency-free so the stats handler and
 *  tests can derive its ledger consumer without importing the worker. */
export const VISION_WORKER = { name: 'vision', version: 1 } as const;
