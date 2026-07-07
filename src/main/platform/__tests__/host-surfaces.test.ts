/** @jest-environment node */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import type { Query } from '@shared/contracts';

import { buildSurfaces, CapError, createEventBus } from '../host-surfaces';

const fakeQuery = {
  document: jest.fn(async () => null),
  children: jest.fn(async () => []),
  byExternalId: jest.fn(async () => null),
  search: jest.fn(async () => [{ id: 'd1' }]),
  count: jest.fn(async () => 7),
  accounts: jest.fn(async () => []),
} as unknown as Query;

function makeDeps(
  overrides: Partial<Parameters<typeof buildSurfaces>[0]> = {},
) {
  const bus = createEventBus();
  const events: Array<{ name: string; payload: unknown }> = [];
  return {
    events,
    deps: {
      extensionId: 'test.basic',
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kia-ext-data-')),
      query: fakeQuery,
      inference: {
        complete: jest.fn(
          async (_p: string, opts?: { lane?: string }) => `lane:${opts?.lane}`,
        ),
        see: jest.fn(async () => 'seen'),
        read: jest.fn(async () => 'read'),
      },
      notify: jest.fn(),
      bus,
      deliverEvent: (name: string, payload: unknown) =>
        events.push({ name, payload }),
      ...overrides,
    },
  };
}

describe('buildSurfaces', () => {
  it('query delegates and count round-trips', async () => {
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    await expect(surfaces.query.count({})).resolves.toBe(7);
    await expect(surfaces.query.search({})).resolves.toEqual([{ id: 'd1' }]);
    close();
  });

  it('query.byExternalId forwards three positional args to delegate', async () => {
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    await surfaces.query.byExternalId('acc1', 'ext1', 'email');
    expect(deps.query.byExternalId).toHaveBeenCalledWith(
      'acc1',
      'ext1',
      'email',
    );
    close();
  });

  it('db is a private sqlite file under dataDir that round-trips rows', async () => {
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    await surfaces.db.exec('CREATE TABLE t (a TEXT)');
    await surfaces.db.exec('INSERT INTO t VALUES (?)', ['hello']);
    await expect(surfaces.db.query('SELECT a FROM t')).resolves.toEqual([
      { a: 'hello' },
    ]);
    close();
    expect(fs.existsSync(path.join(deps.dataDir, 'private.db'))).toBe(true);
  });

  it('net.fetch hits a real server and returns bytes; rejects non-http urls', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(201, { 'x-kia': 'yes' });
      res.end('body!');
    });
    await new Promise<void>((r) => {
      srv.listen(0, '127.0.0.1', r);
    });
    const { port } = srv.address() as { port: number };
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    const res = (await surfaces.net.fetch(`http://127.0.0.1:${port}/`)) as {
      status: number;
      headers: Record<string, string>;
      body: Uint8Array;
    };
    expect(res.status).toBe(201);
    expect(res.headers['x-kia']).toBe('yes');
    expect(Buffer.from(res.body).toString()).toBe('body!');
    await expect(surfaces.net.fetch('file:///etc/passwd')).rejects.toThrow(
      /http/,
    );
    close();
    srv.close();
  });

  it('inference forces the interactive lane', async () => {
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    await expect(
      surfaces.inference.complete('p', { lane: 'background' } as never),
    ).resolves.toBe('lane:interactive');
    close();
  });

  it('events: on delivers bus emissions, off stops them, emit reaches other subscribers', async () => {
    const bus = createEventBus();
    const a = makeDeps({ bus });
    const b = makeDeps({ bus, extensionId: 'other.ext' } as never);
    const sa = buildSurfaces(a.deps);
    const sb = buildSurfaces(b.deps);
    sa.surfaces.events.on('ping');
    sb.surfaces.events.emit('ping', { n: 1 });
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    expect(a.events).toEqual([{ name: 'ping', payload: { n: 1 } }]);
    sa.surfaces.events.off('ping');
    sb.surfaces.events.emit('ping', { n: 2 });
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    expect(a.events).toHaveLength(1);
    sa.close();
    sb.close();
  });

  it('delivers events to the emitter itself when subscribed (self-delivery contract)', async () => {
    const { events, deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    surfaces.events.on('ping');
    surfaces.events.emit('ping', { v: 1 });
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    expect(events).toEqual([{ name: 'ping', payload: { v: 1 } }]);
    close();
  });

  it('events.emit rejects platform-reserved name prefixes (M2)', async () => {
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    expect(() =>
      surfaces.events.emit('extension.activated', { id: 'other.ext' }),
    ).toThrow(CapError);
    expect(() => surfaces.events.emit('platform.anything', {})).toThrow(
      CapError,
    );
    // Ordinary event names are unaffected.
    expect(() => surfaces.events.emit('ping', {})).not.toThrow();
    close();
  });

  it('files and commands throw CapError', async () => {
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    expect(() => surfaces.files.read('x')).toThrow(CapError);
    expect(() => surfaces.commands.register('c')).toThrow(
      /not supported in this build yet/,
    );
    close();
  });
});
