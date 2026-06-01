// export.ts — orchestrates PDF export. The heavy work (PDF generation) runs in
// export-worker.ts so the UI thread stays responsive and a panic during export
// is isolated to the worker.
import { getTextElements } from './wasm-bridge.js';
import { getFontBytes } from './fonts.js';
import { showToast } from './toast.js';
// --- Worker lifecycle (lazily created, recreated after a crash) ---------------
let worker = null;
function getWorker() {
    if (!worker) {
        worker = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
    }
    return worker;
}
function killWorker() {
    worker?.terminate();
    worker = null;
}
// --- Request ID (correlates messages to a single in-flight export) -----------
let _exportSeq = 0;
export async function exportPdf(editor, getBuffers) {
    const btn = document.getElementById('btn-export-pdf');
    const cancelBtn = document.getElementById('btn-cancel-export');
    const progress = document.getElementById('export-progress');
    const bar = progress.querySelector('.export-progress-bar');
    const setProgress = (fraction) => {
        bar.style.width = `${Math.round(fraction * 100)}%`;
    };
    btn.disabled = true;
    btn.textContent = 'Exporting…';
    if (cancelBtn)
        cancelBtn.hidden = false;
    setProgress(0);
    progress.hidden = false;
    try {
        // --- Gather inputs on the main thread (cheap: IDs, JSON, buffer refs) ---
        const usedIds = new Set(JSON.parse(editor.get_used_image_ids()));
        const documentJson = editor.save_state();
        const images = [];
        for await (const entry of getBuffers()) {
            if (!usedIds.has(entry.id))
                continue;
            images.push({ id: entry.id, buffer: entry.buffer, width_px: entry.width_px, height_px: entry.height_px });
        }
        const fonts = [];
        const seenFontKeys = new Set();
        for (const el of getTextElements(editor)) {
            const key = `${el.font_family}:${el.bold}:${el.italic}`;
            if (seenFontKeys.has(key))
                continue;
            seenFontKeys.add(key);
            const buf = await getFontBytes(el.font_family, el.bold, el.italic);
            if (buf)
                fonts.push({ family: el.font_family, bold: el.bold, italic: el.italic, buffer: buf });
        }
        setProgress(0.1);
        // --- Hand off to the worker. Image/font buffers are COPIED (structured
        // clone, not transferred) so the sidebar's cached buffers stay intact. ---
        const reqId = ++_exportSeq;
        const w = getWorker();
        const pdfBytes = await new Promise((resolve, reject) => {
            const onMessage = (e) => {
                const m = e.data;
                if (m.reqId !== reqId)
                    return; // stale response from a previous export
                if (m.type === 'progress')
                    setProgress(m.fraction);
                else if (m.type === 'done') {
                    cleanup();
                    resolve(m.pdf);
                }
                else if (m.type === 'error') {
                    cleanup();
                    reject(new Error(m.message));
                }
            };
            const onError = (ev) => {
                cleanup();
                killWorker(); // poisoned WASM instance — drop it so the next export is fresh
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
        // --- Trigger download ---
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'photobook.pdf';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    catch (err) {
        const msg = err.message;
        if (msg !== 'Export cancelled') {
            console.error('PDF export failed', err);
            showToast('PDF export failed: ' + msg, 'error');
        }
    }
    finally {
        btn.disabled = false;
        btn.textContent = 'Export PDF';
        if (cancelBtn)
            cancelBtn.hidden = true;
        progress.hidden = true;
        setProgress(0);
    }
}
