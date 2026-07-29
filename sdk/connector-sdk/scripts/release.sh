#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
CORE=$(node -p "require('./package.json').kiagentCore")
npm test
npm pack
gh release create "sdk-v${VERSION}" --repo edjafarov/kiagent-core \
  --title "connector-sdk v${VERSION}" \
  --notes "Contracts generated from kiagent-core v${CORE}." \
  "kiagent-connector-sdk-${VERSION}.tgz"
