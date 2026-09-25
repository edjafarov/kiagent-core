import type { App, MenuItemConstructorOptions } from 'electron';

import type {
  Account,
  AccountId,
  Credentials,
  FolderScopeUpdate,
  Identity,
  MessageEvidenceReadInput,
  MessageEvidenceReadResult,
} from '@shared/contracts';
import { coveringRoots, isUnder } from '@shared/folder-paths';

import type { McpServerHandle } from './core/mcp/server';
import type { CoreStore } from './core/store/store';
import type { TrayMenuController } from './tray-menu';
import type { OutboundService } from './outbound/service';
import type { FileRootRegistry } from './platform/file-roots';
import {
  folderScopedConfig,
  partitionRemovedRoots,
  readFolderRoots,
  toFolderRoots,
  validateFolderRoots,
} from './sources/local-folder/folder-roots';
import {
  descriptor as localFolderDescriptor,
  MACHINE_IDENTIFIER,
} from './sources/local-folder/local-folder-source';

/**
 * The MainProcessApi contract handed to in-process bundled extensions
 * (`unsafe.mainProcess` cap) as `extras.mainProcess` — see
 * extension-host-entry.ts. Core deliberately types `ExtensionPlatformDeps
 * .mainApi` as `unknown`; this concrete shape is a product-build concern
 * (assembled here, in main.ts, and consumed by product-owned bundled
 * extensions) rather than a core-committed contract.
 */
export interface MainProcessApi {
  readonly apiVersion: 1;
  identity: {
    get(): Promise<Identity | null>;
    set(i: Identity): Promise<void>;
  };
  vault: {
    load(accountId: AccountId): Promise<Credentials | null>;
    save(accountId: AccountId, creds: Credentials): Promise<void>;
  };
  localFolders: {
    roots(): Promise<Array<{ accountId: string; roots: string[] }>>;
    ensureRoot(
      path: string,
    ): Promise<{ status: 'covered' | 'added' | 'created'; accountId: string }>;
  };
  mcp: {
    /** The loopback port actually bound (null if the server never bound —
     *  should not happen once `startMcp` has resolved). */
    port: number | null;
    /** Passthrough to McpServerHandle.registerTool, so first registration
     *  wins: a name that is already registered is refused (the returned
     *  disposer is a no-op and a warning is logged), and the caller must
     *  dispose its own registrations. */
    registerTool: McpServerHandle['registerTool'];
    /** Returns a MULTIPLEXING request handler bound to the LIVE shared
     *  ToolRegistry/resources/activity, for serving MCP over a product-owned
     *  transport (e.g. a remote HTTPS server) — owns its own session pool so it
     *  can serve many sessions + reconnects. See
     *  McpServerHandle.createMcpHandler in core/mcp/server.ts. */
    createMcpHandler: McpServerHandle['createMcpHandler'];
  };
  paths: { userData: string; dataDir: string };
  /** Trusted root-grant channel for bundled extensions. Callers must supply
   *  their immutable plugin id; ordinary connector RPC never receives this
   *  object. The main process binds this API to the bundled caller before it
   *  is delivered. */
  files: {
    grantRoot(
      owner: string,
      rootPath: string,
      options: {
        name: string;
        writable: boolean;
        id?: string;
        identity?: { dev: string; ino: string };
      },
    ): Promise<import('@shared/plugin-files').FileRoot>;
    revokeRoot(owner: string, id: string): Promise<void>;
    roots(owner: string): Promise<import('@shared/plugin-files').FileRoot[]>;
  };
  app: { version: string; name: string };
  ui: {
    /** Splices items into the app tray's context menu — before the quit item
     *  by default, or before the whole base template with
     *  `{ position: 'top' }` (status-style rows). Returns a disposer that
     *  removes them and rebuilds. */
    addTrayMenuItems(
      items: MenuItemConstructorOptions[],
      opts?: { position?: 'top' | 'bottom' },
    ): () => void;
    /** Opens (or focuses) the main app window — the same behavior as the
     *  tray's "Open KIAgent". For extension escape hatches that need the
     *  user in the app (e.g. a stuck remote connection). */
    openWindow(): void;
  };
  /** Outbound confirm-over-tunnel seam (spec phase 4). */
  outbound: {
    /** Push the public device base URL (https://<device-subdomain>) when the
     *  remote HTTPS server comes up; null when it goes down. */
    setRemoteBaseUrl(url: string | null): void;
    /** Serve an /outbox/* request that arrived over the tunnel. Only
     *  confirm/cancel are handled; false = not ours, caller 404s. */
    handleRequest(
      req: import('http').IncomingMessage,
      res: import('http').ServerResponse,
    ): Promise<boolean>;
  };
  messageEvidence?: {
    read(input: MessageEvidenceReadInput): Promise<MessageEvidenceReadResult>;
  };
  /** Read-only generation token for fencing work across model changes. */
  inference?: {
    generation(): number;
  };
}

export interface BuildMainApiDeps {
  store: CoreStore;
  mcp: McpServerHandle;
  /** Only the electron `App` members actually used — keeps this testable
   *  without an Electron runtime. */
  app: Pick<App, 'getPath' | 'getVersion' | 'getName'>;
  dataDir: string;
  fileRoots?: FileRootRegistry;
  /** The bundled plugin this trusted API instance is entitled to act for. */
  callerPluginId?: string;
  persistFileRoots?(): Promise<void>;
  tray: TrayMenuController;
  /** Window opener shared with the tray's "Open KIAgent" action —
   *  show/focus if a window exists, create it otherwise. */
  ui: { openWindow: () => void };
  outbound: {
    service: OutboundService;
    routes: {
      handleRemote(
        req: import('http').IncomingMessage,
        res: import('http').ServerResponse,
      ): Promise<boolean>;
    };
  };
  readMessageEvidence?: (
    input: MessageEvidenceReadInput,
  ) => Promise<MessageEvidenceReadResult>;
  inference?: {
    generation(): number;
  };
  /** Starts the loop for an account created by localFolders.ensureRoot. */
  runAccount?(account: Account): void;
  /** Narrow bridge to the engine's folder-scope transaction. */
  applyFolderScope?(
    accountId: AccountId,
    update: FolderScopeUpdate,
    configAtOpen: string,
  ): Promise<void>;
}

export function buildMainApi(deps: BuildMainApiDeps): MainProcessApi {
  const pluginIdPattern = /^[a-z0-9-]+\.[a-z0-9-]+$/;
  const ownerForCaller = (owner: string): string => {
    const normalizedOwner =
      typeof owner === 'string' ? owner.trim() : String(owner);
    if (
      typeof owner !== 'string' ||
      normalizedOwner !== owner ||
      !pluginIdPattern.test(normalizedOwner) ||
      normalizedOwner !== deps.callerPluginId
    )
      throw new Error(
        'trusted file root owner must be the calling bundled plugin id',
      );
    return normalizedOwner;
  };
  const rootMutations = new Map<string, Promise<unknown>>();
  const serializeRootMutation = <T>(
    caller: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const prior = rootMutations.get(caller) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    rootMutations.set(caller, next);
    return next.finally(() => {
      if (rootMutations.get(caller) === next) rootMutations.delete(caller);
    });
  };
  const localFolderAccounts = async (): Promise<Account[]> =>
    (await deps.store.read.accounts()).filter(
      (account) => account.source === 'local-folder',
    );
  return {
    apiVersion: 1,
    identity: {
      get: () => deps.store.identity.get(),
      set: (i) => deps.store.identity.set(i),
    },
    vault: {
      load: (accountId) => deps.store.vault.load(accountId),
      save: (accountId, creds) => deps.store.vault.save(accountId, creds),
    },
    localFolders: {
      roots: async () => {
        const result: Array<{ accountId: string; roots: string[] }> = [];
        for (const account of await localFolderAccounts()) {
          try {
            result.push({
              accountId: account.id,
              roots: readFolderRoots(account).map((root) => root.id),
            });
          } catch {
            // A malformed local-folder config must not hide other accounts.
          }
        }
        return result;
      },
      ensureRoot: (path) =>
        serializeRootMutation('local-folders', async () => {
          const [newRoot] = await validateFolderRoots([path]);
          const accounts = await localFolderAccounts();
          const withRoots = accounts.map((account) => ({
            account,
            roots: readFolderRoots(account),
          }));
          const covered = withRoots.find(({ roots }) =>
            roots.some((root) => isUnder(newRoot.id, root.id)),
          );
          if (covered)
            return {
              status: 'covered' as const,
              accountId: covered.account.id,
            };

          if (withRoots.length === 0) {
            const account = await deps.store.createAccount({
              source: 'local-folder',
              identifier: MACHINE_IDENTIFIER,
              config: folderScopedConfig({}, [newRoot]),
              status: 'connecting',
              cadence: localFolderDescriptor.cadence,
            });
            if (!deps.runAccount)
              throw new Error('local-folder account startup is unavailable');
            deps.runAccount(account);
            return { status: 'created' as const, accountId: account.id };
          }

          if (!deps.applyFolderScope)
            throw new Error(
              'local-folder scope updates are unavailable in this main-process API',
            );
          const { account, roots } = withRoots[0];
          const mergedRoots = toFolderRoots([
            ...coveringRoots([...roots.map((root) => root.id), newRoot.id]),
          ]);
          // A root the new one absorbs leaves the config, so its rows must be
          // re-attributed to the new root (C-46/D5) — never archived here.
          const removed = partitionRemovedRoots(roots, mergedRoots);
          if (removed.archive.length > 0)
            throw new Error('ensureRoot must never drop a root from scope');
          const update: FolderScopeUpdate = {
            config: folderScopedConfig(account.config ?? {}, mergedRoots),
            cursor: account.cursor,
            archiveScopeRootIds: [],
            reattributeScopeRoots: removed.reattribute,
          };
          await deps.applyFolderScope(
            account.id,
            update,
            JSON.stringify(account.config),
          );
          return { status: 'added' as const, accountId: account.id };
        }),
    },
    mcp: {
      port: deps.mcp.port,
      registerTool: (tool) => deps.mcp.registerTool(tool),
      createMcpHandler: () => deps.mcp.createMcpHandler(),
    },
    paths: {
      userData: deps.app.getPath('userData'),
      dataDir: deps.dataDir,
    },
    files: {
      grantRoot: async (owner, rootPath, options) => {
        if (!deps.fileRoots)
          throw new Error('trusted file-root service is unavailable');
        const caller = ownerForCaller(owner);
        return serializeRootMutation(caller, async () => {
          const prior = options.id
            ? await deps
                .fileRoots!.resolve(caller, options.id)
                .catch(() => undefined)
            : undefined;
          const result = await deps.fileRoots!.grant(caller, rootPath, options);
          try {
            await deps.persistFileRoots?.();
            return result;
          } catch (error) {
            // revoke() closes active watchers and their subscriptions. The
            // compensating grant restores the root record, not those prior
            // subscriptions; scoped-files emits a rescan/close notification
            // so the plugin can re-subscribe after this rollback.
            await deps
              .fileRoots!.revoke(caller, result.id)
              .catch(() => undefined);
            if (prior)
              await deps
                .fileRoots!.grant(caller, prior.path, {
                  id: prior.id,
                  name: prior.name,
                  writable: prior.writable,
                  identity: { dev: prior.dev, ino: prior.ino },
                })
                .catch(() => undefined);
            throw error;
          }
        });
      },
      revokeRoot: async (owner, id) => {
        if (!deps.fileRoots)
          throw new Error('trusted file-root service is unavailable');
        const caller = ownerForCaller(owner);
        return serializeRootMutation(caller, async () => {
          const prior = await deps.fileRoots!.resolve(caller, id);
          await deps.fileRoots!.revoke(caller, id);
          try {
            await deps.persistFileRoots?.();
          } catch (error) {
            // The rollback grant restores the root only. Any watcher closed
            // by revoke() must be recreated by the plugin after its rescan
            // notification; prior subscriptions are not resurrected here.
            await deps
              .fileRoots!.grant(caller, prior.path, {
                id: prior.id,
                name: prior.name,
                writable: prior.writable,
                identity: { dev: prior.dev, ino: prior.ino },
              })
              .catch(() => undefined);
            throw error;
          }
        });
      },
      roots: (owner) =>
        deps.fileRoots?.roots(ownerForCaller(owner)) ??
        Promise.reject(new Error('trusted file-root service is unavailable')),
    },
    app: {
      version: deps.app.getVersion(),
      name: deps.app.getName(),
    },
    ui: {
      addTrayMenuItems: (items, opts) => deps.tray.addItems(items, opts),
      openWindow: () => deps.ui.openWindow(),
    },
    outbound: {
      setRemoteBaseUrl: (url) => deps.outbound.service.setRemoteBaseUrl(url),
      handleRequest: (req, res) => deps.outbound.routes.handleRemote(req, res),
    },
    ...(deps.readMessageEvidence
      ? { messageEvidence: { read: deps.readMessageEvidence } }
      : {}),
    ...(deps.inference
      ? { inference: { generation: () => deps.inference!.generation() } }
      : {}),
  };
}
