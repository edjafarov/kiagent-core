/**
 * @jest-environment node
 *
 * Real llama-server, real EmbeddingGemma, through the provider. Opt-in:
 * KIA_E2E_LLAMA=1 plus the vendored binary (scripts/fetch-llama-server.mjs)
 * and the model at KIA_EMBED_GGUF (default: the eval copy). Skipped
 * otherwise — the decision is made here, from the files, not by the runner.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createLocalLlmProvider } from '../provider';
import { EMBEDDING_MODEL } from '../models';

const binary = path.resolve(
  __dirname,
  '../../../../../assets/llama/darwin-arm64/llama-server',
);
const gguf =
  process.env.KIA_EMBED_GGUF ??
  path.join(
    os.homedir(),
    'work/eval-models/classify/embeddinggemma-300m-qat-Q8_0.gguf',
  );
const enabled =
  process.env.KIA_E2E_LLAMA === '1' &&
  fs.existsSync(binary) &&
  fs.existsSync(gguf);

(enabled ? it : it.skip)(
  'embeds 768-d vectors, identical for the same text',
  async () => {
    const models = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-e2e-'));
    const dir = path.join(models, EMBEDDING_MODEL.id);
    fs.mkdirSync(dir);
    fs.symlinkSync(gguf, path.join(dir, EMBEDDING_MODEL.files[0].name));
    const provider = createLocalLlmProvider({
      llamaBinaryPath: binary,
      modelsDir: models,
      prefs: {
        get: () =>
          ({ models: { override: 'auto', autoInstall: false } }) as any,
        patch: async () => {},
        onChange: () => () => {},
      },
      log: () => {},
      filesPresent: (_m, d) => fs.existsSync(d),
    });
    try {
      expect(provider.embedProvider.status()).toBe('ready');
      const text = 'Email from Ana. Subject: Lunch\nAre you free Friday?';
      const run = async () =>
        (await provider.embedProvider.handle({
          kind: 'embed',
          payload: { texts: [text, 'Chat from Bo. Subject: \nok'] },
          lane: 'background',
        })) as Float32Array[];
      const a = await run();
      const b = await run();
      expect(a).toHaveLength(2);
      expect(a[0]).toHaveLength(768);
      expect(Array.from(a[0])).toEqual(Array.from(b[0]));
      expect(Array.from(a[0])).not.toEqual(Array.from(a[1]));
    } finally {
      await provider.dispose();
      fs.rmSync(models, { recursive: true, force: true });
    }
  },
  120_000,
);
