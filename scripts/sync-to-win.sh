#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="${1:-release/build/win-arm64-unpacked}"
DEST_HOST="${WIN_HOST:-win}"
DEST_DIR="${WIN_DEST:-C:/Users/Ed/app}"

if [ ! -d "$SRC_DIR" ]; then
  echo "source not found: $SRC_DIR" >&2
  exit 1
fi

PARENT="$(dirname "$SRC_DIR")"
LEAF="$(basename "$SRC_DIR")"

ssh "$DEST_HOST" "Remove-Item -Recurse -Force '$DEST_DIR/$LEAF' -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force -Path '$DEST_DIR' | Out-Null"
COPYFILE_DISABLE=1 tar cf - -C "$PARENT" "$LEAF" | ssh "$DEST_HOST" "cd '$DEST_DIR'; tar xf -"

echo "synced $SRC_DIR -> $DEST_HOST:$DEST_DIR/$LEAF"
