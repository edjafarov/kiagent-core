/**
 * The extension platform orchestrator — owns the per-extension state
 * machine (spec §3.3: disabled → activating → activated | needs-consent |
 * errored), glues installer → consent → host supervisor → SourceRegistry/
 * MCP registration, and projects ExtensionSnapshot[] into AppState via
 * onChange. All IPC handlers call methods here.
 */
import path from 'path';
import fs from 'fs';

import type {
  Cap,
  ConsentRecord,
  Credentials,
  ExtensionId,
  ExtensionSnapshot,
  ExtensionStatus,
  LogLevel,
  Manifest,
  McpTool,
  Source,
} from '@shared/contracts';
import type { ExtensionPreview } from '@shared/ipc';
import type { Contributions } from '@shared/extension-rpc';

import type { CoreStore } from '@main/core/store/store';
import type { CoreScheduler } from '@main/core/scheduler';
import type { SourceRegistry } from '@main/core/boot';
import type { LogSink } from '@main/core/engine/engine';
import type { OAuthProfile } from '@main/auth/oauth-window';

import {
  createInstaller,
  type InstallerDeps,
} from '@main/marketplace/installer';

import {
  loadIconDataUrl,
  oauthSourceBindings,
  sourceContributions,
} from './manifest';
import { oauthProviders } from './oauth-providers';
import {
  discoverExtensions,
  readEnabledState,
  readInstalled,
  writeEnabledState,
  writeInstalled,
  type InstalledRecord,
} from './extensions';
import { createExtensionHost } from './host-process';
import {
  buildSurfaces,
  createEventBus,
  type SurfaceDeps,
} from './host-surfaces';
import type { HostTransport } from './transport';

export interface ExtensionPlatformDeps {
  extDir: string;
  store: CoreStore;
  sources: SourceRegistry;
  scheduler: CoreScheduler;
  registerTool(tool: McpTool): () => void;
  inference: SurfaceDeps['inference'];
  logSink: LogSink;
  notify(msg: string, level?: LogLevel): void;
  transportFactory(extensionId: string): HostTransport;
  onChange(snapshot: ExtensionSnapshot[]): void;
  hostTimeouts?: { readyTimeoutMs?: number; activateTimeoutMs?: number };
  download?: InstallerDeps['download'];
  /** OAuth plumbing for `contributes.sources: [{ id, oauth: 'google' }]`:
   *  register/unregister mirror the connect broker's profile map, and
   *  `refreshers` must be the SAME Map instance the engine reads token
   *  refreshers from (CorePlatform.refreshers). Optional so a platform
   *  without connect wiring (some tests) still runs — an oauth contribution
   *  then logs a warning instead of registering. */
  oauth?: {
    registerProfile(sourceId: string, profile: OAuthProfile): void;
    unregisterProfile(sourceId: string): void;
    refreshers: Map<
      string,
      (creds: Credentials) => Promise<Credentials | null>
    >;
  };
}

interface Entry {
  manifest: Manifest;
  dir: string;
  entryAbsPath: string;
  record?: InstalledRecord;
  enabled: boolean;
  status: ExtensionStatus;
  error?: string;
  host: ReturnType<typeof createExtensionHost> | null;
  sourceIds: string[];
  /** Loaded once per Entry (dir contents only change through reinstall,
   *  which rebuilds the Entry) — snapshot() must stay cheap. */
  iconDataUrl?: string;
}

export interface ExtensionPlatform {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): ExtensionSnapshot[];
  installPreview(
    ref: string,
  ): Promise<ExtensionPreview | { ok: false; error: string }>;
  installCommit(
    token: string,
  ): Promise<{ ok: boolean; id?: string; error?: string }>;
  uninstall(id: string): Promise<{ ok: boolean; error?: string }>;
  setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }>;
  /**
   * Records fresh consent for an installed extension's ON-DISK manifest
   * (the Marketplace "Review permissions" action), then activates it.
   * Consent is always read from the manifest on disk — never from
   * renderer-supplied caps — so the renderer can only confirm, not grant,
   * whatever the manifest actually declares.
   */
  grantConsent(id: string): Promise<{ ok: boolean; error?: string }>;
}

export function createExtensionPlatform(
  deps: ExtensionPlatformDeps,
): ExtensionPlatform {
  const entries = new Map<string, Entry>();
  const bus = createEventBus();

  // Per-extension lifecycle serialization. Keyed on the extension id string
  // (NOT on an Entry object reference) so a composite op that replaces an
  // Entry (installCommit's deactivate-existing → build-new-Entry sequence)
  // still chains onto the SAME queue as any other op for that id — a
  // replaced Entry can never fork a second, independent chain.
  //
  // `runExclusive` chains `fn` onto whatever is queued for `id`, but the
  // chain link stored for the NEXT caller always settles (via the trailing
  // .then(ok, ok)) regardless of whether `fn` itself resolved or rejected —
  // so one op's failure can never wedge every later op on that id. The
  // caller of `runExclusive` still gets `fn`'s own outcome (resolution or
  // rejection) via the returned promise.
  const opChains = new Map<string, Promise<void>>();

  function runExclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = opChains.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    opChains.set(
      id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  const installer = createInstaller({
    extDir: deps.extDir,
    download: deps.download,
    sourceIdOwners: () => {
      const owners: Record<string, string> = {};
      for (const d of deps.sources.list()) owners[d.id] = 'builtin';
      for (const [id, e] of entries) {
        for (const { id: sid } of sourceContributions(e.manifest))
          owners[sid] = id;
      }
      return owners;
    },
  });

  const snapshot = (): ExtensionSnapshot[] =>
    [...entries.values()].map((e) => ({
      id: e.manifest.id,
      name: e.manifest.name,
      version: e.manifest.version,
      origin: e.record?.origin ?? 'dev',
      enabled: e.enabled,
      status: e.status,
      error: e.error,
      caps: e.manifest.caps as Cap[],
      sourceIds: sourceContributions(e.manifest).map((s) => s.id),
      oauthSources: oauthSourceBindings(e.manifest),
      iconDataUrl: e.iconDataUrl,
      ref: e.record?.ref,
    }));

  const changed = () => deps.onChange(snapshot());

  const setStatus = (e: Entry, status: ExtensionStatus, error?: string) => {
    e.status = status;
    e.error = error;
    changed();
  };

  async function consentCovers(manifest: Manifest): Promise<boolean> {
    const rec = await deps.store.consents.latest(manifest.id);
    return (
      rec !== null &&
      rec.manifestVersion === manifest.version &&
      manifest.caps.every((c) => rec.caps.includes(c))
    );
  }

  function registerContributions(
    e: Entry,
    c: Contributions,
    makeSource: (entry: Contributions['sources'][number]) => Source,
  ): () => void {
    const declared = new Map(
      sourceContributions(e.manifest).map((d) => [d.id, d]),
    );
    const registeredSources: string[] = [];
    const registeredOAuthSources: string[] = [];
    const toolDisposers: Array<() => void> = [];
    for (const s of c.sources) {
      const contribution = declared.get(s.descriptor.id);
      if (!contribution) {
        deps.logSink.log(
          `extension:${e.manifest.id}`,
          'warn',
          `source id '${s.descriptor.id}' is not declared in the manifest — skipping`,
        );
        continue;
      }
      const existing = deps.sources.get(s.descriptor.id);
      if (existing && !e.sourceIds.includes(s.descriptor.id)) {
        deps.logSink.log(
          `extension:${e.manifest.id}`,
          'warn',
          `source id '${s.descriptor.id}' already registered — skipping`,
        );
        continue;
      }
      deps.sources.register(makeSource(s));
      registeredSources.push(s.descriptor.id);
      if (contribution.oauth) {
        if (deps.oauth) {
          const provider = oauthProviders[contribution.oauth];
          deps.oauth.registerProfile(s.descriptor.id, provider.profile);
          deps.oauth.refreshers.set(s.descriptor.id, provider.refresher);
          registeredOAuthSources.push(s.descriptor.id);
        } else {
          deps.logSink.log(
            `extension:${e.manifest.id}`,
            'warn',
            `source '${s.descriptor.id}' declares oauth: '${contribution.oauth}' but this platform has no OAuth wiring — connect will fail`,
          );
        }
      }
    }
    e.sourceIds = registeredSources;
    for (const t of c.tools) {
      toolDisposers.push(
        deps.registerTool({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          tier: t.tier,
          call: (args) => e.host!.callTool(t.name, args),
        }),
      );
    }
    bus.emit('platform', 'extension.activated', { id: e.manifest.id });
    // This disposer runs on EVERY host exit — a deliberate deactivate() as
    // well as the supervisor's own CRASH cleanup — so it must only undo the
    // source-registry/tool registration, not stop cadence jobs: a crashed
    // extension respawns and re-registers its sources, and the surviving
    // cadence job's next engine.run should self-heal against them. Cadence
    // unregistration lives in deactivate() below instead, which only runs
    // for orchestrator-initiated deactivate/uninstall/disable.
    return () => {
      registeredSources.forEach((sid) => deps.sources.unregister(sid));
      // OAuth profile/refresher cleanup mirrors the source registrations
      // exactly (same disposer, same crash-respawn re-registration) — a
      // profile or refresher can never outlive its source registration, and
      // upgrade/reinstall re-registers fresh entries.
      registeredOAuthSources.forEach((sid) => {
        deps.oauth?.unregisterProfile(sid);
        deps.oauth?.refreshers.delete(sid);
      });
      toolDisposers.forEach((d) => d());
      bus.emit('platform', 'extension.deactivated', { id: e.manifest.id });
    };
  }

  /** Stops the scheduler cadence jobs for an extension's currently
   *  registered accounts. Called ONLY from deactivate() (orchestrator-
   *  initiated deactivate/uninstall/disable, spec §3.8) — never from the
   *  registerContributions disposer, which also runs on crash cleanup. */
  function unregisterCadence(e: Entry): void {
    for (const sid of e.sourceIds) {
      void deps.store.read
        .accounts()
        .then((accounts) => {
          accounts
            .filter((a) => a.source === sid)
            .forEach((a) => deps.scheduler.unregister(`source:${sid}:${a.id}`));
        })
        .catch(() => {});
    }
  }

  async function activate(e: Entry): Promise<void> {
    // Idempotency guard: a live/in-flight host already owns this entry — a
    // redundant setEnabled(true) (double-click, concurrent IPC, or any other
    // re-entrant call) is a no-op. This check, the host construction, and
    // the assignment below must all be synchronous (no `await` between
    // them) so a second concurrent activate(e) call can never slip through
    // the gap while the first call is off awaiting consent — it would see
    // `e.host` still null and race to create its own host too. Consent is
    // therefore checked AFTER reserving `e.host`, not before.
    if (e.host) return;
    const host = createExtensionHost({
      extensionId: e.manifest.id,
      entryAbsPath: e.entryAbsPath,
      dataDir: path.join(e.dir, 'data'),
      caps: e.manifest.caps as Cap[],
      transportFactory: () => deps.transportFactory(e.manifest.id),
      makeSurfaces: (deliverEvent) =>
        buildSurfaces({
          extensionId: e.manifest.id,
          dataDir: path.join(e.dir, 'data'),
          query: deps.store.read,
          inference: deps.inference,
          notify: deps.notify,
          bus,
          deliverEvent,
        }),
      logSink: deps.logSink,
      onStatus: (status, error) => setStatus(e, status, error),
      registerContributions: (c, makeSource) =>
        registerContributions(e, c, makeSource),
      ...deps.hostTimeouts,
    });
    e.host = host;
    try {
      if (!(await consentCovers(e.manifest))) {
        // Never started — createExtensionHost() itself has no side effects
        // (no process, no transport) until .start() is called, so releasing
        // the reservation here orphans nothing.
        e.host = null;
        setStatus(e, 'needs-consent');
        return;
      }
    } catch (err) {
      // The consent check itself threw (e.g. the consent store read
      // rejected) rather than resolving false. Without this catch, the
      // exception would propagate out of activate() with `e.host` left
      // pointing at a reserved-but-never-started host forever — every
      // future activate() call would then see `e.host` truthy and no-op on
      // the idempotency guard, permanently wedging the entry. Reset the
      // reservation (nothing was started, so nothing to tear down) and
      // park the entry in 'errored' — recoverable by a later activate().
      e.host = null;
      setStatus(e, 'errored', err instanceof Error ? err.message : String(err));
      return;
    }
    await host.start().catch(() => {
      // status already 'errored' via onStatus; reset host reservation
      // so a retry via setEnabled(true) can attempt activation again
      // instead of silently no-opping on the idempotency guard.
      e.host = null;
    });
  }

  async function deactivate(e: Entry): Promise<void> {
    await e.host?.stop();
    e.host = null;
    // Job-stopping is tied to deactivation (spec §3.8), not to the host
    // process merely exiting — see the note on registerContributions above.
    unregisterCadence(e);
  }

  async function loadEntry(dir: string): Promise<Entry | null> {
    const found = discoverExtensions(path.dirname(dir)).find(
      (d) => d.dir === dir,
    );
    if (!found) return null;
    const state = readEnabledState(deps.extDir);
    const records = readInstalled(deps.extDir);
    if (!found.manifest || !found.entryAbsPath) {
      // Invalid on disk — track it as errored so the UI can show why.
      return null;
    }
    const e: Entry = {
      manifest: found.manifest,
      dir: found.dir,
      entryAbsPath: found.entryAbsPath,
      record: records.find((r) => r.id === found.manifest!.id),
      enabled: state[found.manifest.id]?.enabled ?? true,
      status: 'disabled',
      error: undefined,
      host: null,
      sourceIds: [],
      iconDataUrl: loadIconDataUrl(found.dir, found.manifest),
    };
    entries.set(found.manifest.id, e);
    return e;
  }

  return {
    async start() {
      fs.mkdirSync(deps.extDir, { recursive: true });
      const state = readEnabledState(deps.extDir);
      const records = readInstalled(deps.extDir);
      for (const found of discoverExtensions(deps.extDir)) {
        if (!found.manifest || !found.entryAbsPath) {
          deps.logSink.log(
            'extensions',
            'error',
            `invalid extension in ${found.dirName}: ${found.error}`,
          );
          continue;
        }
        entries.set(found.manifest.id, {
          manifest: found.manifest,
          dir: found.dir,
          entryAbsPath: found.entryAbsPath,
          record: records.find((r) => r.id === found.manifest!.id),
          enabled: state[found.manifest.id]?.enabled ?? true,
          status: 'disabled',
          error: undefined,
          host: null,
          sourceIds: [],
          iconDataUrl: loadIconDataUrl(found.dir, found.manifest),
        });
      }
      changed();
      // Activated in PARALLEL across extensions — a hung extension's
      // handshake timeout no longer stacks in front of every other
      // extension's boot activation (and, in turn, in front of
      // createWindow()). Per-id runExclusive still isolates same-id ops: a
      // concurrent setEnabled/installCommit/uninstall for the same id
      // (racing this boot loop) can never interleave with this activation
      // — and each is re-fetched by id (not a closed-over `e`) inside the
      // callback so it always acts on whichever Entry is current by the
      // time its turn in that id's queue arrives.
      await Promise.all(
        [...entries.keys()].map((id) =>
          runExclusive(id, async () => {
            const e = entries.get(id);
            if (e && e.enabled) await activate(e);
          }),
        ),
      );
    },

    async stop() {
      installer.discardAll();
      for (const id of entries.keys()) {
        // eslint-disable-next-line no-await-in-loop
        await runExclusive(id, async () => {
          const e = entries.get(id);
          if (e) await deactivate(e);
        });
      }
    },

    snapshot,

    async installPreview(ref) {
      try {
        const p = await installer.preview(ref);
        return {
          ok: true,
          token: p.token,
          id: p.manifest.id,
          name: p.manifest.name,
          version: p.manifest.version,
          caps: p.manifest.caps as Cap[],
          oauthSources: oauthSourceBindings(p.manifest),
          sizeBytes: p.sizeBytes,
          integrity: p.integrity,
          iconDataUrl: loadIconDataUrl(p.stagingDir, p.manifest),
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async installCommit(token) {
      try {
        // The extension id is knowable pre-commit — it's on the
        // PendingInstall — via installer.peek(). Locking on it BEFORE
        // installer.commit() touches disk means the running host's `data/`
        // dir gets closed (deactivate) before commit renames/rmSyncs that
        // same dir (EPERM/EBUSY risk on Windows otherwise), and the whole
        // [deactivate existing → commit → consent/state → activate new
        // Entry] sequence runs as one atomic op keyed on the extension id —
        // it can never interleave with a concurrent setEnabled/uninstall
        // for the same id. activate()/deactivate() stay unlocked internally
        // (no nested runExclusive call for the same id).
        const id = installer.peek(token);
        return await runExclusive(id, async () => {
          // Re-peek inside the lock: a concurrent commit of the SAME token
          // queued behind us would otherwise deactivate the entry we just
          // activated, only to have installer.commit() throw unknown-token.
          installer.peek(token);
          const existing = entries.get(id);
          if (existing) await deactivate(existing);
          const { manifest, dir } = await installer.commit(token);
          const consent: ConsentRecord = {
            extensionId: manifest.id as ExtensionId,
            caps: manifest.caps as Cap[],
            manifestVersion: manifest.version,
            grantedAt: new Date().toISOString(),
          };
          await deps.store.consents.record(consent);
          const state = readEnabledState(deps.extDir);
          state[manifest.id] = { enabled: true };
          writeEnabledState(deps.extDir, state);
          const e = await loadEntry(dir);
          if (!e) throw new Error('committed extension failed re-discovery');
          changed();
          await activate(e);
          return { ok: true, id: manifest.id };
        });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async uninstall(id) {
      return runExclusive(id, async () => {
        const e = entries.get(id);
        if (!e) return { ok: false, error: `no such extension: ${id}` };
        const sourceIds = sourceContributions(e.manifest).map((s) => s.id);
        const accounts = await deps.store.read.accounts();
        if (accounts.some((a) => sourceIds.includes(a.source))) {
          return {
            ok: false,
            error: "Remove this connector's sources before uninstalling it.",
          };
        }
        await deactivate(e);
        fs.rmSync(e.dir, { recursive: true, force: true });
        writeInstalled(
          deps.extDir,
          readInstalled(deps.extDir).filter((r) => r.id !== id),
        );
        const state = readEnabledState(deps.extDir);
        delete state[id];
        writeEnabledState(deps.extDir, state);
        entries.delete(id);
        changed();
        return { ok: true };
      });
    },

    async setEnabled(id, enabled) {
      // Wrapped so a disable racing an in-flight enable (or vice versa) for
      // the same extension can never interleave: the later call always
      // runs after the earlier one's activate()/deactivate() has fully
      // settled, acting on the entry's genuinely-current state instead of
      // clobbering a host reference the other call is still setting up.
      return runExclusive(id, async () => {
        const e = entries.get(id);
        if (!e) return { ok: false, error: `no such extension: ${id}` };
        e.enabled = enabled;
        const state = readEnabledState(deps.extDir);
        state[id] = { enabled };
        writeEnabledState(deps.extDir, state);
        if (enabled) await activate(e);
        else {
          await deactivate(e);
          setStatus(e, 'disabled');
        }
        changed();
        return { ok: true };
      });
    },

    async grantConsent(id) {
      return runExclusive(id, async () => {
        const e = entries.get(id);
        if (!e) return { ok: false, error: `no such extension: ${id}` };
        const consent: ConsentRecord = {
          extensionId: e.manifest.id as ExtensionId,
          caps: e.manifest.caps as Cap[],
          manifestVersion: e.manifest.version,
          grantedAt: new Date().toISOString(),
        };
        await deps.store.consents.record(consent);
        if (e.enabled) await activate(e);
        changed();
        return { ok: true };
      });
    },
  };
}
