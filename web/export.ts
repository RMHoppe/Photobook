// export.ts — PDF export logic, isolated from the main app bootstrap.

import type { PhotobookEditor } from './pkg/photobook_core.js';
import { getTextElements } from './wasm-bridge.js';
import { getFontBytes } from './fonts.js';

export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function exportPdf(
  editor: PhotobookEditor,
  getBuffers: () => AsyncIterable<{ id: string; buffer: ArrayBuffer; width_px: number; height_px: number }>,
): Promise<void> {
  const btn      = document.getElementById('btn-export-pdf') as HTMLButtonElement;
  const progress = document.getElementById('export-progress')!;
  const bar      = progress.querySelector('.export-progress-bar') as HTMLElement;

  const setProgress = (fraction: number) => {
    bar.style.width = `${Math.round(fraction * 100)}%`;
  };

  btn.disabled = true;
  btn.textContent = 'Exporting…';
  setProgress(0);
  progress.hidden = false;

  // Yield once so the browser paints the initial bar state before we block.
  await new Promise<void>(r => setTimeout(r, 0));

  try {
    console.group('[PDF export]');

    // --- Step 1: collect image buffers (used images only) ---
    const usedIds = new Set<string>(JSON.parse(editor.get_used_image_ids()) as string[]);
    console.log(`Step 1: loading buffers for ${usedIds.size} used image(s)…`);
    const images: { id: string; data_base64: string; width_px: number; height_px: number }[] = [];
    let loaded = 0;
    for await (const entry of getBuffers()) {
      if (!usedIds.has(entry.id)) continue;
      console.log(`  image "${entry.id}": ${entry.width_px}×${entry.height_px}, raw ${(entry.buffer.byteLength / 1024).toFixed(1)} KB`);
      const b64 = bufferToBase64(entry.buffer);
      console.log(`  → base64 length: ${b64.length} chars (${(b64.length / 1024).toFixed(1)} KB)`);
      images.push({ id: entry.id, data_base64: b64, width_px: entry.width_px, height_px: entry.height_px });
      loaded++;
      setProgress(loaded / Math.max(usedIds.size, 1) * 0.15);
    }
    console.log(`Step 1 done: ${images.length} image(s) collected`);

    // --- Step 2: collect font buffers ---
    console.log('Step 2: loading font buffers…');
    type FontEntry = { family: string; bold: boolean; italic: boolean; data_base64: string };
    const fonts: FontEntry[] = [];
    const seenFontKeys = new Set<string>();
    for (const el of getTextElements(editor)) {
      const key = `${el.font_family}:${el.bold}:${el.italic}`;
      if (seenFontKeys.has(key)) continue;
      seenFontKeys.add(key);
      const buf = await getFontBytes(el.font_family, el.bold, el.italic);
      if (buf) {
        const b64 = bufferToBase64(buf);
        console.log(`  font "${el.font_family}" bold=${el.bold} italic=${el.italic}: raw ${(buf.byteLength / 1024).toFixed(1)} KB`);
        fonts.push({ family: el.font_family, bold: el.bold, italic: el.italic, data_base64: b64 });
      }
    }
    console.log(`Step 2 done: ${fonts.length} font(s) collected`);

    // --- Step 3: serialise to JSON ---
    console.log('Step 3: serialising to JSON…');
    const imagesJson = JSON.stringify(images);
    const fontsJson  = JSON.stringify(fonts);
    console.log(`  images JSON: ${(imagesJson.length / 1024).toFixed(1)} KB`);
    console.log(`  fonts JSON:  ${(fontsJson.length  / 1024).toFixed(1)} KB`);
    setProgress(0.15);

    // --- Step 4: WASM export — one spread per tick so the bar advances ---
    console.log('Step 4: rendering PDF spreads…');
    const t0    = performance.now();
    const total = editor.pdf_export_begin(imagesJson, fontsJson);
    console.log(`  ${total} spread(s) to render`);

    for (let i = 0; i < total; i++) {
      // Yield so the browser repaints the bar before the next WASM call.
      await new Promise<void>(r => setTimeout(r, 0));
      editor.pdf_export_spread();
      setProgress(0.15 + (i + 1) / total * 0.85);
      console.log(`  spread ${i + 1}/${total} done`);
    }

    const pdfBytes = editor.pdf_export_finish();
    console.log(`Step 4 done in ${(performance.now() - t0).toFixed(0)} ms — PDF size: ${(pdfBytes.length / 1024).toFixed(1)} KB`);

    // --- Step 5: trigger download ---
    console.log('Step 5: triggering download…');
    const blob = new Blob([pdfBytes.slice()], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'photobook.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    console.log('Export complete.');
  } catch (err) {
    console.error('PDF export failed at the step above ↑', err);
    alert('PDF export failed: ' + (err as Error).message);
  } finally {
    console.groupEnd();
    btn.disabled    = false;
    btn.textContent = 'Export PDF';
    progress.hidden = true;
    setProgress(0);
  }
}
