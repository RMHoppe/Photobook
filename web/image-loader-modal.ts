// image-loader-modal.ts — Modal for locating project images on project open.
import { IMAGE_EXTS } from './constants.js';
//
// Workflow:
//   1. Caller supplies the list of missing image IDs and opens the modal.
//   2. User clicks "Select Folder"; the modal scans the chosen directory.
//   3. Each file is matched to a needed ID: exact relative-path match first,
//      filename match as fallback (case-insensitive).
//   4. Matched files are read and passed to onImageFound; the caller loads
//      them into the sidebar and renderer.
//   5. Resolved IDs are removed from the list. If none remain, the modal
//      closes automatically. Otherwise the user can select another folder or
//      click "Continue" to dismiss with some images still missing.

export type ImageFoundCallback = (id: string, buf: ArrayBuffer) => Promise<void>;
export type FolderPickedCallback = (handle: FileSystemDirectoryHandle) => Promise<void>;
export type FilePickedCallback = (files: FileList) => Promise<void>;

export class ImageLoaderModal {
  private dialog: HTMLDialogElement;
  private statusEl!: HTMLElement;
  private listEl!: HTMLUListElement;
  private selectBtn!: HTMLButtonElement;
  private continueBtn!: HTMLButtonElement;

  private _pending = new Set<string>();
  private _total   = 0;
  private _onImageFound: ImageFoundCallback;
  private _onClose: () => void;
  private _onFolderPicked?: FolderPickedCallback;
  private _onFilePicked?: FilePickedCallback;

  constructor(
    onImageFound: ImageFoundCallback,
    onClose: () => void,
    onFolderPicked?: FolderPickedCallback,
    onFilePicked?: FilePickedCallback,
  ) {
    this._onImageFound   = onImageFound;
    this._onClose        = onClose;
    this._onFolderPicked = onFolderPicked;
    this._onFilePicked   = onFilePicked;
    this.dialog          = this._build();
    document.body.appendChild(this.dialog);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  open(neededIds: string[]): void {
    this._pending = new Set(neededIds);
    this._total   = neededIds.length;
    this._render();
    this.dialog.showModal();
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  private _build(): HTMLDialogElement {
    const dialog = document.createElement('dialog');
    dialog.className = 'ilm-dialog';
    dialog.innerHTML = `
      <div class="ilm-header">
        <h2 class="ilm-title">Find project images</h2>
        <button class="ilm-close docs-close" title="Close">&#x2715;</button>
      </div>
      <p class="ilm-status"></p>
      <ul class="ilm-list"></ul>
      <div class="ilm-actions">
        <button class="ilm-select">Select Folder</button>
        <button class="ilm-continue">Continue</button>
      </div>
    `;

    this.statusEl   = dialog.querySelector('.ilm-status')!;
    this.listEl     = dialog.querySelector('.ilm-list')!;
    this.selectBtn  = dialog.querySelector('.ilm-select')!;
    this.continueBtn = dialog.querySelector('.ilm-continue')!;

    dialog.querySelector('.ilm-close')!.addEventListener('click', () => dialog.close());
    this.continueBtn.addEventListener('click', () => dialog.close());
    this.selectBtn.addEventListener('click', () => { void this._selectFolder(); });
    dialog.addEventListener('close', () => this._onClose());

    return dialog;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  private _render(): void {
    const found = this._total - this._pending.size;

    if (found === 0) {
      this.statusEl.textContent =
        `${this._total} image${this._total === 1 ? '' : 's'} used in this project must be located:`;
    } else {
      this.statusEl.textContent =
        `${found} of ${this._total} found. Still missing:`;
    }

    this.listEl.innerHTML = '';
    for (const id of this._pending) {
      const li   = document.createElement('li');
      const name = id.split('/').at(-1) ?? id;
      const nameSpan = document.createElement('span');
      nameSpan.className = 'ilm-filename';
      nameSpan.textContent = name;
      li.appendChild(nameSpan);
      if (id !== name) {
        const pathSpan = document.createElement('span');
        pathSpan.className = 'ilm-filepath';
        pathSpan.textContent = id;
        li.appendChild(pathSpan);
      }
      this.listEl.appendChild(li);
    }

    this.selectBtn.textContent = found === 0 ? 'Select Folder' : 'Select Another Folder';
  }

  // ---------------------------------------------------------------------------
  // Folder scanning and matching
  // ---------------------------------------------------------------------------

  private async _selectFolder(): Promise<void> {
    if ('showDirectoryPicker' in window) {
      await this._selectFolderViaAPI();
    } else {
      await this._selectFolderViaInput();
    }
  }

  private async _selectFolderViaAPI(): Promise<void> {
    let dirHandle: FileSystemDirectoryHandle;
    try {
      dirHandle = await (window as typeof window & {
        showDirectoryPicker(opts?: object): Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker({ mode: 'read' });
    } catch {
      return; // user cancelled
    }

    this.selectBtn.disabled   = true;
    this.continueBtn.disabled = true;
    this.statusEl.textContent = 'Scanning folder…';

    void this._onFolderPicked?.(dirHandle);

    const byPath = new Map<string, FileSystemFileHandle>();
    const byName = new Map<string, FileSystemFileHandle>();
    await this._scan(dirHandle, dirHandle, byPath, byName);
    await this._matchAndLoad(
      (id) => byPath.get(id) ?? byName.get(id.split('/').at(-1)!.toLowerCase()) ?? null,
      async (fh) => { const f = await (fh as FileSystemFileHandle).getFile(); return f.arrayBuffer(); },
    );
  }

  private _selectFolderViaInput(): Promise<void> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type  = 'file';
      (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
      input.addEventListener('change', () => {
        if (!input.files || input.files.length === 0) { resolve(); return; }
        void this._processFileList(input.files).then(resolve);
      });
      input.addEventListener('cancel', () => resolve());
      input.click();
    });
  }

  private async _processFileList(files: FileList): Promise<void> {
    this.selectBtn.disabled   = true;
    this.continueBtn.disabled = true;
    this.statusEl.textContent = 'Scanning folder…';

    void this._onFilePicked?.(files);

    // Build lookup tables from FileList, stripping the root folder prefix.
    const byPath = new Map<string, File>();
    const byName = new Map<string, File>();
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!IMAGE_EXTS.some(ext => file.name.toLowerCase().endsWith(ext))) continue;
      const relPath   = file.webkitRelativePath;
      const prefixLen = relPath.indexOf('/') + 1;
      byPath.set(relPath.slice(prefixLen), file);
      const key = file.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, file);
    }

    await this._matchAndLoad(
      (id) => byPath.get(id) ?? byName.get(id.split('/').at(-1)!.toLowerCase()) ?? null,
      async (f) => (f as File).arrayBuffer(),
    );
  }

  private async _matchAndLoad<T>(
    lookup: (id: string) => T | null,
    readBuf: (entry: T) => Promise<ArrayBuffer>,
  ): Promise<void> {
    const pendingSnapshot = [...this._pending];
    for (const id of pendingSnapshot) {
      const entry = lookup(id);
      if (!entry) continue;

      const basename = id.split('/').at(-1)!;
      this.statusEl.textContent = `Loading “${basename}”…`;
      const buf = await readBuf(entry);
      await this._onImageFound(id, buf);

      this._pending.delete(id);
      this._render();
    }

    this.selectBtn.disabled   = false;
    this.continueBtn.disabled = false;

    if (this._pending.size === 0) {
      this.dialog.close();
    }
  }

  private async _scan(
    dirHandle: FileSystemDirectoryHandle,
    rootHandle: FileSystemDirectoryHandle,
    byPath: Map<string, FileSystemFileHandle>,
    byName: Map<string, FileSystemFileHandle>,
  ): Promise<void> {
    type DirEntries = AsyncIterable<[string, FileSystemHandle]>;

    for await (const [name, handle] of (dirHandle as unknown as DirEntries)) {
      if (handle.kind === 'directory') {
        await this._scan(handle as FileSystemDirectoryHandle, rootHandle, byPath, byName);
      } else if (handle.kind === 'file') {
        if (!IMAGE_EXTS.some(ext => name.toLowerCase().endsWith(ext))) continue;
        const fh    = handle as FileSystemFileHandle;
        const parts = await rootHandle.resolve(fh);
        if (parts) byPath.set(parts.join('/'), fh);
        const key = name.toLowerCase();
        if (!byName.has(key)) byName.set(key, fh);
      }
    }
  }
}
