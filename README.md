# Photobook Editor

A browser-based editor for designing print-ready photo books. Runs entirely in the browser — no account, no upload, no installation required.

**[Try it live →](https://rmhoppe.github.io/Photobook/)**

## Features

- **Drag-and-drop layout** — open a local image folder and drag photos onto the canvas
- **Flexible grid** — split frames with the Cut tool; drag dividers to resize; drop images on frame edges to split and fill in one gesture
- **Frame styling** — per-side margins, borders, corner radius, z-order, flips and rotations
- **Text elements** — place, resize, rotate, and style text with system fonts
- **Multi-page books** — add, reorder, and delete spreads; endpaper mode for cover pages
- **PDF export** — print-ready output with embedded fonts, bleed, and configurable DPI
- **Save / load** — projects saved as `.photobook` files; images re-linked on open
- **Fully offline** — nothing leaves your machine

## Getting Started (users)

Open [rmhoppe.github.io/Photobook](https://rmhoppe.github.io/Photobook/) in a modern desktop browser (Chrome or Edge recommended for the best file-access support).

1. Click **Open Folder** in the left sidebar to select your photos.
2. Click **+ Spread** in the footer to add pages.
3. Press **K** to activate the Cut tool and split frames.
4. Drag photos from the sidebar onto frames.
5. Click **Export PDF** when you are done.

In-app help is available via the **?** button in the toolbar.

## Browser Requirements

| Feature | Required API |
|---------|-------------|
| Open local folder | File System Access API (Chrome / Edge) or `<input webkitdirectory>` fallback |
| Load system fonts | Local Font Access API (Chrome / Edge, optional) |
| PDF export | Web Workers, WebAssembly |

Firefox and Safari work with reduced functionality (no folder picker shortcut, no system font loading).

## Development Setup

**Prerequisites:** Rust + `wasm-pack`, Node.js ≥ 18, Python 3.

```bash
git clone https://github.com/RMHoppe/Photobook.git
cd Photobook
./build.sh        # compiles WASM + TypeScript, then serves at http://localhost:8080
```

### Incremental builds

| Change | Command |
|--------|---------|
| TypeScript only | `npx tsc` |
| Rust / WASM only | `wasm-pack build crates/photobook-core --target web --out-dir web/pkg --release` |
| Type-check only | `npm run check` |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Core engine | Rust → WebAssembly (`wasm-pack`, `wasm-bindgen`) |
| PDF generation | `printpdf` (patched fork for WASM compatibility) |
| Frontend | TypeScript, vanilla DOM (no framework) |
| Dev server | Python 3 `http.server` |
| CI / hosting | GitHub Actions → GitHub Pages |

## Project Structure

See [CLAUDE.md](CLAUDE.md) for a full directory layout and architecture notes.

## License

MIT
