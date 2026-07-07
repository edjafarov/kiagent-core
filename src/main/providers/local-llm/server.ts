import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import type { LogLevel } from '@shared/contracts';

export interface ServerLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  baseUrl(): string;
}

const DEFAULTS = {
  host: '127.0.0.1',
  contextSize: 4096,
  startupTimeoutMs: 60_000,
  healthPollMs: 500,
  respawnBaseMs: 250,
  respawnMaxMs: 30_000,
  stopGraceMs: 3_000,
};

async function pickFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function defaultHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`);
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Forward a child stream to a sink line-by-line so partial chunks don't split. */
function forwardLines(
  stream: NodeJS.ReadableStream | null,
  sink: (line: string) => void,
): void {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      sink(buffer.slice(0, nl).replace(/\r$/, ''));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  });
  stream.on('close', () => {
    if (buffer) sink(buffer);
  });
}

/**
 * llama-server emits its ENTIRE log on stderr, each line carrying its own
 * severity letter after the timestamp (`<ts> I|W|E|D ...`) — so stderr-means-
 * error would mislabel routine slot/timing chatter as ERROR in the diagnostic
 * stream. Map the letter instead; unprefixed lines (ggml/Metal banners) are
 * informational, and hard failures still surface via exit codes upstream.
 */
function logServerLine(log: (level: LogLevel, msg: string) => void, line: string): void {
  const level = /^\S+ ([EWID]) /.exec(line)?.[1];
  const msg = `[llama-server] ${line}`;
  if (level === 'E') log('error', msg);
  else if (level === 'W') log('warn', msg);
  else log('info', msg);
}

/**
 * Default spawn: pipe stdout/stderr and forward each line to the main-process
 * log with a [llama-server] prefix. The child's own logging is the only signal
 * for diagnosing a model that won't load (mirrors converter/pool.ts using
 * 'inherit'), so — unlike the prior `stdio: 'ignore'` — we keep it. Injected
 * spawnFns (tests) bypass this entirely.
 */
function defaultSpawn(
  binaryPath: string,
  args: string[],
  _opts: { signal?: AbortSignal },
): ChildProcess {
  const child = spawn(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

export interface LlamaServerOptions {
  binaryPath: string;
  modelPath: string;
  mmprojPath: string;
  gpuLayers: number;
  log(level: LogLevel, msg: string): void;
  host?: string;
  port?: number;
  contextSize?: number;
  extraArgs?: string[];
  startupTimeoutMs?: number;
  healthPollMs?: number;
  respawnBaseMs?: number;
  respawnMaxMs?: number;
  stopGraceMs?: number;
  spawnFn?: (
    binaryPath: string,
    args: string[],
    opts: { signal?: AbortSignal },
  ) => ChildProcess;
  isHealthyAt?: (baseUrl: string) => Promise<boolean>;
}

/**
 * Supervises one llama-server child: spawn → health-poll → ready, with
 * crash respawn on the same backoff curve as converter/pool.ts. Out-of-process
 * by design so an OOM/crash degrades to a respawn instead of aborting Electron.
 */
export class LlamaServer implements ServerLike {
  private child: ChildProcess | null = null;

  private healthy = false;

  private url: string | null = null;

  private port = 0;

  private stopped = false;

  private respawnBackoff = 0;

  private respawnTimer: NodeJS.Timeout | null = null;

  private readonly o: Required<
    Omit<LlamaServerOptions, 'port' | 'extraArgs' | 'spawnFn' | 'isHealthyAt'>
  > &
    Pick<LlamaServerOptions, 'port' | 'extraArgs' | 'spawnFn' | 'isHealthyAt'>;

  constructor(options: LlamaServerOptions) {
    this.o = { ...DEFAULTS, ...options } as typeof this.o;
  }

  baseUrl(): string {
    return this.url || '';
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  /** Start and resolve once healthy, or reject on startup timeout. */
  async start(): Promise<void> {
    this.stopped = false;
    this.port = this.o.port ?? (await pickFreePort(this.o.host));
    this.url = `http://${this.o.host}:${this.port}`;
    this.launch();
    const child = this.child!;

    // Race health against an early spawn failure: a missing/unsigned binary
    // emits 'error' (ENOENT) immediately, so without this we'd ignore it and
    // only reject after the full startupTimeoutMs with a misleading "health
    // timed out" message — while the launch() 'error' handler had already
    // kicked off a background respawn loop. Listeners are removed once the race
    // settles (success or failure) so they can't reject a later, post-health
    // crash into nobody.
    let onError!: (err: Error) => void;
    let onExit!: (code: number | null, signal: NodeJS.Signals | null) => void;
    const earlyFailure = new Promise<never>((_resolve, reject) => {
      onError = (err) => reject(err);
      onExit = (code, signal) =>
        reject(
          new Error(
            `llama-server exited before becoming healthy ` +
              `(code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
          ),
        );
      child.once('error', onError);
      child.once('exit', onExit);
    });

    try {
      await Promise.race([
        this.waitHealthy(this.o.startupTimeoutMs),
        earlyFailure,
      ]);
    } catch (err) {
      // ANY start failure (timeout OR spawn error) must leave NO running child
      // and NO pending respawn. stop() disarms fully (stopped=true, timer
      // cleared, child killed + awaited); the manager creates a fresh
      // LlamaServer on retry, so a permanently-stopped failed instance is fine.
      await this.stop();
      throw err;
    } finally {
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    }
  }

  private launch(): void {
    const args = [
      '-m',
      this.o.modelPath,
      '--mmproj',
      this.o.mmprojPath,
      '--host',
      this.o.host,
      '--port',
      String(this.port),
      '-c',
      String(this.o.contextSize),
      '-ngl',
      String(this.o.gpuLayers ?? 999),
      '--cache-ram',
      '0',
      ...(this.o.extraArgs ?? []),
    ];
    const spawnFn = this.o.spawnFn ?? defaultSpawn;
    const child = spawnFn(this.o.binaryPath, args, {});
    this.child = child;
    child.on('exit', (code) => {
      if (this.child !== child) return; // superseded
      this.child = null;
      this.healthy = false;
      if (this.stopped || code === 0) return;
      this.scheduleRespawn();
    });
    child.on('error', () => {
      if (this.child !== child) return;
      this.child = null;
      this.healthy = false;
      if (!this.stopped) this.scheduleRespawn();
    });
    forwardLines(child.stdout, (line) => {
      logServerLine(this.o.log, line);
    });
    forwardLines(child.stderr, (line) => {
      logServerLine(this.o.log, line);
    });
  }

  private scheduleRespawn(): void {
    if (this.respawnTimer || this.stopped) return;
    this.respawnBackoff = Math.min(
      this.respawnBackoff ? this.respawnBackoff * 2 : this.o.respawnBaseMs,
      this.o.respawnMaxMs,
    );
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.stopped) return;
      this.launch();
      const { child } = this;
      void this.waitHealthy(this.o.startupTimeoutMs).catch(() => {
        // A respawned child that CRASHES re-fires 'exit' → backoff continues.
        // But one that stays ALIVE yet never returns 200 (wedged load, stolen
        // port) would swallow this timeout and wedge forever with a live child.
        // Force its exit so the 'exit' handler re-arms the backoff. Guard
        // against stop() (stopped) and against a child already replaced by a
        // crash's respawn (this.child !== child) or already gone.
        if (this.stopped) return;
        if (
          child &&
          this.child === child &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          child.kill('SIGKILL');
        }
      });
    }, this.respawnBackoff);
    this.respawnTimer.unref?.();
  }

  private async waitHealthy(timeoutMs: number): Promise<void> {
    const probe = this.o.isHealthyAt ?? defaultHealth;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.stopped) return;
      if (this.url && (await probe(this.url))) {
        this.healthy = true;
        this.respawnBackoff = 0;
        return;
      }
      await new Promise((r) => {
        const t = setTimeout(r, this.o.healthPollMs);
        t.unref?.();
      });
    }
    throw new Error('llama-server health check timed out');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.healthy = false;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    const { child } = this;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let killTimer: NodeJS.Timeout | null = null;
      // Drop the launch() respawn handlers so a SIGTERM/SIGKILL here can't be
      // mistaken for a crash; we own this child's exit now.
      child.removeAllListeners('exit');
      child.removeAllListeners('error');
      child.once('exit', () => {
        if (killTimer) clearTimeout(killTimer);
        resolve();
      });
      child.kill('SIGTERM');
      // A wedged native binary may ignore/slow-walk SIGTERM; escalate to
      // SIGKILL after a bounded grace so app-quit (before-quit) can't hang
      // forever waiting on a multi-GB process that won't go down gracefully.
      killTimer = setTimeout(() => {
        killTimer = null;
        child.kill('SIGKILL');
      }, this.o.stopGraceMs);
      killTimer.unref?.();
    });
  }
}
