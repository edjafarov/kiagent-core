#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
CORE=$(node -p "require('./package.json').kiagentCore")
# Tag the commit that builds the asset, never the default branch's HEAD:
# an untargeted `gh release create` tags the default branch, whose tree may
# not reproduce this tarball.
TARGET=$(git rev-parse HEAD)
if ! git diff --quiet HEAD -- .; then
  echo "sdk/connector-sdk has uncommitted changes — commit before releasing" >&2
  exit 1
fi
npm test
npm pack
gh release create "sdk-v${VERSION}" --repo edjafarov/kiagent-core \
  --target "${TARGET}" \
  --title "connector-sdk v${VERSION}" \
  --notes "${NOTES:-Contracts generated from kiagent-core v${CORE}.}" \
  "kiagent-connector-sdk-${VERSION}.tgz"
