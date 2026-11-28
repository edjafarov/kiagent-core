import fs from 'fs';
import webpackPaths from './webpack.paths';

/**
 * The app's version for the main-process bundles, read when webpack starts
 * from release/app/package.json — the file app.getVersion() reads at
 * runtime, and the one a product build stamps before it bundles. Becomes
 * `__KIA_APP_VERSION__` (core/mcp/make-server.ts).
 */
export default function appVersionDefine(): Record<string, string> {
  const pkg = JSON.parse(
    fs.readFileSync(webpackPaths.appPackagePath, 'utf8'),
  ) as { version?: string };
  return { __KIA_APP_VERSION__: JSON.stringify(pkg.version ?? '') };
}
