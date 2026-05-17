// project-io.ts — Save and load .photobook project files.
//
// The .photobook format is a JSON envelope:
//   { "format": "photobook", "version": 1, "saved": "<ISO date>", "document": { ... } }
//
// The "document" field is the raw output of editor.save_state() (a PhotobookDocument).
// Image data is NOT embedded — images must be re-linked via the image folder picker.

import type { PhotobookEditor } from './pkg/photobook_core.js';

export interface SaveFile {
  format: 'photobook';
  version: 1;
  saved: string;
  document: unknown;
}

type SaveResult = { ok: true } | { ok: false; reason: 'cancelled' | 'write_error' };
type OpenResult =
  | { ok: true; file: SaveFile }
  | { ok: false; reason: 'cancelled' | 'read_error' | 'invalid_json' | 'wrong_format' | 'version_too_new' | 'load_failed' };

export async function saveProject(editor: PhotobookEditor): Promise<SaveResult> {
  const doc = JSON.parse(editor.save_state());
  const envelope: SaveFile = {
    format: 'photobook',
    version: 1,
    saved: new Date().toISOString(),
    document: doc,
  };
  const content = JSON.stringify(envelope, null, 2);
  const blob = new Blob([content], { type: 'application/json' });

  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as typeof window & {
        showSaveFilePicker(opts?: object): Promise<FileSystemFileHandle>;
      }).showSaveFilePicker({
        suggestedName: 'project.photobook',
        types: [{ description: 'Photobook project', accept: { 'application/json': ['.photobook'] } }],
      });
      const writable = await (handle as FileSystemFileHandle & {
        createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
      }).createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true };
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return { ok: false, reason: 'cancelled' };
      // Fall through to download fallback on other errors.
    }
  }

  // Fallback: trigger a browser download.
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: 'project.photobook' });
  a.click();
  URL.revokeObjectURL(url);
  return { ok: true };
}

export async function openProject(editor: PhotobookEditor): Promise<OpenResult> {
  let text: string;

  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await (window as typeof window & {
        showOpenFilePicker(opts?: object): Promise<FileSystemFileHandle[]>;
      }).showOpenFilePicker({
        types: [{ description: 'Photobook project', accept: { 'application/json': ['.photobook'] } }],
        multiple: false,
      });
      const file = await handle.getFile();
      text = await file.text();
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: 'read_error' };
    }
  } else {
    // Fallback: hidden <input type="file">.
    try {
      text = await new Promise<string>((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.photobook';
        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          if (!file) { reject(new Error('no_file')); return; }
          resolve(await file.text());
        });
        // Some browsers don't fire 'cancel'; treat focus-return with no file as cancel.
        window.addEventListener('focus', function onFocus() {
          window.removeEventListener('focus', onFocus);
          setTimeout(() => { if (!input.files?.length) reject(new Error('cancelled')); }, 300);
        }, { once: true });
        input.click();
      });
    } catch (e) {
      return { ok: false, reason: (e as Error).message === 'cancelled' ? 'cancelled' : 'read_error' };
    }
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  if (
    typeof envelope !== 'object' || envelope === null ||
    (envelope as Record<string, unknown>)['format'] !== 'photobook'
  ) {
    return { ok: false, reason: 'wrong_format' };
  }

  const env = envelope as Record<string, unknown>;
  if (typeof env['version'] === 'number' && env['version'] > 1) {
    return { ok: false, reason: 'version_too_new' };
  }

  const docJson = JSON.stringify(env['document'] ?? {});
  if (!editor.load_state(docJson)) {
    return { ok: false, reason: 'load_failed' };
  }

  return { ok: true, file: envelope as SaveFile };
}
