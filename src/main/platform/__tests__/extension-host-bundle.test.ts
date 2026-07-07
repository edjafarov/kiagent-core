/** @jest-environment node */
/**
 * Artifact-level regression net: compiles the extensionHost child entry with
 * the REAL dev webpack config, forks the emitted bundle over node IPC, and
 * bootstraps it against an on-disk fixture extension. Two shipped bugs lived
 * only in this compiled artifact and were invisible to every source-level
 * test (webpack rewrote the child's dynamic `require` into an empty context
 * module, so loading any absolute extension path threw "Cannot find
 * module"). The ts-node e2e fork cannot catch that class — only running the
 * webpack output can.
 */
import { fork } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import webpack from 'webpack';

// eslint-disable-next-line import/no-relative-packages
import devConfig from '../../../../.erb/configs/webpack.config.main.dev';

jest.setTimeout(60_000);

describe('webpack-compiled extensionHost bundle', () => {
  let outDir: string;

  beforeAll(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-host-bundle-'));
  });

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('loads an on-disk extension by absolute path and activates it', async () => {
    const config: webpack.Configuration = {
      ...devConfig,
      entry: { extensionHost: path.join(__dirname, '..', 'extension-host-entry.ts') },
      output: { ...devConfig.output, path: outDir },
      // inline-source-map bloats the throwaway build; not under test.
      devtool: false,
    };
    const stats = await new Promise<webpack.Stats | undefined>((resolve, reject) => {
      webpack(config, (err, s) => (err ? reject(err) : resolve(s)));
    });
    expect(stats?.hasErrors() ?? true).toBe(false);
    const bundlePath = path.join(outDir, 'extensionHost.bundle.dev.js');
    expect(fs.existsSync(bundlePath)).toBe(true);

    const dataDir = fs.mkdtempSync(path.join(outDir, 'data-'));
    const child = fork(bundlePath, [], {
      env: { ...process.env, KIA_EXT_HOST_CHILD: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      const activated = new Promise<{ kind: string } & Record<string, unknown>>(
        (resolve, reject) => {
          child.on('message', (m: { kind: string } & Record<string, unknown>) => {
            if (m.kind === 'errored') reject(new Error(String(m.error)));
            if (m.kind === 'activated') resolve(m);
          });
          child.on('exit', (code) => reject(new Error(`child exited early (${code})`)));
        },
      );
      child.send({
        kind: 'bootstrap',
        v: 1,
        extensionId: 'test.basic',
        entryAbsPath: path.join(__dirname, 'fixtures', 'ext-basic', 'index.js'),
        dataDir,
        caps: ['net'],
      });
      const outcome = await activated;
      const contributions = outcome.contributions as {
        sources: { descriptor: { id: string } }[];
      };
      expect(contributions.sources.map((s) => s.descriptor.id)).toEqual(['basicsrc']);
    } finally {
      child.kill();
    }
  });
});
