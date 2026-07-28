import type { App, MenuItemConstructorOptions } from 'electron';

import type { AccountId, Credentials, Identity } from '@shared/contracts';

import type { McpServerHandle } from './core/mcp/server';
import type { CoreStore } from './core/store/store';
import type { TrayMenuController } from './tray-menu';
import type { OutboundService } from './outbound/service';

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
  mcp: {
    /** The loopback port actually bound (null if the server never bound —
     *  should not happen once `startMcp` has resolved). */
    port: number | null;
    registerTool: McpServerHandle['registerTool'];
    /** Returns a MULTIPLEXING request handler bound to the LIVE shared
     *  ToolRegistry/resources/activity, for serving MCP over a product-owned
     *  transport (e.g. a remote HTTPS server) — owns its own session pool so it
     *  can serve many sessions + reconnects. See
     *  McpServerHandle.createMcpHandler in core/mcp/server.ts. */
    createMcpHandler: McpServerHandle['createMcpHandler'];
  };
  paths: { userData: string; dataDir: string };
  app: { version: string; name: string };
  ui: {
    /** Appends items to the app tray's context menu (spliced before the
     *  quit item); returns a disposer that removes them and rebuilds. */
    addTrayMenuItems(items: MenuItemConstructorOptions[]): () => void;
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
}

export interface BuildMainApiDeps {
  store: CoreStore;
  mcp: McpServerHandle;
  /** Only the electron `App` members actually used — keeps this testable
   *  without an Electron runtime. */
  app: Pick<App, 'getPath' | 'getVersion' | 'getName'>;
  dataDir: string;
  tray: TrayMenuController;
  outbound: {
    service: OutboundService;
    routes: {
      handleRemote(
        req: import('http').IncomingMessage,
        res: import('http').ServerResponse,
      ): Promise<boolean>;
    };
  };
}

export function buildMainApi(deps: BuildMainApiDeps): MainProcessApi {
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
    mcp: {
      port: deps.mcp.port,
      registerTool: (tool) => deps.mcp.registerTool(tool),
      createMcpHandler: () => deps.mcp.createMcpHandler(),
    },
    paths: {
      userData: deps.app.getPath('userData'),
      dataDir: deps.dataDir,
    },
    app: {
      version: deps.app.getVersion(),
      name: deps.app.getName(),
    },
    ui: {
      addTrayMenuItems: (items) => deps.tray.addItems(items),
    },
    outbound: {
      setRemoteBaseUrl: (url) => deps.outbound.service.setRemoteBaseUrl(url),
      handleRequest: (req, res) => deps.outbound.routes.handleRemote(req, res),
    },
  };
}
