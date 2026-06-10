#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Prefer the rustup-managed toolchain (has wasm32-unknown-unknown target)
# over the Homebrew Rust installation which lacks it.
export PATH="$HOME/.cargo/bin:$PATH"

echo "==> Building Rust/Wasm..."
wasm-pack build crates/photobook-core \
  --target web \
  --out-dir "$(pwd)/web/pkg" \
  ${1:-"--release"}

echo "==> Building test Wasm..."
wasm-pack build crates/photobook-core \
  --target web \
  --out-dir "$(pwd)/web/test-pkg" \
  --features wasm-test

if [ ! -d "node_modules/marked" ]; then
  echo "==> Installing npm dependencies..."
  npm install
fi

echo "==> Copying vendor libs..."
mkdir -p web/lib
cp node_modules/marked/lib/marked.esm.js web/lib/marked.esm.js

echo "==> Compiling TypeScript..."
npx tsc

echo "==> Build complete."
echo "==> Starting dev server at http://localhost:8080"
python3 web/server.py 8080
