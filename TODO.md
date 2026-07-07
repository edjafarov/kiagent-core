# Pre-public checklist — kiagent-core

This repository is **PRIVATE** during hardening. Every item below MUST be done
before flipping it public.

## 🚨 Secrets — blockers for public
- [ ] **Remove the bundled Google OAuth client secret.**
      `src/main/sources/gmail/client-credentials.ts` hardcodes
      `BUNDLED_CLIENT_SECRET` (`GOCSPX-…`). In OSS, ship no bundled secret: read
      `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` from env (forks
      supply their own Google Cloud project); the proprietary build injects the
      real creds. (`BUNDLED_CLIENT_ID` is a non-secret installed-app client id.)
- [ ] **Rotate** that client secret in Google Cloud — the value committed here
      is exposed and must be retired.
- [ ] After squashing (below), run `gitleaks git .` and confirm **0 findings**
      before going public.

## History
- [ ] **Squash** the full filtered history into a single clean initial commit
      before going public. This also removes the Google secret from history
      (it currently lives in 2 historical commits). Re-scan with gitleaks after.

## Known follow-ups (do before / at launch)
- [ ] Extract About.tsx's updater UI behind the `@renderer-ext` slot. It is
      currently `@ts-nocheck`'d because it calls overlay-only `update:*` IPC
      channels that don't exist in the OSS base channel map, so the updater
      section is inert in OSS. This is the renderer analog of the main.ts
      updater guarding.
- [ ] Neutralize hardcoded `'KIAgent'` brand strings (BootSplash / Spark /
      About) as part of the brand-asset work.
- [ ] Wire the cross-platform unsigned `package:oss` matrix in CI (needs the
      native deep-extraction vendor step, incl. .NET 8 for the Windows OCR
      helper).
- [ ] Add the Apache-2.0 LICENSE + source headers.
