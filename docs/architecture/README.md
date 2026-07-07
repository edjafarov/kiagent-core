# Architecture

kia is a **local-first personal-data platform**: it continuously pulls your documents
(email, files, chats…) into one local SQLite corpus, enriches them with *local* AI
(OCR, vision), and exposes them to you (UI) and to your AI assistants (MCP).
Nothing leaves the machine.

## The big picture

```mermaid
flowchart TB
    UI["Renderer / UI<br/>(thin display client)"]
    AI["External AI clients<br/>(Claude Desktop, Cursor…)"]

    subgraph MAIN["Main process — trusted, owns all state"]
        ENG["Engine<br/>pull · commit · retry"]
        STORE[("Store<br/>SQLite · FTS5 · change feed")]
        WRK["Workers<br/>(vision OCR/VLM)"]
        INF["Inference plane<br/>local models only"]
        MCP["MCP server<br/>stdio + HTTP"]
        PLAT["Extension platform<br/>caps · gate · marketplace"]
    end

    subgraph SRC["Data sources"]
        BUILTIN["Built-in: gmail · imap · local-folder"]
        EXTP["Extensions — one untrusted<br/>process each"]
    end

    UI <-->|IPC: invoke + pushed state| MAIN
    AI <-->|MCP| MCP
    BUILTIN --> ENG
    EXTP -.cap-gated RPC.-> PLAT --> ENG
    ENG <--> STORE
    STORE -->|feed| WRK <--> INF
    MCP --> STORE
```

Three process kinds:

| Process | Trust | Owns |
|---|---|---|
| **Main** | trusted | store, engine, scheduler, vault, inference, MCP, all enforcement |
| **Renderer** | sandboxed | display only — invokes commands, consumes one pushed state projection |
| **Extension hosts** | untrusted | one `utilityProcess` per extension; every host call re-checked main-side |

(Plus short-lived helpers: the `mcpStdio` sibling process and the `llama-server` child.)

## The ideas that shape everything

1. **One write primitive.** `Store.commit()` lands documents + cursor + status in a single
   transaction. Sources can crash anywhere; "cursor saved but data lost" cannot be written.
2. **The change feed is the integration bus.** Every commit appends a change; workers and the
   UI projection are just durable feed consumers with their own cursors. At-least-once,
   idempotent by content-hash.
3. **Everything is a plugin — built-ins included.** Gmail and the vision worker implement the
   same `Source`/`Worker`/`InferenceProvider` contracts (`src/shared/contracts.ts`) that
   extensions do. The contract file *is* the SDK.
4. **Capability-shaped trust.** Extensions run out-of-process and get a host object whose shape
   equals their granted caps; the main-side gate re-checks every call (`CAP_DENIED` + audit).
5. **Local inference only.** OCR/VLM/LLM run on-device (Apple Vision, llama.cpp); background
   work is gated by a battery/thermal-aware scheduler — the only timer authority in the app.
6. **The renderer knows nothing.** One pushed `AppState` projection, three push channels total,
   every effect an `invoke`.

## Read next

| Doc | Covers |
|---|---|
| [app-shell.md](app-shell.md) | Electron process model, IPC, renderer state, boot sequence |
| [data-pipeline.md](data-pipeline.md) | Sources → engine → store → workers → inference |
| [storage.md](storage.md) | SQLite schema, change feed, FTS, vault, invariants |
| [extension-platform.md](extension-platform.md) | Caps, the gate, extension lifecycle, marketplace |
| [mcp.md](mcp.md) | How AI clients connect; built-in + extension tools |

Deeper design history lives in [`docs/superpowers/specs/`](../superpowers/specs/) and
[`docs/rebuild/`](../rebuild/) (including `LEFTOVERS.md` — known gaps, all deliberate).
