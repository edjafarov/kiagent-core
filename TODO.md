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
      About) as part of the brand-asset work. **Partially addressed:**
      `product.json` (`src/main/product.ts`, wired in `main.ts`) now
      supplies `productName`, but only `Notification` titles read it so far
      — BootSplash, the Spark mark and About still hardcode `'KIAgent'`.
      This item stays open until those are ported to `product.productName`
      too. See `docs/architecture/extension-platform.md` § Product builds.
- [x] ~~Wire the cross-platform unsigned `package:oss` matrix in CI~~ —
      built as `kiagent-core-package.yml`, then REMOVED 2026-07-13: core CI
      runs tests only; release builds of the core are deliberately not done
      in CI (the shippable product is built from the alpha-cent overlay's
      release pipeline; local `npm run package:oss` remains for hand-rolled
      OSS builds).
- [ ] Add the Apache-2.0 LICENSE + source headers.
