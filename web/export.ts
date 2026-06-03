// export.ts — orchestrates PDF export. The heavy work (PDF generation) runs in
// export-worker.ts so the UI thread stays responsive and a panic during export
// is isolated to the worker.

import type { PhotobookEditor } from './pkg/photobook_core.js';
import { getTextElements } from './wasm-bridge.js';
import { getFontBytes } from './fonts.js';
import { showToast } from './toast.js';
import type { ExportWorkerTimings, SpreadPhases } from './export-worker.js';

// --- Worker lifecycle (lazily created, recreated after a crash) ---------------

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
  }
  return worker;
}

function killWorker(): void {
  worker?.terminate();
  worker = null;
}

// --- Request ID (correlates messages to a single in-flight export) -----------

let _exportSeq = 0;

// --- Worker message protocol (mirrors export-worker.ts) ----------------------

type WorkerMessage =
  | { type: 'progress'; reqId: number; fraction: number }
  | { type: 'done';     reqId: number; pdf: Uint8Array; timings: ExportWorkerTimings }
  | { type: 'error';    reqId: number; message: string };

interface MainThreadTimings {
  collectImagesMs: number;
  collectFontsMs: number;
  workerRoundTripMs: number;
  totalMs: number;
}

function ms(n: number): string { return `${n.toFixed(1)} ms`; }

function spreadPhaseLine(p: SpreadPhases): string {
  const other = Math.max(0, (p.decode_ms + p.crop_ms + p.resample_ms + p.encode_ms));
  return `decode ${ms(p.decode_ms)}  crop ${ms(p.crop_ms)}  resample ${ms(p.resample_ms)}  encode ${ms(p.encode_ms)}  (${p.image_count} img, sum ${ms(other)})`;
}

function logExportProfile(main: MainThreadTimings, worker: ExportWorkerTimings, imageCount: number, fontCount: number): void {
  const totalSpreadsMs = worker.perSpreadMs.reduce((a, b) => a + b, 0);
  const lines: string[] = [
    '┌─ PDF Export Profile ──────────────────────────────────',
    '│ Main thread',
    `│   collect images (${imageCount}):     ${ms(main.collectImagesMs)}`,
    `│   collect fonts  (${fontCount}):     ${ms(main.collectFontsMs)}`,
    `│   worker round-trip:         ${ms(main.workerRoundTripMs)}`,
    `│   total:                     ${ms(main.totalMs)}`,
    '│',
    '│ Worker',
    `│   WASM init:                 ${worker.wasmInitMs !== null ? ms(worker.wasmInitMs) : '— (cached)'}`,
    `│   load state:                ${ms(worker.loadStateMs)}`,
    `│   stage images:              ${ms(worker.stageImagesMs)}`,
    `│   stage fonts:               ${ms(worker.stageFontsMs)}`,
    `│   begin:                     ${ms(worker.beginMs)}`,
    `│   spreads (${worker.perSpreadMs.length}):              ${ms(totalSpreadsMs)}`,
    ...worker.perSpreadMs.map((t, i) => {
      const p = worker.perSpreadPhases[i];
      const detail = p ? `  [${spreadPhaseLine(p)}]` : '';
      return `│     spread ${i + 1}:               ${ms(t)}${detail}`;
    }),
    `│   finish:                    ${ms(worker.finishMs)}`,
    `│   total:                     ${ms(worker.totalMs)}`,
    '└───────────────────────────────────────────────────────',
  ];
  console.log(lines.join('\n'));
}

export async function exportPdf(
  editor: PhotobookEditor,
  getBuffers: (usedIds: ReadonlySet<string>) => AsyncIterable<{ id: string; buffer: ArrayBuffer; width_px: number; height_px: number }>,
): Promise<void> {
  const btn       = document.getElementById('btn-export-pdf') as HTMLButtonElement;
  const cancelBtn = document.getElementById('btn-cancel-export') as HTMLButtonElement | null;
  const progress  = document.getElementById('export-progress')!;
  const bar       = progress.querySelector('.export-progress-bar') as HTMLElement;

  const setProgress = (fraction: number) => {
    bar.style.width = `${Math.round(fraction * 100)}%`;
  };

  btn.disabled = true;
  btn.textContent = 'Exporting…';
  if (cancelBtn) cancelBtn.hidden = false;
  setProgress(0);
  progress.hidden = false;

  try {
    const tExportStart = performance.now();

    // --- Gather inputs on the main thread (cheap: IDs, JSON, buffer refs) ---
    const usedIds = new Set<string>(JSON.parse(editor.get_used_image_ids()) as string[]);
    const documentJson = editor.save_state();

    const tImagesStart = performance.now();
    const images: { id: string; buffer: ArrayBuffer; width_px: number; height_px: number }[] = [];
    for await (const entry of getBuffers(usedIds)) {
      images.push({ id: entry.id, buffer: entry.buffer, width_px: entry.width_px, height_px: entry.height_px });
    }
    const collectImagesMs = performance.now() - tImagesStart;

    type FontInput = { family: string; bold: boolean; italic: boolean; buffer: ArrayBuffer };
    const fonts: FontInput[] = [];
    const seenFontKeys = new Set<string>();
    const tFontsStart = performance.now();
    for (const el of getTextElements(editor)) {
      const key = `${el.font_family}:${el.bold}:${el.italic}`;
      if (seenFontKeys.has(key)) continue;
      seenFontKeys.add(key);
      const buf = await getFontBytes(el.font_family, el.bold, el.italic);
      if (buf) fonts.push({ family: el.font_family, bold: el.bold, italic: el.italic, buffer: buf });
    }
    const collectFontsMs = performance.now() - tFontsStart;

    setProgress(0.1);

    // --- Hand off to the worker. Image/font buffers are COPIED (structured
    // clone, not transferred) so the sidebar's cached buffers stay intact. ---
    const reqId = ++_exportSeq;
    const w = getWorker();
    const tWorkerStart = performance.now();
    const { pdf: pdfBytes, timings: workerTimings } = await new Promise<{ pdf: Uint8Array; timings: ExportWorkerTimings }>((resolve, reject) => {
      const onMessage = (e: MessageEvent) => {
        const m = e.data as WorkerMessage;
        if (m.reqId !== reqId) return;  // stale response from a previous export
        if (m.type === 'progress') setProgress(m.fraction);
        else if (m.type === 'done') { cleanup(); resolve({ pdf: m.pdf, timings: m.timings }); }
        else if (m.type === 'error') { cleanup(); reject(new Error(m.message)); }
      };
      const onError = (ev: ErrorEvent) => {
        cleanup();
        killWorker();  // poisoned WASM instance — drop it so the next export is fresh
        reject(new Error(ev.message || 'Export worker crashed'));
      };
      const onCancel = () => {
        cleanup();
        killWorker();
        reject(new Error('Export cancelled'));
      };
      const cleanup = () => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        cancelBtn?.removeEventListener('click', onCancel);
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      cancelBtn?.addEventListener('click', onCancel, { once: true });
      w.postMessage({ type: 'export', reqId, documentJson, images, fonts });
    });
    const workerRoundTripMs = performance.now() - tWorkerStart;
    const totalMs = performance.now() - tExportStart;

    logExportProfile({ collectImagesMs, collectFontsMs, workerRoundTripMs, totalMs }, workerTimings, images.length, fonts.length);

    // --- Trigger download ---
    const blob = new Blob([pdfBytes as unknown as BlobPart], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'photobook.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg !== 'Export cancelled') {
      console.error('PDF export failed', err);
      showToast('PDF export failed: ' + msg, 'error');
    }
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Export PDF';
    if (cancelBtn) cancelBtn.hidden = true;
    progress.hidden = true;
    setProgress(0);
  }
}
