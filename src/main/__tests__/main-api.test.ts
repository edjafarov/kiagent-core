import { buildMainApi } from '../main-api';
import type { CoreStore } from '../core/store/store';
import type { McpServerHandle } from '../core/mcp/server';
import type { TrayMenuController } from '../tray-menu';

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

describe('buildMainApi', () => {
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

    const mainApi = buildMainApi({ store, mcp, app, dataDir: '/fake', tray });

    const item = { label: 'Extension item' };
    const dispose = mainApi.ui.addTrayMenuItems([item]);

    expect(addedGroups).toEqual([[item]]);

    dispose();
    expect(disposed).toEqual([[item]]);
  });
});
