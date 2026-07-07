/**
 * Build-time OAuth client credentials for the main-process bundle.
 *
 * The repo carries NO OAuth client credentials. Each build inlines them from
 * the build machine's environment: a git-ignored .env at the project root
 * (local builds — see .env.example) or repository secrets (CI). dotenv never
 * overrides variables already present in the real environment, so CI secrets
 * win over any stray .env.
 *
 * Unset variables inline as '' rather than failing the build — the runtime
 * getters in src/main/sources/{gmail,microsoft}/client-credentials.ts throw
 * a descriptive error the moment a Google/Microsoft sign-in is attempted, so
 * contributors without credentials can still build and run everything else.
 */
import path from 'path';
import dotenv from 'dotenv';
import webpackPaths from './webpack.paths';

dotenv.config({ path: path.join(webpackPaths.rootPath, '.env') });

const OAUTH_ENV_VARS = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'MICROSOFT_OAUTH_CLIENT_ID',
] as const;

export default function oauthEnvDefines(): Record<string, string> {
  return Object.fromEntries(
    OAUTH_ENV_VARS.map((name) => [
      `process.env.${name}`,
      JSON.stringify(process.env[name] ?? ''),
    ]),
  );
}
