// export-worker.ts — runs the PDF export off the main thread.
//
// The main thread stays responsive: this worker owns its own WASM instance,
// rebuilds the document via `load_state`, then stages raw image/font bytes
// (no base64 overhead) and runs PDF generation here. A Rust panic aborts only
// this worker (the main editor survives); the orchestrator recreates the worker
// on error.

import init, { PhotobookEditor } from './pkg/photobook_core.js';

// Worker globals aren't in the DOM lib used by the rest of the app; cast a
// minimal typed view of the dedicated-worker scope.
interface WorkerCtx {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
}
const ctx = self as unknown as WorkerCtx;

interface ExportImage { id: string; buffer: ArrayBuffer; width_px: number; height_px: number; }
interface ExportFont  { family: string; bold: boolean; italic: boolean; buffer: ArrayBuffer; }
interface ExportRequest {
  type: 'export';
  reqId: number;
  documentJson: string;
  images: ExportImage[];
  fonts: ExportFont[];
}

let initialized = false;

ctx.addEventListener('message', async (e: MessageEvent) => {
  const msg = e.data as ExportRequest;
  if (!msg || msg.type !== 'export') return;

  const { reqId } = msg;

  try {
    if (!initialized) { await init(); initialized = true; }

    const editor = new PhotobookEditor(297, 210, 3);
    if (!editor.load_state(msg.documentJson)) {
      throw new Error('Failed to load document state for export.');
    }

    // Stage raw bytes directly — no base64 encoding, no intermediate JSON string.
    for (const im of msg.images) {
      editor.pdf_stage_image(im.id, new Uint8Array(im.buffer));
    }
    for (const f of msg.fonts) {
      editor.pdf_stage_font(f.family, f.bold, f.italic, new Uint8Array(f.buffer));
    }

    // 0.0–0.15 covers staging/setup; spreads fill the remaining 0.15–1.0.
    ctx.postMessage({ type: 'progress', reqId, fraction: 0.15 });

    const total = editor.pdf_export_begin_v2();
    for (let i = 0; i < total; i++) {
      editor.pdf_export_spread();
      ctx.postMessage({ type: 'progress', reqId, fraction: 0.15 + (i + 1) / Math.max(total, 1) * 0.85 });
    }

    const pdfBytes = editor.pdf_export_finish();
    editor.free();

    // wasm-bindgen returns a fresh Uint8Array; transfer its buffer back.
    ctx.postMessage({ type: 'done', reqId, pdf: pdfBytes }, [pdfBytes.buffer]);
  } catch (err) {
    ctx.postMessage({ type: 'error', reqId, message: err instanceof Error ? err.message : String(err) });
  }
});
