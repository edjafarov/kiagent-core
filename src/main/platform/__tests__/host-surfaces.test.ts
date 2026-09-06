/** @jest-environment node */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import type { Query } from '@shared/contracts';

import { LaneClosedError } from '@main/core/inference';

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
        hear: jest.fn(
          async (_a: Uint8Array, opts?: { format?: string; lane?: string }) =>
            `heard:${opts?.format}:${opts?.lane}`,
        ),
        lane: jest.fn(async () => 'open' as const),
      },
      notify: jest.fn(),
      bus,
      deliverEvent: (name: string, payload: unknown) =>
        events.push({ name, payload }),
      ...overrides,
    },
  };
}

describe('createEventBus', () => {
  it('isolates subscribers: one throwing does not stop the next from receiving the event', () => {
    const logSink = { log: jest.fn() };
    const bus = createEventBus(logSink as never);
    const seenByFirst: unknown[] = [];
    const seenBySecond: unknown[] = [];
    bus.subscribe('ext.a', 'ping', () => {
      throw new Error('dead transport');
    });
    bus.subscribe('ext.b', 'ping', (p) => seenByFirst.push(p));
    bus.subscribe('ext.c', 'ping', (p) => seenBySecond.push(p));

    expect(() => bus.emit('platform', 'ping', { n: 1 })).not.toThrow();

    expect(seenByFirst).toEqual([{ n: 1 }]);
    expect(seenBySecond).toEqual([{ n: 1 }]);
    expect(logSink.log).toHaveBeenCalledWith(
      'platform',
      'warn',
      "event subscriber for 'ping' threw",
      { error: expect.stringContaining('dead transport') },
    );
  });

  it('a subsequent distinct emit is still delivered to every subscriber after an earlier throw', () => {
    const logSink = { log: jest.fn() };
    const bus = createEventBus(logSink as never);
    const seen: unknown[] = [];
    bus.subscribe('ext.a', 'ping', () => {
      throw new Error('still dead');
    });
    bus.subscribe('ext.b', 'ping', (p) => seen.push(p));

    bus.emit('platform', 'ping', { n: 1 });
    bus.emit('platform', 'ping', { n: 2 });

    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('works with no logSink supplied (every existing caller keeps compiling unchanged)', () => {
    const bus = createEventBus();
    const seen: unknown[] = [];
    bus.subscribe('ext.a', 'ping', () => {
      throw new Error('dead transport');
    });
    bus.subscribe('ext.b', 'ping', (p) => seen.push(p));

    expect(() => bus.emit('platform', 'ping', { n: 1 })).not.toThrow();
    expect(seen).toEqual([{ n: 1 }]);
  });
});

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

  /* The escape this policy exists for: ATTACH opens — and creates — any path
   * through the same handle, so "your own database" meant the filesystem and
   * the corpus. Asserting the refusal is not enough; assert no file appeared. */
  it('db refuses ATTACH and VACUUM INTO, and writes no file outside dataDir', async () => {
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    const escape = path.join(os.tmpdir(), `kia-attach-escape-${Date.now()}.db`);

    await expect(
      surfaces.db.exec(`ATTACH DATABASE '${escape}' AS out`),
    ).rejects.toThrow(/ATTACH/);
    await expect(
      surfaces.db.query(`ATTACH DATABASE '${escape}' AS out`),
    ).rejects.toThrow(/ATTACH/);
    await expect(
      surfaces.db.exec(`SELECT 1; ATTACH DATABASE '${escape}' AS out`),
    ).rejects.toThrow(/ATTACH/);
    await expect(surfaces.db.exec(`VACUUM INTO '${escape}'`)).rejects.toThrow(
      /VACUUM INTO/,
    );
    // The second hop of the chain: with no attachment, the alias resolves to
    // nothing rather than to a file the extension just made.
    await expect(
      surfaces.db.exec('CREATE TABLE out.stolen (x TEXT)'),
    ).rejects.toThrow(/unknown database/i);

    // Load-bearing, not decorative: ATTACH alone creates the file, so before
    // this policy the very first call above would have left one here.
    expect(fs.existsSync(escape)).toBe(false);
    close();
  });

  /* The success path, redirect re-validation and the byte cap are covered
   * hermetically in net-guard.test.ts. What matters here is that the wiring is
   * real: a live loopback server — the shape of the loopback MCP listener an
   * extension would target — must not be reachable through the surface. */
  it('net.fetch refuses a live loopback server and non-http urls', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('should never be read');
    });
    await new Promise<void>((r) => {
      srv.listen(0, '127.0.0.1', r);
    });
    const { port } = srv.address() as { port: number };
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);

    await expect(
      surfaces.net.fetch(`http://127.0.0.1:${port}/`),
    ).rejects.toThrow(/loopback/);
    await expect(
      surfaces.net.fetch(`http://localhost:${port}/`),
    ).rejects.toThrow(/loopback/);
    await expect(surfaces.net.fetch('file:///etc/passwd')).rejects.toThrow(
      /http/,
    );
    close();
    srv.close();
  });

  it('defaults to the interactive lane and passes background through', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { deps } = makeDeps({
      inference: {
        complete: async (_p, opts) => {
          calls.push({ ...opts });
          return 'ok';
        },
        see: async () => '',
        read: async () => '',
        hear: async () => '',
        lane: async () => 'open' as const,
      },
    });
    const { surfaces } = buildSurfaces(deps);
    await surfaces.inference.complete('hi', { maxTokens: 8 } as never);
    await surfaces.inference.complete('hi', {
      maxTokens: 8,
      lane: 'background',
    } as never);
    expect(calls[0].lane).toBe('interactive');
    expect(calls[1].lane).toBe('background');
  });

  it('propagates LaneClosedError unchanged', async () => {
    const { deps } = makeDeps({
      inference: {
        complete: async () => {
          throw new LaneClosedError();
        },
        see: async () => '',
        read: async () => '',
        hear: async () => '',
        lane: async () => 'until-idle' as const,
      },
    });
    const { surfaces } = buildSurfaces(deps);
    await expect(
      surfaces.inference.complete('hi', {
        maxTokens: 8,
        lane: 'background',
      } as never),
    ).rejects.toMatchObject({ name: 'LaneClosedError' });
  });

  it('reports the plane lane state', async () => {
    const { deps } = makeDeps({});
    const { surfaces } = buildSurfaces(deps);
    await expect(surfaces.inference.lane()).resolves.toBe('open');
  });

  it('inference.hear delegates to the plane, keeping format and passing the lane through', async () => {
    // CapSurfaces.inference promises the WHOLE Inference plane, so a child
    // granted 'inference' may call hear() — before it was wired here that
    // call reached an undefined surface method.
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    await expect(
      surfaces.inference.hear(new Uint8Array([1, 2]), {
        format: 'wav',
        lane: 'background',
      } as never),
    ).resolves.toBe('heard:wav:background');
    expect(deps.inference.hear).toHaveBeenCalledWith(new Uint8Array([1, 2]), {
      format: 'wav',
      lane: 'background',
    });
    close();
  });

  it("inference.hear forwards vad:'required' through the opts spread alongside the default lane", async () => {
    // The provider-level tests prove `vad:'required'` fail-closed behaviour;
    // this proves the field actually SURVIVES the extension-boundary spread
    // (`{ lane: 'interactive', ...(opts as object) }`) rather than being
    // dropped or renamed on the way from an extension call to the dep.
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    await expect(
      surfaces.inference.hear(new Uint8Array([1, 2]), {
        format: 'wav',
        timestamps: true,
        vad: 'required',
      } as never),
    ).resolves.toBe('heard:wav:interactive');
    expect(deps.inference.hear).toHaveBeenCalledWith(new Uint8Array([1, 2]), {
      format: 'wav',
      timestamps: true,
      vad: 'required',
      lane: 'interactive',
    });
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
