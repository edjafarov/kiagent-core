// Jest transformer: converts our own vendored-scripts ESM (`.mjs`, e.g.
// scripts/whisper-assets.mjs) to CommonJS so it can be required from a TS
// jest test in this repo's CJS Jest environment (no --experimental-vm-modules).
// Reuses the same ts.transpileModule approach as esm-cjs-transformer.js, but
// that file's `module: CommonJS` compiler option is silently overridden by
// TypeScript back to ESM whenever the fileName passed to transpileModule ends
// in `.mjs` (TS infers module format from extension). Renaming the fileName
// to `.js` for the compiler call sidesteps that without touching the source.
const ts = require('typescript');
const crypto = require('crypto');
const tsVersion = require('typescript/package.json').version;

module.exports = {
  process(sourceText, sourcePath) {
    const result = ts.transpileModule(sourceText, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        allowJs: true,
        esModuleInterop: true,
      },
      fileName: sourcePath.replace(/\.mjs$/, '.js'),
    });
    return { code: result.outputText };
  },

  getCacheKey(sourceText, sourcePath) {
    return crypto
      .createHash('sha1')
      .update(sourceText)
      .update(sourcePath)
      .update(tsVersion)
      .digest('hex');
  },
};
