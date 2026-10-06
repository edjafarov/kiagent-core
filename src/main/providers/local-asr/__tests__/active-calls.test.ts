import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createActiveCalls } from '../../../core/active-calls';
import { createLocalAsrProvider } from '../index';
import { WHISPER_LARGE_V3_TURBO_Q5_0 } from '../models';

const tick = () => new Promise((r) => setTimeout(r, 20));

it('hear is recorded when the job starts running, not while queued', async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'asr-active-calls-'));
  const modelPath = path.join(tmpDir, WHISPER_LARGE_V3_TURBO_Q5_0.id);
  const gates: Array<(t: string) => void> = [];
  const runCli = jest.fn(() => new Promise<string>((res) => gates.push(res)));
  let prefs: any = {
    theme: 'system',
    logLevel: 'info',
    launchAtLogin: false,
    showInMenuBar: false,
    processing: { enabled: true, window: 'always' },
    models: { override: 'auto', autoInstall: true },
  };
  const activeCalls = createActiveCalls();
  const provider = createLocalAsrProvider({
    binaryPath: '/opt/kiagent/whisper/whisper-cli',
    asrModelsDir: tmpDir,
    prefs: {
      get: () => prefs,
      patch: async (p: any) => {
        prefs = { ...prefs, ...p };
      },
      onChange: () => () => {},
    } as any,
    log: jest.fn(),
    probes: { platform: 'darwin', totalMemBytes: 32 * 1024 ** 3 },
    binaryPresent: () => true,
    filesPresent: (_m: any, dir: string) => dir === modelPath,
    download: jest.fn(async () => {}),
    runCli,
    activeCalls,
  } as any);

  const p1 = provider.transcribeFile('/a.wav', { format: 'wav' });
  const p2 = provider.transcribeFile('/b.wav', { format: 'wav' });
  await tick();
  expect(runCli).toHaveBeenCalledTimes(1);
  expect(activeCalls.list()).toEqual([{ op: 'hear', task: null }]);

  gates[0]('first');
  await p1;
  await tick();
  expect(runCli).toHaveBeenCalledTimes(2);
  expect(activeCalls.list()).toEqual([{ op: 'hear', task: null }]);

  gates[1]('second');
  await p2;
  await tick();
  expect(activeCalls.list()).toEqual([]);
});
