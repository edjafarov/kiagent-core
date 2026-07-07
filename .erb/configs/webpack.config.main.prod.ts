/**
 * Webpack config for production electron main process
 */

import path from 'path';
import webpack from 'webpack';
import { merge } from 'webpack-merge';
import TerserPlugin from 'terser-webpack-plugin';
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer';
import baseConfig from './webpack.config.base';
import oauthEnvDefines from './oauth-env';
import webpackPaths from './webpack.paths';
import checkNodeEnv from '../scripts/check-node-env';
import deleteSourceMaps from '../scripts/delete-source-maps';

checkNodeEnv('production');
deleteSourceMaps();

const configuration: webpack.Configuration = {
  devtool: 'source-map',

  mode: 'production',

  target: 'electron-main',

  entry: {
    main: path.join(webpackPaths.srcMainPath, 'main.ts'),
    preload: path.join(webpackPaths.srcMainPath, 'preload.ts'),
    worker: path.join(webpackPaths.srcMainPath, 'converter/worker.ts'),
    dbWorker: path.join(webpackPaths.srcMainPath, 'db/worker-entry.ts'),
    mcpStdio: path.join(webpackPaths.srcMainPath, 'mcp/stdio-entry.ts'),
    extensionHost: path.join(
      webpackPaths.srcMainPath,
      'platform/extension-host-entry.ts',
    ),
  },

  output: {
    path: webpackPaths.distMainPath,
    filename: '[name].js',
    // commonjs2 keeps `require(<external>)` inline at the call site.
    // UMD eagerly requires every external in the wrapper, which on Windows
    // crashed startup the moment `electron-debug` (ESM-only) was touched:
    // Node 22's sync require-of-ESM rejects the `electron:` URL that asar
    // resolution returns, with ERR_UNSUPPORTED_ESM_URL_SCHEME.
    library: {
      type: 'commonjs2',
    },
  },

  optimization: {
    minimizer: [
      new TerserPlugin({
        parallel: true,
        // oidc-provider dispatches on runtime class names: its token "dynamic"
        // format resolves `formats.dynamic[this.constructor.name]` (AccessToken,
        // AuthorizationCode, RefreshToken, …) and other libs key off fn.name.
        // Terser's default name-mangling renames AccessToken → `c`, so the
        // lookup returns undefined and the authorization_code → access_token
        // exchange throws `…dynamic[this.constructor.name] is not a function`,
        // surfacing to MCP clients as a generic "authorization failed". This
        // only bites the minified production build (dev is unminified), so keep
        // class + function names intact.
        terserOptions: {
          keep_classnames: true,
          keep_fnames: true,
        },
      }),
    ],
  },

  plugins: [
    new BundleAnalyzerPlugin({
      analyzerMode: process.env.ANALYZE === 'true' ? 'server' : 'disabled',
      analyzerPort: 8888,
    }),

    /**
     * Create global constants which can be configured at compile time.
     *
     * Useful for allowing different behaviour between development builds and
     * release builds
     *
     * NODE_ENV should be production so that modules do not perform certain
     * development checks
     */
    new webpack.EnvironmentPlugin({
      NODE_ENV: 'production',
      DEBUG_PROD: false,
      START_MINIMIZED: false,
    }),

    new webpack.DefinePlugin({
      'process.type': '"browser"',
      ...oauthEnvDefines(),
    }),
  ],

  /**
   * Disables webpack processing of __dirname and __filename.
   * If you run the bundle in node.js it falls back to these values of node.js.
   * https://github.com/webpack/webpack/issues/2010
   */
  node: {
    __dirname: false,
    __filename: false,
  },
};

export default merge(baseConfig, configuration);
