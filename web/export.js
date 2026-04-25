// export.ts — PDF export logic, isolated from the main app bootstrap.
import { getTextElements } from './wasm-bridge.js';
import { getFontBytes } from './fonts.js';
export function bufferToBase64(buffer) {
    return btoa(Array.from(new Uint8Array(buffer), b => String.fromCharCode(b)).join(''));
}
export async function exportPdf(editor, getBuffers) {
    const btn = document.getElementById('btn-export-pdf');
    const progress = document.getElementById('export-progress');
    btn.disabled = true;
    btn.textContent = 'Exporting…';
    progress.hidden = false;
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
        const images = [];
        for await (const entry of getBuffers()) {
            images.push({ id: entry.id, data_base64: bufferToBase64(entry.buffer), width_px: entry.width_px, height_px: entry.height_px });
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
                fonts.push({ family: el.font_family, bold: el.bold, italic: el.italic, data_base64: bufferToBase64(buf) });
        }
        const pdfBytes = editor.export_pdf(JSON.stringify(images), JSON.stringify(fonts));
        const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'photobook.pdf';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    catch (err) {
        console.error('PDF export failed:', err);
        alert('PDF export failed: ' + err.message);
    }
    finally {
        btn.disabled = false;
        btn.textContent = 'Export PDF';
        progress.hidden = true;
    }
}
