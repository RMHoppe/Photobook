// export.ts — PDF export logic, isolated from the main app bootstrap.

import type { PhotobookEditor } from './pkg/photobook_core.js';
import { getTextElements } from './wasm-bridge.js';
import { getFontBytes } from './fonts.js';

export function bufferToBase64(buffer: ArrayBuffer): string {
  return btoa(Array.from(new Uint8Array(buffer), b => String.fromCharCode(b)).join(''));
}

export async function exportPdf(
  editor: PhotobookEditor,
  getBuffers: () => AsyncIterable<{ id: string; buffer: ArrayBuffer; width_px: number; height_px: number }>,
): Promise<void> {
  const btn = document.getElementById('btn-export-pdf') as HTMLButtonElement;
  const progress = document.getElementById('export-progress')!;
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  progress.hidden = false;

  await new Promise<void>(resolve => setTimeout(resolve, 0));

  try {
    const images: { id: string; data_base64: string; width_px: number; height_px: number }[] = [];
    for await (const entry of getBuffers()) {
      images.push({ id: entry.id, data_base64: bufferToBase64(entry.buffer), width_px: entry.width_px, height_px: entry.height_px });
    }

    type FontEntry = { family: string; bold: boolean; italic: boolean; data_base64: string };
    const fonts: FontEntry[] = [];
    const seenFontKeys = new Set<string>();
    for (const el of getTextElements(editor)) {
      const key = `${el.font_family}:${el.bold}:${el.italic}`;
      if (seenFontKeys.has(key)) continue;
      seenFontKeys.add(key);
      const buf = await getFontBytes(el.font_family, el.bold, el.italic);
      if (buf) fonts.push({ family: el.font_family, bold: el.bold, italic: el.italic, data_base64: bufferToBase64(buf) });
    }

    const pdfBytes = editor.export_pdf(JSON.stringify(images), JSON.stringify(fonts));
    const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'photobook.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    console.error('PDF export failed:', err);
    alert('PDF export failed: ' + (err as Error).message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Export PDF';
    progress.hidden = true;
  }
}
