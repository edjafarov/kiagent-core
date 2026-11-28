/**
 * The handshake's serverInfo.version is the app's version: the build defines
 * __KIA_APP_VERSION__ from release/app/package.json (the same file
 * app.getVersion() reads), and a build that defines nothing — jest, a
 * product's own dev webpack config — says so instead of claiming a release.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

type Global = typeof globalThis & { __KIA_APP_VERSION__?: string };

async function handshakeVersion(): Promise<string | undefined> {
  let makeMcpServer!: typeof import('../make-server').makeMcpServer;
  jest.isolateModules(() => {
    // eslint-disable-next-line global-require
    ({ makeMcpServer } = require('../make-server'));
  });
  const server = makeMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'probe', version: '0.0.0' });
  await client.connect(clientSide);
  const version = client.getServerVersion()?.version;
  await client.close();
  await server.close();
  return version;
}

describe('makeMcpServer serverInfo.version', () => {
  afterEach(() => {
    delete (globalThis as Global).__KIA_APP_VERSION__;
  });

  it('is the version the build defines', async () => {
    (globalThis as Global).__KIA_APP_VERSION__ = '4.5.6';
    expect(await handshakeVersion()).toBe('4.5.6');
  });

  it('is 0.0.0-dev when the build defines no version', async () => {
    expect(await handshakeVersion()).toBe('0.0.0-dev');
  });
});
