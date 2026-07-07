/**
 * Base webpack config used across other specific configs
 */

import webpack from 'webpack';
import TsconfigPathsPlugins from 'tsconfig-paths-webpack-plugin';
import webpackPaths from './webpack.paths';
// release/app holds the packaged-app deps list (webpack externals); the
// relative reach-in is deliberate (the autofix suggestion resolves to the
// wrong package.json).
// eslint-disable-next-line import/no-relative-packages
import { dependencies as externals } from '../../release/app/package.json';

const configuration: webpack.Configuration = {
  externals: [...Object.keys(externals || {})],

  // 'minimal' prints a one-line "compiled successfully in Xms" on success (and
  // full errors on failure). Previously 'errors-only' meant a successful build
  // printed NOTHING, which reads like the build silently did nothing — see the
  // one-shot `build:main`/`build:renderer` scripts.
  stats: 'minimal',

  // This is an Electron desktop app: the renderer bundle loads from local disk,
  // not over a network, so webpack's 244 KiB asset/entrypoint size hints (a web
  // heuristic) are noise. Disabling them keeps the 'minimal' summary clean.
  performance: { hints: false },

  // Unactionable warnings from bundled tooling deps (ts-node,
  // v8-compile-cache-lib, source-map-support) that webpack can't statically
  // analyze: "Critical dependency: require function is used..." and
  // "require.extensions is not supported by webpack". Scoped to node_modules so
  // the same warnings in our own src/ would still surface.
  ignoreWarnings: [
    {
      module: /node_modules/,
      message: /Critical dependency|require\.extensions is not supported/,
    },
  ],

  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            // Remove this line to enable type checking in webpack builds
            transpileOnly: true,
            compilerOptions: {
              module: 'nodenext',
              moduleResolution: 'nodenext',
            },
          },
        },
      },
      {
        // Inline .sql files as string modules so schema.sql ships with the
        // main bundle and doesn't need to be located on disk at runtime.
        test: /\.sql$/,
        type: 'asset/source',
      },
      {
        // Inline .css files when imported with `?raw` — used by Electron
        // main consent templates to bundle shared shell CSS as strings.
        // Renderer-side CSS imports (no ?raw) are handled by css-loader in
        // webpack.config.renderer.*.
        resourceQuery: /raw/,
        test: /\.css$/,
        type: 'asset/source',
      },
    ],
  },

  output: {
    path: webpackPaths.srcPath,
    // https://github.com/webpack/webpack/issues/1114
    library: { type: 'commonjs2' },
  },

  /**
   * Determine the array of extensions that should be used to resolve modules.
   */
  resolve: {
    extensions: ['.js', '.jsx', '.json', '.ts', '.tsx'],
    // Allow TypeScript source files to be imported with .js extension (ESM-style).
    // Needed for dynamic imports like `import('./instance.js')` inside src/.
    extensionAlias: {
      '.js': ['.ts', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    },
    modules: [webpackPaths.srcPath, 'node_modules'],
    // There is no need to add aliases here, the paths in tsconfig get mirrored
    plugins: [new TsconfigPathsPlugins()],
  },

  plugins: [new webpack.EnvironmentPlugin({ NODE_ENV: 'production' })],
};

export default configuration;
