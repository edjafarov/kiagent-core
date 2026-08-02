# Headless / server runtime

How much of this core can run without Electron — on a Linux server, in a
container — and what has to be built to get there.

The motivating use case is a **user-deployed node**: the owner installs kiagent
on a machine they control so it keeps syncing while their laptop is shut, and
serves MCP to remote AI clients. The product-level design (deployment flow,
sealed boot, reachability tiers, the data-protection argument) lives in
`alpha-cent`'s `docs/superpowers/specs/2026-08-02-self-hosted-node-design.md`.
This doc is the engine half: what is portable already, what is coupled, and how
each coupling gets cut.

## Where we start: the engine is already Electron-free

Every directory that ingests, stores, enriches, or serves is plain Node. Zero
`from 'electron'` imports in:

```
src/main/core/      engine · store · scheduler · inference plane · prefs · logs
src/main/db/        app-db · worker-client · worker-entry (worker_threads)
src/main/sources/   gmail · imap · ms365 · local-folder
src/main/providers/ local-llm (llama.cpp child) · apple-vision
src/main/mcp/       stdio entry · outbound proxy
src/main/platform/  extension host, gate, caps  — one exception, below
```

Two existing pieces prove the shape works in practice:

- **`src/main/mcp/stdio-entry.ts`** already runs as a standalone Node process
  with no window, no single-instance lock, opening the same corpus by path. It
  is a headless kiagent that happens to only read.
- **`src/main/core/mcp/clients.ts:53`** computes the `app.getPath('appData')`
  equivalent without Electron, with a comment saying exactly why: "`core/` stays
  Electron-free". That convention is what makes this doc short.

So the work is not "port the engine". It is "write a second shell", where the
first shell is `src/main/main.ts`.

## What the Electron shell supplies

`main.ts` builds four things and hands them to `core/boot.ts`
(`BootDeps`, `src/main/core/boot.ts:36`). A headless shell must supply the same
four:

| `BootDeps` | Desktop implementation | Headless implementation |
|---|---|---|
| `dataDir` | `path.join(app.getPath('userData'), 'data')` (`main.ts:388`) | `KIAGENT_USER_DATA` — already honored at `main.ts:90` — else XDG `$XDG_DATA_HOME/kiagent` |
| `encrypt` / `decrypt` | `safeStorage` with a dev fallback (`main.ts:154`) | libsodium secretbox under a key held in memory only — see [Keyring](#keyring) |
| `env()` | `powerMonitor` battery/thermal + window focus (`main.ts:130`) | Constant: `onBattery: false`, `thermal: 'nominal'`, `appFocus: 'hidden'`, `userActive: false` — see [Scheduler](#scheduler) |
| `dbWorkerFile` | bundled `dbWorker` entry | same file, same `worker_threads` host — no change |

Beyond `BootDeps` the shell also owns the extension-host transport, the tray/UI,
IPC, and the updater. Only the first matters headless.

### Extension host transport

`src/main/platform/transport.ts` is the one file under `platform/` that touches
Electron, and it already carries both halves:

- `utilityProcessTransport` (line 105) lazily `require('electron')` — desktop.
- `fork` from `child_process` is imported at the top and used by the in-memory /
  fork transports the tests run against.

And the child side already adapts: `extension-host-entry.ts:456` is a
"utilityProcess (`parentPort`) vs node fork (`process.send`) adapter". Extensions
therefore run out-of-process under plain Node today — that path is exercised by
the test suite on every run. Headless needs a `forkHostTransport` wired into the
shell, not a new isolation model.

### Keyring

Today `encrypt`/`decrypt` protect **source credentials only** — the corpus
itself is plaintext SQLite. On a laptop with FileVault/BitLocker that is
defensible. On a rented server it is not: the host operator can read the disk.

Server mode therefore needs two layers:

1. **Volume encryption** for the corpus (LUKS below the container, or SQLCipher
   inside it where the volume is not the owner's to control).
2. **A keyring** for credentials, derived (Argon2id) from the same unseal secret
   and never written to disk.

Both keys arrive at boot from the owner's machine and live in memory. The node
starts *sealed*: no database open, no sync, one loopback endpoint waiting for the
unseal. A reboot re-seals. This is the property that makes "self-hosted" mean
something stronger than "the disk is somewhere else" — without it, a snapshot of
the volume is a copy of the corpus.

### Scheduler

`SchedulerEnv` (`src/shared/contracts.ts:932`) exists to keep a laptop cool and
its battery alive. A server has neither constraint, and no window to be focused.
Pinning the four fields to constants opens the background lanes permanently,
which is the desired behavior — but it also means the thermal/battery brakes are
gone, so server mode should grow its own throttle (concurrency and nice level)
rather than inheriting an unbounded one.

### Inference

`llama-server` runs headless without change. What changes is the economics: on a
CPU-only VPS, VLM description and OCR are slow enough to be effectively
unavailable. Server mode should:

- default the deep-extraction lane **off**, with clear UI as to why;
- allow pointing the inference plane at an endpoint the owner controls (their own
  GPU box, or an instance they rent);
- **never** silently fall back to a hosted model. Doing so would move corpus
  content off the node, which is the one thing the whole deployment exists to
  prevent. The fallback must be an error, not a downgrade.

### UI

Serve the existing renderer from the node, bound to loopback, reached over the
owner's SSH tunnel or private network. The renderer is already a thin display
client over `invoke` + three push channels (`docs/architecture/app-shell.md`),
so the transport underneath it can be an HTTP/WebSocket bridge without the
screens knowing. It must not be exposed publicly, even behind auth — a public
admin surface on a box holding a mail corpus is the most likely way one of these
nodes gets compromised.

## Shape of the headless entry

```
src/main/headless/
  entry.ts          arg/env parsing, sealed-boot state machine, signal handling
  paths.ts          KIAGENT_USER_DATA → XDG → default
  keyring.ts        Argon2id derivation + secretbox; encrypt/decrypt for BootDeps
  env.ts            constant SchedulerEnv + server-side concurrency throttle
  transport.ts      forkHostTransport (child_process) for extension hosts
  admin.ts          loopback HTTP bridge for the renderer + health + unseal
```

`main.ts` and `headless/entry.ts` become two shells over one `boot()`. The rule
that keeps them from drifting is the one already in force: anything below
`core/`, `db/`, `sources/`, `providers/`, `platform/` stays Electron-free, and
the two shells differ only in the four `BootDeps` and the host transport.

## Packaging

An OCI image built from this repo (`kiagent-node`), reproducible, published with
its digest and signature. The node is pinned to a digest by the owner and updated
only when the owner triggers it — there is no push channel from us into a node
someone else runs. `npm run package:oss` already produces an unbranded build; the
image is the same idea with a different entry point.

## Non-goals here

- The deployment mechanics (SSH driver, cloud-init, firewall baseline, hoster
  APIs) — those belong to the product repo, not the core.
- Multi-user nodes. The access model is single-owner throughout; a shared node
  needs per-user separation and per-user audit, which is a separate design.
- Retiring the desktop app. This is a second shell, not a replacement.
