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
- Rust change: `wasm-pack build crates/photobook-core --target web --out-dir "$(pwd)/web/pkg" --release`

> **`--out-dir` must be an absolute path.** `wasm-pack` changes into the crate directory before running, so a relative path like `web/pkg` resolves to `crates/photobook-core/web/pkg` instead of the project-root `web/pkg/` that the app imports from. Always use `"$(pwd)/web/pkg"` or the `./build.sh` script.

## Directory Layout

```
crates/
  photobook-core/src/
    lib.rs                      # wasm-bindgen exports, PhotobookEditor struct
    page.rs                     # Document/Spread/TextElement data model
    layout.rs                   # Shared value types: box model, Rect, resolved-output structs
    grid_layout.rs              # Coincident-Edge Grid: faces own four edges; dividers are twin pairs
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
    editor_preflight.rs         # WASM exports: pre-export checks (DPI, page count, safe zone)
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
  export.ts                     # PDF production (generatePdfs) + export-to-download flow
  print-shop-specs.ts           # Print-shop spec presets (settings + preflight rules + order refs)
  pod/provider.ts               # Print-on-demand OrderProvider contract + domain types
  pod/registry.ts               # Provider-id → implementation binding; spec → order target
  pod/peecho-catalog.ts         # Static snapshot of Peecho photobook offerings (sizes, page limits, pricing)
  pod/peecho-provider.ts        # Real Peecho provider: catalog products + local quotes; ordering gated (no CORS)
  pod/mock-provider.ts          # Fully simulated provider (tests/demos)
  pod/mock-checkout.html        # Fake hosted checkout page (writes status to localStorage)
  pod/page-count.ts             # PDF page-count estimate for quoting
  pod/order-dialog.ts           # Order Book dialog: quote, progress, checkout handoff, history
  export-worker.ts              # PDF generation in a separate worker thread
  decode-worker.ts              # Image decoding off the main thread
  project-io.ts                 # Save/load project JSON (images stored as path refs)
  persist.ts                    # IndexedDB autosave + recent folder handles; localStorage view prefs
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

**Coincident-Edge Grid** (`grid_layout.rs`) — the layout model. `GridLayout` holds `GridFace` and `Edge` maps; every face privately owns four edges and edges are never shared. An `Edge` is only `orientation + scalar offset + Facing` (extent derived from its face). Topology is not stored: adjacency is recovered from geometry by matching coincident edges — an interior divider is a *twin pair* (two coincident edges, opposite `Facing`, found by `twin()`), and T-junction neighbours / chains are found the same way. Not guillotine-restricted (pinwheels allowed). `GridResolver` converts to canvas-space `RenderFrame` for drawing.

**Interaction modes** — each mode (idle, cut, text-place, image-pan, divider-drag, …) is a separate object implementing `onMouseDown/Move/Up/Leave`. `interaction.ts` holds the state machine; no global event spaghetti.

**Incremental rendering** — `PhotobookEditor` keeps a `revision: u64` bumped by every mutation; revision-tagged caches (low-DPI report) compare against it instead of carrying their own dirty flag. The canvas delta protocol uses `structure_dirty`/`leaf_dirty` as payload selectors: `get_resolved_spread_delta()` returns only changed frames. Thumbnail dirtiness is keyed by spread *id* (`ThumbsDirty`), so inserts/removes/reorders can't desynchronise it; the footer drains dirty indices and repaints them throttled (~150 ms), so divider drags don't re-render thumbnails per frame. The spread-summary list is fetched only on rebuilds and throttled repaints, never on steady-state redraws.

**Box-model wire protocol** — the stored `Border`/`BoxModel` (`layout.rs`) hold only concrete per-side/per-corner values. The editor-panel DTO (`BorderJson`/`BoxModelJson` in `editor_box_model.rs`, mirrored in `types.ts`) uses one uniform sentinel on every field: reading, `null` = the multi-selection disagrees ("mixed"); writing, `null` = leave unchanged. No mixed/legacy state ever reaches the document.

**No bundler** — `tsc` emits `.js` alongside `.ts` in `web/`; the Python HTTP server serves them directly. `moduleResolution: bundler` lets `.js` imports resolve `.ts` sources at compile time.

**Worker threads** — image decoding (`decode-worker.ts`) and PDF generation (`export-worker.ts`) run in separate Web Workers to keep the main thread responsive. Both fall back gracefully if workers are unavailable.

**LRU image caches** — `lru.ts` backs two caches: 800 px proxy thumbnails (sidebar) and full-resolution buffers (export). A 256 MB canvas image cache with automatic eviction prevents memory exhaustion on large books.

**PDF export** — produces **PDF/X-4** with an embedded sRGB output intent (compact CC0 profile in `crates/photobook-core/assets/`); embeds fonts loaded via the browser Font Loading API; uses the patched `printpdf` crate; handles image rotation, margin, border, corner radius. Export is job-based (`PageJob` in `pdf.rs`): a job is a full spread or one half of a spread, enabling cover/body split files, interior-as-single-pages mode (endpaper blanks skipped), cover wrap allowance, and an opt-in crop-marks toggle (all stored on the document, edited in Project Settings → Export). Print-shop presets (`web/print-shop-specs.ts`) prefill these settings and install page-count rules enforced by `add_page`/`remove_page`. Performance metrics are logged to the browser console.

**Cover as front & back pages** — `export_cover_pages` is a *structural* mode (Peecho-style: the shop generates the spine). Toggling it converts the document via `PhotobookDocument::set_cover_pages_mode`: the wraparound `Cover` spread becomes standalone single-page `CoverFront` (first spread) and `CoverBack` (always last spread) — edited like normal pages, no spine — and back again. Conversion carries background colours and text elements but resets the cover frame layout (undoable). `load_state` normalizes old projects saved with the flag; `build_jobs` keeps a legacy split path for unconverted documents. Single-page spreads maintain `left_bg == right_bg` so both renderers fill the whole page without special-casing.

**Project persistence** — layout, text, and styling are serialised to JSON; images are stored as file-path references only (no base64). Missing images are flagged on load and can be re-linked via the folder picker in `image-loader-modal.ts`. Undo/redo uses JSON snapshots managed inside the Rust `PhotobookEditor`.

**Session persistence** (`persist.ts`) — best-effort, never blocking: the document JSON is autosaved to IndexedDB (debounced 2 s off `redraw()`, skipped while unchanged; baselined at boot so an untouched session never clobbers the stored one) and offered for restore on next visit. Recently opened image-folder `FileSystemDirectoryHandle`s are stored in IndexedDB (handles only survive in structured-clone storage) for one-click re-linking — restore re-attaches the last folder and feeds it to the image-loader modal's recursive scan. View toggles (bleed/safe zone) persist in localStorage. POD order records (`PodOrderRecord`) are device-local IndexedDB too — orders belong to a person/device, never to the project file.

**Print-on-demand ordering** (`web/pod/`) — hosted-checkout-first: the end customer pays the print shop directly on the shop's checkout page (Peecho model); the app never handles payment and never stores the PDF anywhere — bytes go browser → provider. `OrderProvider` (provider.ts) is the adapter contract (capabilities incl. `ordersEnabled`, product catalog, async quote, `createOrder(files, onProgress, signal)`, status lookup); specs reference real shop ids (`PrintShopSpec.order`) and `registry.ts` binds each id to an implementation. `peecho` → `PeechoProvider` (real catalogue + sizes + page limits + local quotes from `peecho-catalog.ts`, a snapshot of `/offering/list`) with `ordersEnabled: false` — Peecho's REST API has no CORS, so order submission needs a backend proxy (verified 2026-06-13). While `ordersEnabled` is false the dialog shows the real product/price and an **Export PDF for upload** path (generate + download, then point to peecho.com) instead of the fake order/checkout. `mock` → `MockProvider` (full simulated upload→checkout→paid via localStorage, for tests). The Order Book flow reuses `generatePdfs()` (the download-less half of export.ts) and blocks on preflight *errors* (unlike export's "Export anyway"). Export and ordering share the worker, so their buttons disable each other.

## Image Crate Version

Pinned to `image = "0.24"` in `crates/photobook-core/Cargo.toml` for `printpdf` compatibility. Do not upgrade without testing PDF export.

## CI/CD

GitHub Actions (`.github/workflows/deploy.yml`) builds WASM + TS and deploys to GitHub Pages on push to `main`. The workflow pins `wasm-bindgen` version by reading it from `Cargo.lock` and downloading the matching CLI binary directly from GitHub Releases.
