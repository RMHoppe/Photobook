---
name: Photobook Editor Setup
description: Build commands, toolchain versions, dev server, key project facts
type: project
---

**Build command:** `./build.sh` — runs `wasm-pack build`, then `npx tsc`, then `python3 -m http.server 8080 --directory web`

**wasm-pack target:** `--target web --out-dir web/pkg`

**TypeScript:** `npx tsc` (tsconfig.json at project root; rootDir/outDir both `web/`; moduleResolution `bundler`; target ES2022)

**Dev dependencies:** `typescript ^5.5` in root `package.json`; install with `npm install`

**image crate:** `0.24` (pinned — newer versions break the printpdf integration)

**printpdf:** patched fork at `crates/printpdf-patched/` (fixes WASM compilation issue)

**Type check only:** `npm run check` (runs `tsc --noEmit`)

**Why:** wasm-pack + Python HTTP server = no bundler needed; tsc emits JS files in-place alongside the .ts sources.
