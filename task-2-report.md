# Task 2 report

## Round 4 RED — fresh implementer

Workspace: `/private/tmp/kiagent-core-shared-db`

Base: `1a3007f7`

Command run before adding regression coverage:

```sh
/Users/edjafarov/.nvm/versions/node/v24.19.0/bin/node node_modules/jest/bin/jest.js --config /private/tmp/shared-infra-db-jest.cjs --runInBand src/main/db/__tests__/db-coordinator.test.ts src/main/db/__tests__/plugin-connections.test.ts src/main/db/__tests__/worker-client-plugin.test.ts src/main/db/__tests__/db-bridge.test.ts src/main/db/__tests__/plugin-worker.test.ts
```

Result: **PASS**, 5 suites, 23 tests.

Added production-path regressions in `src/main/db/__tests__/plugin-worker.test.ts`:

- A real scoped plugin connection inserts an invalid child under `DEFERRABLE INITIALLY DEFERRED`, queues a core write, and observes the rejected COMMIT and post-cleanup owner outcome.
- A real mapped connection has rollback failure injected at the wrapper boundary while its native transaction is open; the production cleanup callback removes and closes it before a queued foreign plugin write. The test verifies the map removal, closed wrapper, and foreign write.

RED command:

```sh
/Users/edjafarov/.nvm/versions/node/v24.19.0/bin/node node_modules/jest/bin/jest.js --config /private/tmp/shared-infra-db-jest.cjs --runInBand src/main/db/__tests__/plugin-worker.test.ts
```

Result: **FAIL**, 1 expected regression and 3 passing tests. The lease-expiry close regression passes. The deferred-FK regression reaches the real COMMIT failure and then fails because a subsequent fresh transaction returns `ERR_SQLITE_ERROR`; the current native connection remains active after the coordinator has released ownership. This is the corrected source explanation from the round-4 brief: the existing `control(...); inTransaction = false` sequence does not clear the JS flag when `control` throws. The unresolved failure is coordinator/SQLite cleanup and admission ordering after COMMIT rejection, not merely a JS flag toggle.

No production implementation changes were made in this round. Typecheck and GREEN runs are intentionally deferred to the implementation worker after the RED slot is released.

## Round 4 implementation handoff

Production changes prepared without running tests (the GREEN slot has not been granted):

- Coordinator ownership remains active while failed COMMIT/BEGIN/release/expiry cleanup runs. A failed explicit finish invokes the transaction rollback callback before foreign work is pumped; rollback failure poisons the owner and invokes the owner close callback before admission resumes.
- Added the shared `closePluginConnectionForOwner` cleanup helper and wired the worker to remove and close the actual mapped native connection. Plugin connection close is idempotent.
- `schemaExec` now rejects while an explicit plugin transaction is active.

The prior RED test assertion must accept the repaired successful fresh transaction outcome (or the terminal poisoned/removed outcome when rollback itself fails) during the next GREEN slot. No test, typecheck, install, rebuild, live-profile, stash, or registry work was run in this implementation handoff.
