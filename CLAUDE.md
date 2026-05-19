# Photobook Editor

Browser-based editor for designing print-ready photo books. Runs entirely client-side — no server. Users open local image folders, design multi-page layouts, and export print-ready PDFs.

## Stack

- **Rust** (core engine, grid layout, PDF export) compiled to **WebAssembly** via `wasm-pack`
- **TypeScript** (frontend, interaction logic, UI) — no framework, vanilla DOM
- **Python 3** dev server (no bundler)
- **printpdf** (patched fork at `crates/printpdf-patched/` for WASM compatibility)

## Build & Dev

```bash
./build.sh          # compile WASM + TypeScript, then starts dev server at http://localhost:8080
npm run check       # type-check only (tsc --noEmit), no emit
```

Incremental:
- TS change: `npx tsc`
- Rust change: `wasm-pack build crates/photobook-core --target web --out-dir web/pkg --release`

## Directory Layout

```
crates/
  photobook-core/src/   # Rust WASM library
    lib.rs              # wasm-bindgen exports, PhotobookEditor struct
    page.rs             # Document/Spread/TextElement data model
    grid_layout.rs      # Core layout model (Face, Edge)
    grid_resolver.rs    # GridLayout → canvas-space RenderFrame
    pdf.rs              # PDF export pipeline
    editor_*.rs         # WASM-exported layout/image operations
  printpdf-patched/     # Patched printpdf fork
web/
  index.html            # Entry point + import map
  main.ts               # App bootstrap, UI wiring
  types.ts              # All TS interfaces
  wasm-bridge.ts        # Typed JSON-parse wrappers around WASM calls
  canvas.ts             # CanvasRenderer
  interaction.ts        # Interaction mode state machine
  sidebar-*.ts          # Right-panel editors (box model, text, spread, etc.)
  sidebar-left.ts       # Image sidebar (File System Access API)
  footer.ts             # Thumbnail strip + spread navigation
  export.ts             # PDF export trigger
  project-io.ts         # Save/load project JSON
  undo.ts               # UndoManager (JSON snapshots)
  pkg/                  # Generated WASM bindings (do not edit)
```

## Key Architecture Decisions

**WASM boundary pattern** — every Rust method returning JSON has a typed wrapper in `wasm-bridge.ts`. Callers never call `JSON.parse()` directly; field renames in Rust become TS compile errors.

**Grid model** — `GridLayout` stores `Face` and `Edge` collections. Interior dividers are twin pairs (two edges, same offset, opposite `Facing`). `GridResolver` converts to canvas-space `RenderFrame` for drawing.

**Interaction modes** — each mode (idle, cut, text-place, image-pan, …) is a separate object implementing `onMouseDown/Move/Up/Leave`. No spaghetti event logic.

**Incremental rendering** — `PhotobookEditor` tracks dirty flags (`structure_dirty`, `leaf_dirty`, etc.); `get_resolved_spread_delta()` returns only changed frames.

**No bundler** — `tsc` emits `.js` alongside `.ts` in `web/`; Python HTTP server serves them directly. `moduleResolution: bundler` lets `.js` imports resolve `.ts` sources at compile time.

**PDF export** — embeds fonts loaded via the browser Font Loading API; uses the patched `printpdf` crate; handles image rotation, margin, border, corner radius.

**Project persistence** — images stored as base64 in project JSON. Missing-image/font feedback on load. Undo/redo via JSON snapshots.

## Image Crate Version

Pinned to `image = "0.24"` in `crates/photobook-core/Cargo.toml` for `printpdf` compatibility. Do not upgrade without testing PDF export.

## CI/CD

GitHub Actions (`.github/workflows/deploy.yml`) builds WASM + TS and deploys to GitHub Pages on push to `main`.
