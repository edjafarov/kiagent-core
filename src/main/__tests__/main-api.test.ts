import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, FolderScopeUpdate } from '@shared/contracts';
import { buildMainApi } from '../main-api';
import type { CoreStore } from '../core/store/store';
import type { McpServerHandle } from '../core/mcp/server';
import type { TrayMenuController } from '../tray-menu';
import type { OutboundService } from '../outbound/service';
import {
  createFileRootRegistry,
  createFileRootsPersistence,
} from '../platform/file-roots';

function stubStore(): {
  store: CoreStore;
  identityGetCalls: number;
  identitySetArgs: unknown[];
  vaultLoadArgs: unknown[];
  vaultSaveArgs: unknown[];
} {
  const identitySetArgs: unknown[] = [];
  const vaultLoadArgs: unknown[] = [];
  const vaultSaveArgs: unknown[] = [];
  let identityGetCalls = 0;
  const store = {
    vault: {
      load: async (accountId: unknown) => {
        vaultLoadArgs.push(accountId);
        return { accessToken: 'tok' };
      },
      save: async (accountId: unknown, creds: unknown) => {
        vaultSaveArgs.push([accountId, creds]);
      },
      delete: async () => {},
    },
    identity: {
      get: async () => {
        identityGetCalls += 1;
        return { name: 'Ada', emails: [], phones: [] };
      },
      set: async (i: unknown) => {
        identitySetArgs.push(i);
      },
    },
  } as unknown as CoreStore;
  return {
    store,
    get identityGetCalls() {
      return identityGetCalls;
    },
    identitySetArgs,
    vaultLoadArgs,
    vaultSaveArgs,
  };
}

function stubMcp(): {
  mcp: McpServerHandle;
  registerToolArgs: unknown[];
  sessionHandlerCalls: number;
} {
  const registerToolArgs: unknown[] = [];
  let sessionHandlerCalls = 0;
  const mcp = {
    port: 7421,
    registerTool: (tool: unknown) => {
      registerToolArgs.push(tool);
      return () => {};
    },
    createMcpHandler: () => {
      sessionHandlerCalls += 1;
      return async () => {};
    },
  } as unknown as McpServerHandle;
  return {
    mcp,
    registerToolArgs,
    get sessionHandlerCalls() {
      return sessionHandlerCalls;
    },
  };
}

function stubApp() {
  return {
    getPath: (name: string) =>
      name === 'userData' ? '/fake/userData' : `/fake/${name}`,
    getVersion: () => '1.2.3',
    getName: () => 'KIAgent',
  };
}

function stubTray(): {
  tray: TrayMenuController;
  addedGroups: unknown[][];
  disposed: unknown[][];
} {
  const addedGroups: unknown[][] = [];
  const disposed: unknown[][] = [];
  const tray: TrayMenuController = {
    addItems: (items) => {
      addedGroups.push(items);
      return () => {
        disposed.push(items);
      };
    },
  };
  return { tray, addedGroups, disposed };
}

function stubOutbound(handleRemoteResult: boolean): {
  outbound: {
    service: OutboundService;
    routes: { handleRemote(req: unknown, res: unknown): Promise<boolean> };
  };
  setRemoteBaseUrlArgs: (string | null)[];
  handleRemoteArgs: unknown[][];
} {
  const setRemoteBaseUrlArgs: (string | null)[] = [];
  const handleRemoteArgs: unknown[][] = [];
  const service = {
    setRemoteBaseUrl: (url: string | null) => {
      setRemoteBaseUrlArgs.push(url);
    },
  } as unknown as OutboundService;
  const routes = {
    handleRemote: async (req: unknown, res: unknown) => {
      handleRemoteArgs.push([req, res]);
      return handleRemoteResult;
    },
  };
  return {
    outbound: { service, routes },
    setRemoteBaseUrlArgs,
    handleRemoteArgs,
  };
}

function localAccount(
  id: string,
  config: Record<string, unknown>,
  cursor: unknown = null,
): Account {
  return {
    id: id as Account['id'],
    source: 'local-folder',
    identifier: 'this-machine',
    config,
    status: 'live',
    cursor,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function mainApiWithLocalFolders(options: {
  accounts: () => Promise<Account[]>;
  createAccount?: (input: unknown) => Promise<Account>;
  runAccount?: (account: Account) => void;
  applyFolderScope?: (
    accountId: Account['id'],
    update: FolderScopeUpdate,
    configAtOpen: string,
  ) => Promise<void>;
}) {
  const base = stubStore();
  const store = {
    ...(base.store as unknown as Record<string, unknown>),
    read: { accounts: options.accounts },
    createAccount: options.createAccount ?? jest.fn(),
  } as unknown as CoreStore;
  const { mcp } = stubMcp();
  const { tray } = stubTray();
  return buildMainApi({
    store,
    mcp,
    app: stubApp(),
    dataDir: '/fake/data',
    tray,
    ui: { openWindow: () => {} },
    outbound: stubOutbound(true).outbound,
    runAccount: options.runAccount,
    applyFolderScope: options.applyFolderScope,
  });
}

describe('buildMainApi localFolders', () => {
  it('roots lists local-folder roots and skips accounts with invalid config', async () => {
    const valid = localAccount('valid', {
      folderRoots: [{ id: '/tmp/docs', name: 'docs' }],
    });
    const api = mainApiWithLocalFolders({
      accounts: async () => [
        localAccount('broken', {}),
        valid,
        { ...valid, id: 'other' as Account['id'], source: 'gmail' },
      ],
    });

    await expect(api.localFolders.roots()).resolves.toEqual([
      { accountId: 'valid', roots: ['/tmp/docs'] },
    ]);
  });

  it('creates and starts a local-folder account when no account exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'main-api-local-root-'));
    try {
      const created = localAccount('created', {
        folderRoots: [{ id: root, name: 'root' }],
      });
      const createAccount = jest.fn(async () => created);
      const runAccount = jest.fn();
      const api = mainApiWithLocalFolders({
        accounts: async () => [],
        createAccount,
        runAccount,
      });

      await expect(api.localFolders.ensureRoot(root)).resolves.toEqual({
        status: 'created',
        accountId: 'created',
      });
      expect(createAccount).toHaveBeenCalledWith({
        source: 'local-folder',
        identifier: 'this-machine',
        config: {
          folderRoots: [expect.objectContaining({ id: root })],
        },
        status: 'connecting',
        cadence: { every: '30m' },
      });
      expect(runAccount).toHaveBeenCalledTimes(1);
      expect(runAccount).toHaveBeenCalledWith(created);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies a merged scope to an existing account without creating it', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'main-api-local-parent-'));
    const current = join(parent, 'current');
    const added = join(parent, 'incoming');
    await mkdir(current);
    await mkdir(added);
    try {
      const oldConfig = {
        watch: false,
        folderRoots: [{ id: current, name: 'current' }],
      };
      const account = localAccount('existing', oldConfig, {
        parent: { completedAt: '2026-01-01T00:00:00.000Z' },
      });
      const createAccount = jest.fn(async () => account);
      const applyFolderScope = jest.fn(async () => undefined);
      const api = mainApiWithLocalFolders({
        accounts: async () => [account],
        createAccount,
        applyFolderScope,
      });

      await expect(api.localFolders.ensureRoot(added)).resolves.toEqual({
        status: 'added',
        accountId: 'existing',
      });
      expect(applyFolderScope).toHaveBeenCalledWith(
        'existing',
        {
          config: {
            watch: false,
            folderRoots: [
              { id: current, name: 'current' },
              { id: added, name: 'incoming' },
            ],
          },
          cursor: account.cursor,
          archiveScopeRootIds: [],
          reattributeScopeRoots: [],
        },
        JSON.stringify(oldConfig),
      );
      expect(createAccount).not.toHaveBeenCalled();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('drops redundant descendants when the ensured root is an ancestor', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'main-api-ancestor-'));
    const child = join(parent, 'child');
    await mkdir(child);
    try {
      const account = localAccount('ancestor', {
        folderRoots: [{ id: child, name: 'child' }],
      });
      const applyFolderScope = jest.fn(async () => undefined);
      const api = mainApiWithLocalFolders({
        accounts: async () => [account],
        applyFolderScope,
      });

      await expect(api.localFolders.ensureRoot(parent)).resolves.toEqual({
        status: 'added',
        accountId: 'ancestor',
      });
      expect(applyFolderScope).toHaveBeenCalledWith(
        'ancestor',
        expect.objectContaining({
          config: {
            folderRoots: [expect.objectContaining({ id: parent })],
          },
          archiveScopeRootIds: [],
          reattributeScopeRoots: [{ from: child, to: parent }],
        }),
        JSON.stringify(account.config),
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it.each(['exact', 'descendant'])(
    'returns covered with no writes for an %s covered path',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'main-api-covered-'));
      const target = kind === 'exact' ? root : join(root, 'child');
      if (target !== root) await mkdir(target);
      try {
        const account = localAccount('covered', {
          folderRoots: [{ id: root, name: 'root' }],
        });
        const createAccount = jest.fn(async () => account);
        const applyFolderScope = jest.fn(async () => undefined);
        const runAccount = jest.fn();
        const api = mainApiWithLocalFolders({
          accounts: async () => [account],
          createAccount,
          applyFolderScope,
          runAccount,
        });

        await expect(api.localFolders.ensureRoot(target)).resolves.toEqual({
          status: 'covered',
          accountId: 'covered',
        });
        expect(createAccount).not.toHaveBeenCalled();
        expect(applyFolderScope).not.toHaveBeenCalled();
        expect(runAccount).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('does not treat a sibling-prefix path as covered', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'main-api-prefix-'));
    const root = join(parent, 'b');
    const sibling = join(parent, 'bc');
    await mkdir(root);
    await mkdir(sibling);
    try {
      const account = localAccount('prefix', {
        folderRoots: [{ id: root, name: 'b' }],
      });
      const applyFolderScope = jest.fn(async () => undefined);
      const api = mainApiWithLocalFolders({
        accounts: async () => [account],
        applyFolderScope,
      });

      await expect(api.localFolders.ensureRoot(sibling)).resolves.toEqual({
        status: 'added',
        accountId: 'prefix',
      });
      expect(applyFolderScope).toHaveBeenCalledTimes(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects a nonexistent path without writes', async () => {
    const createAccount = jest.fn();
    const applyFolderScope = jest.fn();
    const api = mainApiWithLocalFolders({
      accounts: async () => [],
      createAccount,
      applyFolderScope,
    });

    await expect(
      api.localFolders.ensureRoot('/tmp/kiagent-main-api-does-not-exist'),
    ).rejects.toThrow('path does not exist');
    expect(createAccount).not.toHaveBeenCalled();
    expect(applyFolderScope).not.toHaveBeenCalled();
  });

  it('serializes concurrent ensureRoot calls so the same path is written once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'main-api-concurrent-'));
    try {
      const created = localAccount('created-once', {
        folderRoots: [{ id: root, name: 'concurrent' }],
      });
      let accounts: Account[] = [];
      const createAccount = jest.fn(async () => {
        accounts = [created];
        return created;
      });
      const applyFolderScope = jest.fn(async () => undefined);
      const api = mainApiWithLocalFolders({
        accounts: async () => accounts,
        createAccount,
        applyFolderScope,
        runAccount: jest.fn(),
      });

      await expect(
        Promise.all([
          api.localFolders.ensureRoot(root),
          api.localFolders.ensureRoot(root),
        ]),
      ).resolves.toEqual([
        { status: 'created', accountId: 'created-once' },
        { status: 'covered', accountId: 'created-once' },
      ]);
      expect(createAccount).toHaveBeenCalledTimes(1);
      expect(applyFolderScope).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('buildMainApi', () => {
  it('rolls back an in-memory grant when root persistence fails', async () => {
    const { store } = stubStore();
    const { mcp } = stubMcp();
    const { tray } = stubTray();
    const fileRoots = {
      grant: jest.fn(async () => ({
        id: 'new-root',
        name: 'Root',
        writable: true,
      })),
      revoke: jest.fn(async () => undefined),
      roots: jest.fn(async () => []),
    };
    const mainApi = buildMainApi({
      store,
      mcp,
      app: stubApp(),
      dataDir: '/fake/data',
      tray,
      ui: { openWindow: () => {} },
      outbound: stubOutbound(true).outbound,
      fileRoots: fileRoots as never,
      callerPluginId: 'kiagent.documents',
      persistFileRoots: async () => {
        throw new Error('disk full');
      },
    });
    await expect(
      mainApi.files.grantRoot('kiagent.documents', '/tmp/root', {
        name: 'Root',
        writable: true,
      }),
    ).rejects.toThrow('disk full');
    expect(fileRoots.revoke).toHaveBeenCalledWith(
      'kiagent.documents',
      'new-root',
    );
  });

  it('restores a revoked root when root persistence fails', async () => {
    const { store } = stubStore();
    const { mcp } = stubMcp();
    const { tray } = stubTray();
    const prior = {
      id: 'root',
      name: 'Root',
      writable: true,
      path: '/tmp/root',
      dev: '1',
      ino: '2',
    };
    const fileRoots = {
      resolve: jest.fn(async () => prior),
      revoke: jest.fn(async () => undefined),
      grant: jest.fn(async () => ({
        id: prior.id,
        name: prior.name,
        writable: prior.writable,
      })),
      roots: jest.fn(async () => []),
    };
    const mainApi = buildMainApi({
      store,
      mcp,
      app: stubApp(),
      dataDir: '/fake/data',
      tray,
      ui: { openWindow: () => {} },
      outbound: stubOutbound(true).outbound,
      fileRoots: fileRoots as never,
      callerPluginId: 'kiagent.documents',
      persistFileRoots: async () => {
        throw new Error('disk full');
      },
    });
    await expect(
      mainApi.files.revokeRoot('kiagent.documents', prior.id),
    ).rejects.toThrow('disk full');
    expect(fileRoots.grant).toHaveBeenCalledWith(
      'kiagent.documents',
      '/tmp/root',
      {
        id: 'root',
        name: 'Root',
        writable: true,
        identity: { dev: '1', ino: '2' },
      },
    );
  });

  it('serializes same-owner grants so a failed first persist cannot remove the second grant', async () => {
    const rootOne = await mkdtemp(join(tmpdir(), 'main-api-root-one-'));
    const rootTwo = await mkdtemp(join(tmpdir(), 'main-api-root-two-'));
    const persistFile = join(
      tmpdir(),
      `main-api-roots-${process.pid}-${Date.now()}.json`,
    );
    const { store } = stubStore();
    const { mcp } = stubMcp();
    const { tray } = stubTray();
    const fileRoots = createFileRootRegistry();
    const persist = createFileRootsPersistence(persistFile, fileRoots);
    let failFirstPersist = true;
    let firstPersistEntered!: () => void;
    const firstPersistReady = new Promise<void>((resolve) => {
      firstPersistEntered = resolve;
    });
    let releaseFirstPersist!: () => void;
    const firstPersistGate = new Promise<void>((resolve) => {
      releaseFirstPersist = resolve;
    });
    const mainApi = buildMainApi({
      store,
      mcp,
      app: stubApp(),
      dataDir: '/fake/data',
      tray,
      ui: { openWindow: () => {} },
      outbound: stubOutbound(true).outbound,
      fileRoots,
      callerPluginId: 'kiagent.documents',
      persistFileRoots: async () => {
        if (failFirstPersist) {
          failFirstPersist = false;
          firstPersistEntered();
          await firstPersistGate;
          throw new Error('disk full');
        }
        await persist();
      },
    });

    try {
      const first = mainApi.files.grantRoot('kiagent.documents', rootOne, {
        id: 'shared-root',
        name: 'First',
        writable: true,
      });
      await firstPersistReady;
      const second = mainApi.files.grantRoot('kiagent.documents', rootTwo, {
        id: 'shared-root',
        name: 'Second',
        writable: false,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      releaseFirstPersist();

      await expect(first).rejects.toThrow('disk full');
      await expect(second).resolves.toMatchObject({
        id: 'shared-root',
        name: 'Second',
        writable: false,
      });
      const resolvedRootTwo = await realpath(rootTwo);
      await expect(
        fileRoots.resolve('kiagent.documents', 'shared-root'),
      ).resolves.toMatchObject({
        path: resolvedRootTwo,
        name: 'Second',
        writable: false,
      });
      expect(JSON.parse(await readFile(persistFile, 'utf8'))).toEqual([
        expect.objectContaining({
          pluginId: 'kiagent.documents',
          id: 'shared-root',
          path: resolvedRootTwo,
          name: 'Second',
          writable: false,
        }),
      ]);
    } finally {
      await rm(rootOne, { recursive: true, force: true });
      await rm(rootTwo, { recursive: true, force: true });
      await rm(persistFile, { force: true });
    }
  });
  it.each(['kiagent.other', 'kiagent.documents:h1'])(
    'rejects a root grant owner that is not the calling bundled plugin id (%s)',
    async (owner) => {
      const { store } = stubStore();
      const { mcp } = stubMcp();
      const { tray } = stubTray();
      const fileRoots = {
        grant: jest.fn(),
        revoke: jest.fn(),
        roots: jest.fn(),
      };
      const mainApi = buildMainApi({
        store,
        mcp,
        app: stubApp(),
        dataDir: '/fake/data',
        tray,
        ui: { openWindow: () => {} },
        outbound: stubOutbound(true).outbound,
        fileRoots: fileRoots as never,
        callerPluginId: 'kiagent.documents',
      } as never);

      await expect(
        mainApi.files.grantRoot(owner, '/tmp/root', {
          name: 'Root',
          writable: true,
        }),
      ).rejects.toThrow(/owner|plugin|entitled|calling/i);
      expect(fileRoots.grant).not.toHaveBeenCalled();
    },
  );

  it('reads the live inference generation through the main-process API', () => {
    let generation = 7;
    const { store } = stubStore();
    const { mcp } = stubMcp();
    const { tray } = stubTray();
    const mainApi = buildMainApi({
      store,
      mcp,
      app: stubApp(),
      dataDir: '/fake/data',
      tray,
      ui: { openWindow: () => {} },
      outbound: stubOutbound(true).outbound,
      inference: { generation: () => generation },
    });

    expect(mainApi.inference?.generation()).toBe(7);
    generation = 8;
    expect(mainApi.inference?.generation()).toBe(8);
  });

  it('assembles the full MainProcessApi shape at apiVersion 1', async () => {
    const { store, identitySetArgs, vaultLoadArgs, vaultSaveArgs } =
      stubStore();
    const mcpStub = stubMcp();
    const { mcp, registerToolArgs } = mcpStub;
    const { tray } = stubTray();
    const app = stubApp();

    const mainApi = buildMainApi({
      store,
      mcp,
      app,
      dataDir: '/fake/data',
      tray,
      ui: { openWindow: () => {} },
      outbound: stubOutbound(true).outbound,
    });

    expect(mainApi.apiVersion).toBe(1);

    await expect(mainApi.identity.get()).resolves.toEqual({
      name: 'Ada',
      emails: [],
      phones: [],
    });
    await mainApi.identity.set({ name: 'Bob', emails: [], phones: [] });
    expect(identitySetArgs).toEqual([{ name: 'Bob', emails: [], phones: [] }]);

    await mainApi.vault.load('acc-1' as never);
    expect(vaultLoadArgs).toEqual(['acc-1']);
    await mainApi.vault.save('acc-1' as never, { accessToken: 'x' });
    expect(vaultSaveArgs).toEqual([['acc-1', { accessToken: 'x' }]]);

    expect(mainApi.mcp.port).toBe(7421);
    mainApi.mcp.registerTool({ name: 't' } as never);
    expect(registerToolArgs).toEqual([{ name: 't' }]);
    mainApi.mcp.createMcpHandler();
    expect(mcpStub.sessionHandlerCalls).toBe(1);

    expect(mainApi.paths.userData).toBe('/fake/userData');
    expect(mainApi.paths.dataDir).toBe('/fake/data');
    expect(mainApi.app.version).toBe('1.2.3');
    expect(mainApi.app.name).toBe('KIAgent');
  });

  it('ui.addTrayMenuItems appends into the tray rebuild and disposes cleanly', () => {
    const { store } = stubStore();
    const { mcp } = stubMcp();
    const { tray, addedGroups, disposed } = stubTray();
    const app = stubApp();

    const mainApi = buildMainApi({
      store,
      mcp,
      app,
      dataDir: '/fake',
      tray,
      ui: { openWindow: () => {} },
      outbound: stubOutbound(true).outbound,
    });

    const item = { label: 'Extension item' };
    const dispose = mainApi.ui.addTrayMenuItems([item]);

    expect(addedGroups).toEqual([[item]]);

    dispose();
    expect(disposed).toEqual([[item]]);
  });

  it('ui.addTrayMenuItems threads the position opts through to the tray', () => {
    const { store } = stubStore();
    const { mcp } = stubMcp();
    const addArgs: unknown[][] = [];
    const tray = {
      addItems: (items: unknown, opts?: unknown) => {
        addArgs.push([items, opts]);
        return () => {};
      },
    };
    const app = stubApp();

    const mainApi = buildMainApi({
      store,
      mcp,
      app,
      dataDir: '/fake',
      tray: tray as never,
      ui: { openWindow: () => {} },
      outbound: stubOutbound(true).outbound,
    });

    const item = { label: 'Status' };
    mainApi.ui.addTrayMenuItems([item], { position: 'top' });
    expect(addArgs).toEqual([[[item], { position: 'top' }]]);
  });

  it('ui.openWindow delegates to the injected dep', () => {
    const { store } = stubStore();
    const { mcp } = stubMcp();
    const { tray } = stubTray();
    const app = stubApp();
    let opened = 0;

    const mainApi = buildMainApi({
      store,
      mcp,
      app,
      dataDir: '/fake',
      tray,
      ui: {
        openWindow: () => {
          opened += 1;
        },
      },
      outbound: stubOutbound(true).outbound,
    });

    mainApi.ui.openWindow();
    expect(opened).toBe(1);
  });
});

describe('buildMainApi outbound dep', () => {
  it('delegates outbound.setRemoteBaseUrl and outbound.handleRequest to the service/routes', async () => {
    const { store } = stubStore();
    const { mcp } = stubMcp();
    const { tray } = stubTray();
    const app = stubApp();
    const { outbound, setRemoteBaseUrlArgs, handleRemoteArgs } =
      stubOutbound(true);

    const mainApi = buildMainApi({
      store,
      mcp,
      app,
      dataDir: '/fake',
      tray,
      ui: { openWindow: () => {} },
      outbound,
    });

    mainApi.outbound.setRemoteBaseUrl('https://device.example.com');
    mainApi.outbound.setRemoteBaseUrl(null);
    expect(setRemoteBaseUrlArgs).toEqual(['https://device.example.com', null]);

    const req = { fake: 'req' };
    const res = { fake: 'res' };
    await expect(
      mainApi.outbound.handleRequest(req as never, res as never),
    ).resolves.toBe(true);
    expect(handleRemoteArgs).toEqual([[req, res]]);
  });

  it('outbound.handleRequest propagates false when routes.handleRemote reports not-ours', async () => {
    const { store } = stubStore();
    const { mcp } = stubMcp();
    const { tray } = stubTray();
    const app = stubApp();
    const { outbound } = stubOutbound(false);

    const mainApi = buildMainApi({
      store,
      mcp,
      app,
      dataDir: '/fake',
      tray,
      ui: { openWindow: () => {} },
      outbound,
    });

    await expect(
      mainApi.outbound.handleRequest({} as never, {} as never),
    ).resolves.toBe(false);
  });
});
