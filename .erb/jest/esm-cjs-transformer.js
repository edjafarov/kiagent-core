// Jest transformer: converts ESM-only JS (e.g. franc-min) to CommonJS so it
// can be required in the CJS Jest environment. Uses TypeScript's transpileModule
// because it's already a project dependency and handles ESM→CJS reliably.
// getCacheKey folds in the typescript version so the cache invalidates on upgrades.
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
      fileName: sourcePath,
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
