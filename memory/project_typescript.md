---
name: TypeScript Migration
description: How the frontend is structured after the JS→TS migration
type: project
---

**All frontend source files are TypeScript** (`.ts` in `web/`); compiled JS files are build artifacts.

**Source layout:**
- `web/types.ts` — all shared interfaces mirroring Rust structs (SpreadInfo, RenderFrame, BoxModel, etc.)
- `web/wasm-bridge.ts` — typed wrappers for every JSON-returning WASM method; callers import from here instead of calling `JSON.parse(editor.get_xxx())` directly
- `web/constants.ts` — UI constants (PAD, RULER_SIZE, NULL_ID, zoom limits, undo depth)
- `web/canvas.ts` — `CanvasRenderer` class
- `web/interaction.ts` — interaction mode state machine + `InteractionContext` / `InteractionMode` types
- `web/main.ts` — app bootstrap
- `web/sidebar-left.ts` — `ImageSidebar` (File System Access API)
- `web/sidebar-right.ts` — `BoxModelEditor`
- `web/footer.ts` — `Footer` (thumbnail strip)

**WASM boundary pattern:** `wasm-bridge.ts` wraps every JSON-returning method. Raw `JSON.parse` calls do NOT appear in any other file. Adding/renaming a Rust struct field will cause a TS compile error at the bridge function, not a silent runtime `undefined`.

**compute_image_cover declaration:** manually added to `web/pkg/photobook_core.d.ts` (the function was added to lib.rs but wasm-pack hasn't been rebuilt since). Will be auto-generated on next `wasm-pack build`.

**Why:** No bundler — tsc emits `.js` files alongside `.ts` in `web/`; Python HTTP server serves them directly. `moduleResolution: bundler` allows `.js` import extensions to resolve `.ts` sources at compile time.
