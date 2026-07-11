import type {
  Account,
  AccountId,
  AppPrefs,
  AppState,
  Cadence,
  Cap,
  Document,
  DocumentId,
  FolderCount,
  FolderNode,
  Identity,
  LogLevel,
  LogRecord,
  McpActivityRecord,
  OAuthSourceBinding,
  ProviderStatus,
  RecentExtraction,
  Seq,
  SourceDescriptor,
} from './contracts';

/**
 * The renderer ↔ main contract. One projection push carries ALL live app
 * state; the invoke channels are commands and page-local reads. (The legacy
 * app needed 85 channels; the feed/projection design needs these.)
 */

/** Pushed to every window on each projection diff. `seq` is the feed
 *  position the state reflects; `rev` is the broadcast ordering counter
 *  (patches to non-feed slices re-push with the same seq but a higher rev). */
export interface AppStatePush {
  state: AppState;
  seq: Seq;
  rev: number;
}

/** Interactive connect-flow events (AuthChannel surfaced to the renderer). */
export type ConnectEvent =
  | { flowId: string; kind: 'status'; msg: string }
  | { flowId: string; kind: 'qr'; qr: string }
  | { flowId: string; kind: 'prompt'; requestId: string; schema: unknown }
  /** AuthChannel.pickFolders — open the shared folder picker; the tree is
   *  served lazily over the accounts:picker-* invokes below (serializable
   *  fields only; the spec's callbacks stay main-side, keyed by requestId). */
  | {
      flowId: string;
      kind: 'folder-picker';
      requestId: string;
      multiSelect: boolean;
      modes: Array<{ key: string; label: string }>;
    }
  | { flowId: string; kind: 'done'; account: Account }
  | { flowId: string; kind: 'error'; msg: string };

export interface SearchRequest {
  text?: string;
  type?: string;
  account?: AccountId;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface StorageStats {
  dbBytes: number;
  docCount: number;
  accountCount: number;
  dataDir: string;
}

export interface McpInfo {
  port: number | null;
  clients: Array<{ id: string; name: string; connected: boolean }>;
}

export interface ScheduledJob {
  id: string;
  cadence: unknown;
  lastRun: string | null;
  nextRun: string | null;
}

export interface ExtensionPreview {
  ok: true;
  token: string;
  id: string;
  name: string;
  version: string;
  caps: Cap[];
  /** Sources that will sign in through a platform OAuth provider — part of
   *  what the user consents to at install, alongside caps. */
  oauthSources: OAuthSourceBinding[];
  sizeBytes: number;
  integrity: string | null;
  /** data:image/png;base64 URI of the staged package's manifest icon — the
   *  consent modal shows the real icon before commit. */
  iconDataUrl?: string;
}

export interface MarketplaceListItem {
  owner: string;
  repo: string;
  fullName: string;
  displayName: string;
  description: string;
  installedId?: string; // filled by catalog.ts, never by github-source.ts
  /** data:image/png;base64 URI fetched from the repo's conventional
   *  root-level icon.png (HEAD) — absent when the repo has none. */
  iconDataUrl?: string;
}

export interface PluginDetail {
  listing: MarketplaceListItem;
  readmeMarkdown: string;
  latest: {
    tag: string;
    version: string;
    publishedAt: string;
    tarballUrl: string | null;
    prerelease: boolean;
  } | null;
}

export interface UpdateInfo {
  id: string;
  installedVersion: string;
  latestVersion: string;
  ref: string;
}

/** Lifecycle of an update check/download. `disabled` = gated off (dev/unsigned-mac). */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'
  | 'disabled';

export interface UpdateState {
  status: UpdateStatus;
  /** The running app version (`app.getVersion()`). */
  currentVersion: string;
  /** Target version when available/downloaded, else null. */
  version: string | null;
  /** 0..100 while downloading. */
  percent?: number;
  bytesPerSecond?: number;
  /** User-readable error text when status === 'error'. */
  error?: string;
  /** epoch ms of the last completed check. */
  checkedAt?: number;
  /** Why disabled, e.g. 'dev' | 'unsigned-macos'. */
  reason?: string;
}

/** invoke(channel, payload) → response. */
export interface Invokes {
  'app:get-state': { req: void; res: AppStatePush };

  'sources:list': { req: void; res: SourceDescriptor[] };
  /**
   * Recursive file count preview for a prospective local-folder account.
   * Honors the local-folder source's exclude rules; null when the path is
   * not a readable directory.
   */
  'sources:count-files': {
    req: { path: string };
    res: { count: number; capped: boolean } | null;
  };
  /**
   * Folder-tree browsing for the in-app folder picker. `special` returns the
   * roots (quick links or drive roots); `path` returns a folder's immediate
   * subdirectories. Unreadable paths yield empty entries.
   */
  'sources:list-folders': {
    req: { special: 'quick' | 'drives' } | { path: string };
    res: {
      entries: Array<{ path: string; name: string; hasChildren: boolean }>;
    };
  };

  /** Starts an interactive connect flow; progress arrives via push:connect. */
  'accounts:add': { req: { sourceId: string }; res: { flowId: string } };
  'accounts:prompt-answer': {
    req: { requestId: string; answers: Record<string, unknown> };
    res: void;
  };
  /** Cancels an in-flight connect flow: rejects its pending prompt/pickers,
   *  closes its OAuth window, and keeps a late connect() success from
   *  creating+starting an account. No-op for unknown/settled flowIds (the
   *  renderer's unmount cleanup races flows that settled a beat earlier). */
  'accounts:cancel-flow': { req: { flowId: string }; res: void };
  /** Lazy tree reads for an open connect-flow folder picker (`folder-picker`
   *  ConnectEvent). All reject on an unknown/settled requestId. */
  'accounts:picker-roots': {
    req: { requestId: string; mode: string };
    res: FolderNode[];
  };
  'accounts:picker-children': {
    req: { requestId: string; id: string };
    res: FolderNode[];
  };
  /** null when the source's spec has no count (or counting failed). */
  'accounts:picker-count': {
    req: { requestId: string; id: string };
    res: FolderCount | null;
  };
  /** Resolves the pending pickFolders with the chosen covering roots. */
  'accounts:picker-confirm': {
    req: { requestId: string; nodes: FolderNode[] };
    res: void;
  };
  /** Rejects the pending pickFolders — connect() throws, the flow errors. */
  'accounts:picker-cancel': { req: { requestId: string }; res: void };
  'accounts:remove': { req: { accountId: AccountId }; res: void };
  'accounts:pause': { req: { accountId: AccountId }; res: void };
  'accounts:resume': { req: { accountId: AccountId }; res: void };
  'accounts:sync-now': { req: { accountId: AccountId }; res: void };
  'accounts:set-cadence': {
    req: { accountId: AccountId; cadence: Cadence | null };
    res: void;
  };
  'accounts:update-config': {
    req: { accountId: AccountId; config: Record<string, unknown> };
    res: void;
  };

  'search:query': {
    req: SearchRequest;
    res: Array<Document & { snippet?: string }>;
  };
  'docs:get': { req: { id: DocumentId }; res: Document | null };
  'docs:children': { req: { id: DocumentId }; res: Document[] };

  'prefs:get': { req: void; res: AppPrefs };
  'prefs:patch': { req: Partial<AppPrefs>; res: AppPrefs };

  'identity:get': { req: void; res: Identity | null };
  'identity:set': { req: Identity; res: void };

  'logs:recent': {
    req: { scope?: string; level?: LogLevel } | void;
    res: LogRecord[];
  };
  'logs:export': { req: void; res: string };
  'mcp-activity:recent': { req: void; res: McpActivityRecord[] };

  'mcp:info': { req: void; res: McpInfo };
  'mcp:connect-client': { req: { id: string }; res: void };
  'mcp:disconnect-client': { req: { id: string }; res: void };

  'scheduler:jobs': { req: void; res: ScheduledJob[] };
  'scheduler:trigger': { req: { id: string }; res: void };

  'storage:stats': { req: void; res: StorageStats };
  'maintenance:compact': { req: void; res: void };
  'maintenance:export': { req: { destDir: string }; res: void };
  'maintenance:reset-all': { req: void; res: void };

  'inference:providers': {
    req: void;
    res: Array<{
      id: string;
      supports: Array<'complete' | 'see' | 'read' | 'hear'>;
      status: ProviderStatus;
    }>;
  };
  /** Start (or retry) the local model download; also re-enables autoInstall. */
  'inference:install': { req: void; res: void };
  /** Abort the download and disable autoInstall until re-enabled. */
  'inference:cancel': { req: void; res: void };
  /** Vision-pipeline queue counts + the "Recently processed" list. */
  'inference:stats': {
    req: void;
    res: {
      pendingOcr: number;
      awaitingVlm: number;
      processed: number;
      recent: RecentExtraction[];
    };
  };
  /** The local-llm model catalog + the resolved selection, for the Settings
   *  override picker and active-model display. */
  'inference:models': {
    req: void;
    res: {
      options: Array<{
        id: string;
        label: string;
        totalBytes: number;
        installed: boolean;
      }>;
      selectedId: string; // override resolved, or the auto-picked tier for this machine
    };
  };

  'app:info': { req: void; res: { version: string; platform: string } };
  /** Reveal a path in the system file manager. */
  'app:open-path': { req: { path: string }; res: void };

  /** Auto-updater state machine (electron-updater, ported into core). */
  'update:get-state': { req: void; res: UpdateState };
  /** Kicks off a check; resolves with the post-kickoff state. */
  'update:check': { req: void; res: UpdateState };
  /** Restart and install an already-downloaded update. */
  'update:quit-and-install': { req: void; res: void };

  /** Official kia-plugins catalog (5-min cached). Rejects on first-ever fetch failure. */
  'marketplace:list': { req: void; res: MarketplaceListItem[] };
  'marketplace:detail': {
    req: { owner: string; repo: string };
    res: PluginDetail;
  };
  'marketplace:check-updates': { req: void; res: UpdateInfo[] };

  /** Stage a local extension package (dir or .tgz). Marketplace refs: Plan B. */
  'extension:install-preview': {
    req: { ref: string };
    res: ExtensionPreview | { ok: false; error: string };
  };
  /** Records consent for the staged manifest's caps, installs, hot-activates. */
  'extension:install-commit': {
    req: { token: string };
    res: { ok: boolean; id?: string; error?: string };
  };
  'extension:uninstall': {
    req: { id: string };
    res: { ok: boolean; error?: string };
  };
  'extension:set-enabled': {
    req: { id: string; enabled: boolean };
    res: { ok: boolean; error?: string };
  };
  /**
   * Records fresh consent for an installed extension's on-disk manifest
   * (the Marketplace "Review permissions" action), then activates it.
   */
  'extension:grant-consent': {
    req: { id: string };
    res: { ok: boolean; error?: string };
  };
}

/** main → renderer broadcasts. */
export interface Pushes {
  'push:app-state': AppStatePush;
  'push:connect': ConnectEvent;
  'push:logs': LogRecord[];
  'push:mcp-activity': McpActivityRecord[];
  'push:update-state': UpdateState;
}

export type InvokeChannel = keyof Invokes;
export type PushChannel = keyof Pushes;

/** Runtime allowlists for preload — must stay in sync with the interfaces
 *  above; the satisfies clauses enforce it at compile time. */
export const INVOKE_CHANNELS = [
  'app:get-state',
  'sources:list',
  'sources:count-files',
  'sources:list-folders',
  'accounts:add',
  'accounts:prompt-answer',
  'accounts:cancel-flow',
  'accounts:picker-roots',
  'accounts:picker-children',
  'accounts:picker-count',
  'accounts:picker-confirm',
  'accounts:picker-cancel',
  'accounts:remove',
  'accounts:pause',
  'accounts:resume',
  'accounts:sync-now',
  'accounts:set-cadence',
  'accounts:update-config',
  'search:query',
  'docs:get',
  'docs:children',
  'prefs:get',
  'prefs:patch',
  'identity:get',
  'identity:set',
  'logs:recent',
  'logs:export',
  'mcp-activity:recent',
  'mcp:info',
  'mcp:connect-client',
  'mcp:disconnect-client',
  'scheduler:jobs',
  'scheduler:trigger',
  'storage:stats',
  'maintenance:compact',
  'maintenance:export',
  'maintenance:reset-all',
  'inference:providers',
  'inference:install',
  'inference:cancel',
  'inference:stats',
  'inference:models',
  'app:info',
  'app:open-path',
  'update:get-state',
  'update:check',
  'update:quit-and-install',
  'marketplace:list',
  'marketplace:detail',
  'marketplace:check-updates',
  'extension:install-preview',
  'extension:install-commit',
  'extension:uninstall',
  'extension:set-enabled',
  'extension:grant-consent',
] as const satisfies readonly InvokeChannel[];

export const PUSH_CHANNELS = [
  'push:app-state',
  'push:connect',
  'push:logs',
  'push:mcp-activity',
  'push:update-state',
] as const satisfies readonly PushChannel[];

/** What preload exposes on window.kiagent. */
export interface RendererApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    payload: Invokes[C]['req'],
  ): Promise<Invokes[C]['res']>;
  on<C extends PushChannel>(
    channel: C,
    cb: (payload: Pushes[C]) => void,
  ): () => void;
}
