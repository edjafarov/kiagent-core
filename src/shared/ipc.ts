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
  LaneState,
  LogLevel,
  LogRecord,
  McpActivityRecord,
  OAuthSourceBinding,
  OutboxStatus,
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

/** Interactive connect-flow events (AuthChannel surfaced to the renderer).
 *  Every variant carries `flowId`: the renderer routes on `evt.flowId !==
 *  flowId` (`AddSourcePanel.tsx:83`), a union-wide property access that a
 *  flowId-less variant would break with TS2339. `flowId` is a plain `string`
 *  here and everywhere (A-6) — main's branded `Id<'flow'>` assigns into it. */
export type ConnectEvent =
  | { flowId: string; kind: 'status'; msg: string }
  | { flowId: string; kind: 'qr'; qr: string }
  | { flowId: string; kind: 'prompt'; requestId: string; schema: unknown }
  /** AuthChannel.pickFolders / FolderSelectionChannel.pickFolders — open the
   *  shared folder picker; the tree is served lazily over the
   *  accounts:picker-* invokes below (serializable fields only; the spec's
   *  callbacks stay main-side, keyed by requestId). `selected` is the complete
   *  current covering set, pre-checked AND removable — distinct from the
   *  renderer's `existingPaths`, which renders rows inert. `purpose` drives
   *  copy and empty-selection rules only, never behaviour. */
  | {
      flowId: string;
      kind: 'folder-picker';
      requestId: string;
      multiSelect: boolean;
      modes: Array<{ key: string; label: string }>;
      selected: FolderNode[];
      purpose: 'connect' | 'manage';
    }
  | { flowId: string; kind: 'done'; account: Account }
  /** Reconnect terminal. NOT `done` — the account already exists, and `done`'s
   *  `Account` payload would invite the renderer to treat a reconnect as a
   *  fresh add. */
  | { flowId: string; kind: 'reconnected'; accountId: AccountId }
  /** Manage-folders terminal. The three counts are FOLDER counts, derived by
   *  the connect broker from the before/after `folderRoots` sets — NOT
   *  document counts. `applyFolderScope` returns `{archived, remaining}`
   *  document counts; those are logged (A-7) and never sent here. */
  | {
      flowId: string;
      kind: 'scope-saved';
      accountId: AccountId;
      added: number;
      retained: number;
      removed: number;
    }
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

/** One row of the in-app Outbox history panel (spec §10).
 *
 *  The error fields are a MAIN-SIDE projection: `error-copy.ts` lives under
 *  `src/main/` and the renderer must not import across that layer, so the
 *  IPC mapper runs `shapeOutboundError` and ships the verdict. */
export interface OutboxPanelRow {
  draftId: string;
  status: OutboxStatus;
  kind: 'reply' | 'new';
  /** The account's `identifier`; '(removed)' if it vanished. */
  accountLabel: string;
  recipientDisplay: string;
  subject: string | null;
  /** First 140 chars of the body, whitespace-collapsed to one line. */
  bodyPreview: string;
  /** Human sentence for the row: `shaped.message` for 'failed', the stored
   *  sentence verbatim for 'delivery_unknown', null for every other status
   *  (a retried failed→sent row keeps its stale error in the DB by design). */
  error: string | null;
  /** `shaped.summary` — the technical one-liner, rendered behind a
   *  <details>Technical details</details>. Null unless status is 'failed'. */
  errorDetail: string | null;
  /** `shaped.canRetry` — gates the "Try again" action (re-confirm the SAME
   *  row; provably-not-sent failures only). */
  canRetry: boolean;
  /** The message MAY have gone out — gates OFF one-click "Draft again". */
  deliveryUncertain: boolean;
  createdAt: string;
  sentAt: string | null;
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

  /** Starts an interactive connect flow; progress arrives via push:connect.
   *  `oauthClient` (issue #89) overrides the build-time OAuth client for this
   *  one flow — the gate's restricted/BYO Google client. */
  'accounts:add': {
    req: {
      sourceId: string;
      oauthClient?: { clientId: string; clientSecret: string };
    };
    res: { flowId: string };
  };
  /** Re-authenticate an EXISTING account in place; progress arrives via
   *  push:connect and terminates with `reconnected`. `oauthClient` (R2)
   *  carries the gate's restricted/BYO Google client for the same reason
   *  `accounts:add` does — core persists nothing. Spelled inline, and
   *  structurally identical to main's `OAuthClientOverride`
   *  (`auth/oauth-window.ts:33-36`): ipc.ts must stay main-free.
   *
   *  C-5: below this wire the client rides on the BROKER
   *  (`connect-broker.startReconnect(accountId, { oauthClient })`), never on
   *  the engine — `engine.reconnect(accountId, auth, signal?)` takes no
   *  client. This req shape is unaffected by that ruling. */
  'accounts:start-reconnect': {
    req: {
      accountId: AccountId;
      oauthClient?: { clientId: string; clientSecret: string };
    };
    res: { flowId: string };
  };
  /** Edit an existing account's folder scope with its CURRENT credentials.
   *  Never authenticates; terminates with `scope-saved`. */
  'accounts:start-manage-folders': {
    req: { accountId: AccountId };
    res: { flowId: string };
  };
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
  /** Outbound-only config write: persists via the store WITHOUT
   *  engine.updateConfig — changing a confirmation mode must never restart
   *  a running sync loop. */
  'accounts:update-outbound': {
    req: { accountId: AccountId; outbound: Record<string, unknown> };
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

  /** Outbox history panel: recent outbound rows, newest first. */
  'outbox:list': { req: { limit?: number }; res: OutboxPanelRow[] };
  /** Discard a pending draft (no-op if it left 'draft' meanwhile). */
  'outbox:discard': { req: { draftId: string }; res: void };
  /** Duplicate a terminal row into a fresh draft and open its confirm page. */
  'outbox:redraft': { req: { draftId: string }; res: { draftId: string } };
  /** Open the confirm page for a still-actionable row in the default
   *  browser (pending drafts, and retryable failures → "Try again"). */
  'outbox:open-confirm': { req: { draftId: string }; res: void };

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
      /** True only for providers the main process can install on demand
       *  (local-llm, local-asr) — the renderer gates Download/Cancel/Retry on
       *  this, NOT on status (apple-vision reports non-ready statuses but has
       *  nothing to install). */
      installable: boolean;
      /** Selectable model variants beyond the provider's default — present
       *  only for local-asr. */
      variants?: Array<{
        id: 'accuracy';
        label: string;
        sizeBytes: number;
        status: ProviderStatus;
      }>;
    }>;
  };
  /** Start (or retry) the named provider's model download; also re-enables
   *  the SHARED autoInstall consent. Unknown providerId is a no-op. */
  'inference:install': {
    req: { providerId: string; variant?: 'accuracy' };
    res: void;
  };
  /** Abort EVERY active installer and disable autoInstall until re-enabled
   *  (cancel is global — the consent is one shared pref). */
  'inference:cancel': { req: void; res: void };
  /** Vision-pipeline queue counts + the "Recently processed" list. */
  'inference:stats': {
    req: void;
    res: {
      pendingOcr: number;
      processed: number;
      recent: RecentExtraction[];
      /** Why background processing is (or isn't) running right now. */
      lane: LaneState;
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

  /** Build identity. `productName` is the resolved product.json name (falls
   *  back to DEFAULT_PRODUCT_NAME) — the renderer never hardcodes a brand. */
  'app:info': {
    req: void;
    res: { version: string; platform: string; productName: string };
  };
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

/**
 * The handler main must supply for every declared channel. Both IPC seams
 * (`updaterInvokeHandlers`, `outboundInvokeHandlers`) return `Pick`s of this
 * so their slices compose into main's one exhaustive map; it lives here
 * rather than in main.ts so neither seam has to import from the entrypoint.
 */
export type InvokeHandlers = {
  [C in InvokeChannel]: (
    req: Invokes[C]['req'],
  ) => Invokes[C]['res'] | Promise<Invokes[C]['res']>;
};

/**
 * Runtime allowlists for preload, derived from maps rather than written as
 * arrays.
 *
 * The reason is the shape, not the style. `[...] as const satisfies readonly
 * InvokeChannel[]` — what these used to be — only rejects names that aren't
 * channels; it accepts an INCOMPLETE list, so a list holding a single entry
 * compiled clean and a forgotten entry surfaced as preload's runtime
 * "unknown invoke channel" instead. `Record<InvokeChannel, 0>` says *exactly
 * these keys*, so a missing one is a compile error (TS1360) and a typo still
 * is (TS2353). The values carry nothing — 0 is just the cheapest inhabitant.
 *
 * The `Object.keys` cast is sound precisely because the satisfies clause
 * above it holds, and preload only ever builds Sets from these.
 */
const INVOKE_CHANNEL_MAP = {
  'app:get-state': 0,
  'sources:list': 0,
  'sources:count-files': 0,
  'sources:list-folders': 0,
  'accounts:add': 0,
  'accounts:start-reconnect': 0,
  'accounts:start-manage-folders': 0,
  'accounts:prompt-answer': 0,
  'accounts:cancel-flow': 0,
  'accounts:picker-roots': 0,
  'accounts:picker-children': 0,
  'accounts:picker-count': 0,
  'accounts:picker-confirm': 0,
  'accounts:picker-cancel': 0,
  'accounts:remove': 0,
  'accounts:pause': 0,
  'accounts:resume': 0,
  'accounts:sync-now': 0,
  'accounts:set-cadence': 0,
  'accounts:update-config': 0,
  'accounts:update-outbound': 0,
  'search:query': 0,
  'docs:get': 0,
  'docs:children': 0,
  'prefs:get': 0,
  'prefs:patch': 0,
  'identity:get': 0,
  'identity:set': 0,
  'logs:recent': 0,
  'logs:export': 0,
  'mcp-activity:recent': 0,
  'outbox:list': 0,
  'outbox:discard': 0,
  'outbox:redraft': 0,
  'outbox:open-confirm': 0,
  'mcp:info': 0,
  'mcp:connect-client': 0,
  'mcp:disconnect-client': 0,
  'scheduler:jobs': 0,
  'scheduler:trigger': 0,
  'storage:stats': 0,
  'maintenance:compact': 0,
  'maintenance:export': 0,
  'maintenance:reset-all': 0,
  'inference:providers': 0,
  'inference:install': 0,
  'inference:cancel': 0,
  'inference:stats': 0,
  'inference:models': 0,
  'app:info': 0,
  'app:open-path': 0,
  'update:get-state': 0,
  'update:check': 0,
  'update:quit-and-install': 0,
  'marketplace:list': 0,
  'marketplace:detail': 0,
  'marketplace:check-updates': 0,
  'extension:install-preview': 0,
  'extension:install-commit': 0,
  'extension:uninstall': 0,
  'extension:set-enabled': 0,
  'extension:grant-consent': 0,
} as const satisfies Record<InvokeChannel, 0>;

export const INVOKE_CHANNELS = Object.keys(
  INVOKE_CHANNEL_MAP,
) as readonly InvokeChannel[];

const PUSH_CHANNEL_MAP = {
  'push:app-state': 0,
  'push:connect': 0,
  'push:logs': 0,
  'push:mcp-activity': 0,
  'push:update-state': 0,
} as const satisfies Record<PushChannel, 0>;

export const PUSH_CHANNELS = Object.keys(
  PUSH_CHANNEL_MAP,
) as readonly PushChannel[];

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
