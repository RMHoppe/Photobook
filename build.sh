#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Building Rust/Wasm..."
wasm-pack build crates/photobook-core \
  --target web \
  --out-dir "$(pwd)/web/pkg" \
  ${1:-"--release"}

echo "==> Build complete."
echo "==> Starting dev server at http://localhost:8080"
python3 -m http.server 8080 --directory web
