/** @jest-environment node */
import path from 'path';

import {
  createInMemoryHostPair,
  createRpcEndpoint,
  nodeForkTransport,
  utilityProcessTransport,
} from '../transport';

jest.mock('electron', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { EventEmitter } = require('events');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { PassThrough } = require('stream');
  class FakeChild extends EventEmitter {
    postMessage = jest.fn();

    kill = jest.fn();

    stdout = new PassThrough();

    stderr = new PassThrough();
  }
  const children: InstanceType<typeof FakeChild>[] = [];
  const forkOptions: unknown[] = [];
  return {
    utilityProcess: {
      fork: jest.fn((_path: string, _args: string[], opts: unknown) => {
        forkOptions.push(opts);
        const c = new FakeChild();
        children.push(c);
        return c;
      }),
    },
    __children: children,
    __forkOptions: forkOptions,
  };
});

describe('createRpcEndpoint over the in-memory pair', () => {
  it('correlates call → reply in both directions', async () => {
    const { main, child } = createInMemoryHostPair();
    const mainEp = createRpcEndpoint(main);
    const childEp = createRpcEndpoint(child);
    childEp.onCall(async (ns, method, args) => `${ns}.${method}(${args.join(',')})`);
    mainEp.onCall(async (ns) => `main saw ${ns}`);
    await expect(mainEp.call('query', 'search', [1, 2])).resolves.toBe('query.search(1,2)');
    await expect(childEp.call('auth', 'prompt', [])).resolves.toBe('main saw auth');
  });

  it('propagates handler errors as rejections with the message', async () => {
    const { main, child } = createInMemoryHostPair();
    const mainEp = createRpcEndpoint(main);
    createRpcEndpoint(child).onCall(async () => {
      throw new Error('CAP_DENIED: nope');
    });
    await expect(mainEp.call('db', 'exec', [])).rejects.toThrow('CAP_DENIED: nope');
  });

  it('delivers non-call messages to onNotify and dispose rejects in-flight calls', async () => {
    const { main, child } = createInMemoryHostPair();
    const mainEp = createRpcEndpoint(main);
    const childEp = createRpcEndpoint(child);
    const seen: string[] = [];
    childEp.onNotify((m) => seen.push(m.kind));
    mainEp.post({ kind: 'src-next', pullId: 1 });
    await new Promise((r) => { setTimeout(r, 10); });
    expect(seen).toEqual(['src-next']);

    const pending = mainEp.call('query', 'count', []); // child has no onCall → hangs
    mainEp.dispose('process exited');
    await expect(pending).rejects.toThrow('process exited');
  });
});

describe('utilityProcessTransport (mocked electron)', () => {
  it('delivers child messages raw — UtilityProcess "message" passes the message, not a MessageEvent', () => {
    const t = utilityProcessTransport('/fake/extensionHost.js', 'kia-ext:test');
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const electron = require('electron') as { __children: NodeJS.EventEmitter[] };
    const child = electron.__children[electron.__children.length - 1];
    const seen: unknown[] = [];
    t.onMessage((m) => seen.push(m));
    child.emit('message', { kind: 'ready' });
    expect(seen).toEqual([{ kind: 'ready' }]);
  });

  it('with onOutput: forks with piped stdio and delivers child output line by line', async () => {
    // Without this, a crashing child's '[ext-host] uncaught: …' line (its
    // ONLY trace) vanishes — the main log shows just exit code 1.
    const lines: Array<[string, string]> = [];
    utilityProcessTransport('/fake/extensionHost.js', 'kia-ext:test', (stream, line) =>
      lines.push([stream, line]),
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const electron = require('electron') as {
      __children: Array<NodeJS.EventEmitter & { stdout: NodeJS.ReadWriteStream; stderr: NodeJS.ReadWriteStream }>;
      __forkOptions: Array<{ stdio?: string }>;
    };
    expect(electron.__forkOptions[electron.__forkOptions.length - 1].stdio).toBe('pipe');
    const child = electron.__children[electron.__children.length - 1];
    child.stderr.write('[ext-host] uncaught: boom\n    at crash (source.ts:1:1)\npartial');
    child.stdout.write('hello\n');
    await new Promise((r) => { setImmediate(r); });
    expect(lines).toEqual([
      ['stderr', '[ext-host] uncaught: boom'],
      ['stderr', '    at crash (source.ts:1:1)'],
      ['stdout', 'hello'],
    ]);
    // The buffered partial line lands when the stream ends (process death).
    child.stderr.end();
    await new Promise((r) => { setImmediate(r); });
    expect(lines[lines.length - 1]).toEqual(['stderr', 'partial']);
  });

  it('without onOutput: keeps stdio ignored (no stream plumbing for silent hosts)', () => {
    utilityProcessTransport('/fake/extensionHost.js', 'kia-ext:test');
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const electron = require('electron') as { __forkOptions: Array<{ stdio?: string }> };
    expect(electron.__forkOptions[electron.__forkOptions.length - 1].stdio).toBe('ignore');
  });
});

describe('nodeForkTransport (real child process)', () => {
  it('round-trips a message with an echoing plain-JS child and reports exit', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'echo-child.js');
    const t = nodeForkTransport(fixture);
    const got = new Promise<unknown>((resolve) => {
      const off = t.onMessage((m) => { off(); resolve(m); });
    });
    t.send({ kind: 'ping', n: 41 });
    await expect(got).resolves.toEqual({ kind: 'pong', n: 42 });
    const exited = new Promise<number | null>((resolve) => t.onExit(resolve));
    t.send({ kind: 'quit' });
    await expect(exited).resolves.toBe(0);
  }, 15000);
});
