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
  photobook-core/src/
    lib.rs                      # wasm-bindgen exports, PhotobookEditor struct
    page.rs                     # Document/Spread/TextElement data model
    layout.rs                   # PSLG data structure (vertices, half-edges, faces)
    grid_layout.rs              # Face/Edge collections; interior dividers as twin pairs
    grid_resolver.rs            # GridLayout → canvas-space RenderFrame
    pdf.rs                      # PDF export pipeline
    interaction.rs              # Hit-testing helpers shared with Rust tests
    utils.rs                    # Shared utilities
    editor_box_model.rs         # WASM exports: margins, border, radius, z-order
    editor_image_ops.rs         # WASM exports: image place/pan/scale/rotate/swap
    editor_layout.rs            # WASM exports: split, delete, divider drag
    editor_layout_transform.rs  # WASM exports: flip, rotate selection
    editor_pinwheel.rs          # WASM exports: pinwheel split at X-junction
    editor_selection.rs         # WASM exports: frame/text/divider selection queries
    editor_spread_settings.rs   # WASM exports: spread margin, background colour
    editor_text_ops.rs          # WASM exports: add/move/resize/rotate text
    editor_tests.rs             # Integration tests
    wasm_test_runner.rs         # WASM-side test runner
  printpdf-patched/             # Patched printpdf fork (WASM-compatible)

web/
  index.html                    # Entry point + import map
  main.ts                       # App bootstrap, UI wiring
  types.ts                      # All TS interfaces (source of truth for WASM JSON shapes)
  constants.ts                  # Shared numeric constants
  wasm-bridge.ts                # Typed JSON-parse wrappers around every WASM call
  canvas.ts                     # CanvasRenderer — draws frames, text, handles, overlays
  canvas-draw-rulers.ts         # Ruler tick rendering
  interaction.ts                # Interaction mode state machine (idle/cut/text-place/…)
  inline-editor.ts              # Textarea overlay for in-place text editing
  sidebar-right.ts              # Right panel coordinator — routes to per-mode panels
  sidebar-box-model.ts          # Margins, border, radius, z-order, transforms, randomize
  sidebar-text-editor.ts        # Font, size, style, colour, alignment, position
  sidebar-spread-settings.ts    # Spread margins + per-page background colours
  sidebar-divider.ts            # Divider gap editor
  sidebar-left.ts               # Image browser (File System Access API + fallback)
  sidebar-photo-info.ts         # Image metadata panel (dimensions, DPI, colour space)
  sidebar-project-settings.ts   # Project settings modal (page size, DPI, bleed, spine)
  footer.ts                     # Thumbnail strip, spread add/remove/reorder, navigation
  export.ts                     # PDF export trigger + progress/cancel UI
  export-worker.ts              # PDF generation in a separate worker thread
  decode-worker.ts              # Image decoding off the main thread
  project-io.ts                 # Save/load project JSON (images stored as path refs)
  undo.ts                       # UndoManager — JSON snapshots via Rust serialisation
  image-loader-modal.ts         # Missing-image re-link dialog
  docs-panel.ts                 # In-app documentation modal (fetches web/docs/*.md)
  fonts.ts                      # Font loading via Font Loading API + fallback list
  lru.ts                        # Generic LRU cache used for image proxies and buffers
  margin-mode-controller.ts     # Linked/per-side margin mode toggle UI
  randomize-dialog.ts           # Per-field min/max randomize dialog
  toast.ts                      # Toast notification display
  ui-fields.ts                  # Reusable numeric field + toggle components
  mobile.ts                     # Mobile detection, shows landing page on narrow screens
  pkg/                          # Generated WASM bindings (do not edit)
  docs/                         # In-app user documentation (Markdown, served by DocsPanel)
```

## Key Architecture Decisions

**WASM boundary pattern** — every Rust method returning JSON has a typed wrapper in `wasm-bridge.ts`. Callers never call `JSON.parse()` directly; field renames in Rust become TS compile errors. `types.ts` is the single source of truth for all WASM-crossing JSON shapes.

**Grid model** — `GridLayout` stores `Face` and `Edge` collections built on top of a PSLG (`layout.rs`) of vertices and half-edges. Interior dividers are twin pairs (two edges, same offset, opposite `Facing`). `GridResolver` converts to canvas-space `RenderFrame` for drawing.

**Interaction modes** — each mode (idle, cut, text-place, image-pan, divider-drag, …) is a separate object implementing `onMouseDown/Move/Up/Leave`. `interaction.ts` holds the state machine; no global event spaghetti.

**Incremental rendering** — `PhotobookEditor` tracks dirty flags (`structure_dirty`, `leaf_dirty`, etc.); `get_resolved_spread_delta()` returns only changed frames. The thumbnail strip renders lazily and only re-renders dirty spreads.

**No bundler** — `tsc` emits `.js` alongside `.ts` in `web/`; the Python HTTP server serves them directly. `moduleResolution: bundler` lets `.js` imports resolve `.ts` sources at compile time.

**Worker threads** — image decoding (`decode-worker.ts`) and PDF generation (`export-worker.ts`) run in separate Web Workers to keep the main thread responsive. Both fall back gracefully if workers are unavailable.

**LRU image caches** — `lru.ts` backs two caches: 800 px proxy thumbnails (sidebar) and full-resolution buffers (export). A 256 MB canvas image cache with automatic eviction prevents memory exhaustion on large books.

**PDF export** — embeds fonts loaded via the browser Font Loading API; uses the patched `printpdf` crate; handles image rotation, margin, border, corner radius. Performance metrics are logged to the browser console.

**Project persistence** — layout, text, and styling are serialised to JSON; images are stored as file-path references only (no base64). Missing images are flagged on load and can be re-linked via the folder picker in `image-loader-modal.ts`. Undo/redo uses JSON snapshots managed inside the Rust `PhotobookEditor`.

## Image Crate Version

Pinned to `image = "0.24"` in `crates/photobook-core/Cargo.toml` for `printpdf` compatibility. Do not upgrade without testing PDF export.

## CI/CD

GitHub Actions (`.github/workflows/deploy.yml`) builds WASM + TS and deploys to GitHub Pages on push to `main`. The workflow pins `wasm-bindgen` version by reading it from `Cargo.lock` and downloading the matching CLI binary directly from GitHub Releases.
