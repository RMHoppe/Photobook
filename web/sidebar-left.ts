// sidebar-left.ts — Image browser using the File System Access API.
//
// Loading strategy:
//   1. Folder scan stores FileSystemFileHandle refs only — no file bytes read upfront.
//   2. IntersectionObserver triggers decode only for visible grid items.
//   3. A semaphore caps concurrent createImageBitmap calls (DECODE_CONCURRENCY).
//   4. createImageBitmap runs off the main thread; no jank during proxy creation.
//   5. ArrayBuffers are read lazily: only when an image is exported or assigned.
//
// Selection model:
//   - Click: select single image (clears previous selection).
//   - Ctrl/Cmd+Click: toggle image into/out of the selection.
//   - Shift+Click: extend selection range from last-clicked item.
//   - Drag: initiates a canvas drop using the dragged image; does not alter
//     the sidebar selection.

import { PROXY_MAX_PX, THUMB_MAX_PX, DECODE_CONCURRENCY } from './constants.js';

export interface ImageBufferEntry {
  id: string;
  buffer: ArrayBuffer;
  width_px: number;
  height_px: number;
}

export class ImageSidebar {
  private gridEl: HTMLElement;
  /** Called whenever the sidebar selection changes. */
  private onPhotoSelect: (ids: ReadonlySet<string>) => void;
  private onProxyReady: (id: string) => void;

  private _rootHandle: FileSystemDirectoryHandle | null = null;
  private _handles  = new Map<string, FileSystemFileHandle>();
  private _proxies  = new Map<string, ImageBitmap>();       // 800px, for canvas rendering
  private _buffers  = new Map<string, ArrayBuffer>();       // lazy, for PDF export
  private _dims     = new Map<string, [number, number]>();  // natural dims, lazy
  private _sizes    = new Map<string, number>();            // file sizes in bytes

  /** Ordered list of IDs matching DOM order — used for shift-range selection. */
  private _ids: string[] = [];
  /** Currently selected image IDs. */
  private _selectedIds: Set<string> = new Set();
  /** Index of the last item clicked (for shift-range). */
  private _lastClickedIdx: number | null = null;

  // Semaphore
  private _active = 0;
  private _queue: Array<() => void> = [];

  // IntersectionObserver — fires when a grid item enters the scroll viewport
  private _observer: IntersectionObserver;

  constructor(
    gridEl: HTMLElement,
    onPhotoSelect: (ids: ReadonlySet<string>) => void,
    onProxyReady?: (id: string) => void,
  ) {
    this.gridEl         = gridEl;
    this.onPhotoSelect  = onPhotoSelect;
    this.onProxyReady   = onProxyReady ?? (() => {});

    this._observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        const id = el.dataset.id;
        if (!id || this._proxies.has(id)) continue;
        this._observer.unobserve(el);
        this._scheduleLoad(id, el);
      }
    }, { rootMargin: '300px' }); // pre-load 300 px before item scrolls into view
  }

  async openFolder(): Promise<void> {
    if (!('showDirectoryPicker' in window)) {
      alert('File System Access API not supported in this browser. Use Chrome or Edge.');
      return;
    }
    let dirHandle: FileSystemDirectoryHandle;
    try {
      dirHandle = await (window as typeof window & {
        showDirectoryPicker(opts?: object): Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker({ mode: 'read' });
    } catch {
      return; // user cancelled
    }

    // Tear down previous state.
    this._observer.disconnect();
    this.gridEl.innerHTML = '';
    this._ids = [];
    this._selectedIds = new Set();
    this._lastClickedIdx = null;
    this._rootHandle = dirHandle;
    this._handles.clear();
    this._proxies.clear();
    this._buffers.clear();
    this._dims.clear();
    this._sizes.clear();

    await this._scanDir(dirHandle);
  }

  private async _scanDir(dirHandle: FileSystemDirectoryHandle): Promise<void> {
    const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];
    type DirEntries = AsyncIterable<[string, FileSystemHandle]>;

    for await (const [name, handle] of (dirHandle as unknown as DirEntries)) {
      if (handle.kind === 'directory') {
        await this._scanDir(handle as FileSystemDirectoryHandle);
      } else if (handle.kind === 'file') {
        if (!IMAGE_EXTS.some(ext => name.toLowerCase().endsWith(ext))) continue;

        const fileHandle = handle as FileSystemFileHandle;
        const parts = this._rootHandle ? await this._rootHandle.resolve(fileHandle) : null;
        const id = parts ? parts.join('/') : name;

        this._handles.set(id, fileHandle);
        this._ids.push(id);

        const item = this._makeItem(id, name);
        this.gridEl.appendChild(item);
        this._observer.observe(item);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Grid item DOM
  // -------------------------------------------------------------------------

  private _makeItem(id: string, name: string): HTMLElement {
    const div = document.createElement('div');
    div.className = 'image-thumb';
    div.dataset.id = id;
    div.title = name;

    // Placeholder canvas — grey fill until proxy is decoded.
    const canvas = document.createElement('canvas');
    canvas.width  = THUMB_MAX_PX;
    canvas.height = THUMB_MAX_PX;
    const pCtx = canvas.getContext('2d')!;
    pCtx.fillStyle = '#3a3a3a';
    pCtx.fillRect(0, 0, THUMB_MAX_PX, THUMB_MAX_PX);
    div.appendChild(canvas);

    // Used-badge (hidden until updateUsedBadges marks it).
    const badge = document.createElement('div');
    badge.className = 'image-used-badge';
    badge.textContent = '✓';
    badge.hidden = true;
    div.appendChild(badge);

    div.addEventListener('click', (e) => this._handleClick(e, id));
    div.draggable = true;
    div.addEventListener('dragstart', (e: DragEvent) => {
      // If the dragged item is already part of a multi-selection, carry all
      // selected IDs. Otherwise drag only this one.
      const dragIds = (this._selectedIds.has(id) && this._selectedIds.size > 1)
        ? [...this._selectedIds]
        : [id];
      e.dataTransfer!.setData('text/plain', JSON.stringify(dragIds));
      e.dataTransfer!.effectAllowed = 'copy';
      // Refresh proxy cache for all dragged images.
      this.onPhotoSelect(this._selectedIds);
    });

    return div;
  }

  private _handleClick(e: MouseEvent, id: string): void {
    const idx = this._ids.indexOf(id);
    if (idx === -1) return;

    if (e.ctrlKey || e.metaKey) {
      // Toggle this item.
      if (this._selectedIds.has(id)) {
        this._selectedIds.delete(id);
      } else {
        this._selectedIds.add(id);
      }
      this._lastClickedIdx = idx;
    } else if (e.shiftKey && this._lastClickedIdx !== null) {
      // Extend selection range from last click to here.
      const lo = Math.min(this._lastClickedIdx, idx);
      const hi = Math.max(this._lastClickedIdx, idx);
      for (let i = lo; i <= hi; i++) this._selectedIds.add(this._ids[i]);
      // Don't update _lastClickedIdx on shift-click.
    } else {
      // Plain click — select only this item.
      this._selectedIds = new Set([id]);
      this._lastClickedIdx = idx;
    }

    this._syncSelectedClass();
    this.onPhotoSelect(this._selectedIds);
  }

  private _syncSelectedClass(): void {
    for (const el of this.gridEl.querySelectorAll<HTMLElement>('.image-thumb')) {
      el.classList.toggle('selected', this._selectedIds.has(el.dataset.id!));
    }
  }

  // -------------------------------------------------------------------------
  // Used-image badge
  // -------------------------------------------------------------------------

  /** Update the green tick badges to reflect which images are currently placed on any spread. */
  updateUsedBadges(usedIds: ReadonlySet<string>): void {
    for (const el of this.gridEl.querySelectorAll<HTMLElement>('.image-thumb')) {
      const badge = el.querySelector<HTMLElement>('.image-used-badge');
      if (badge) badge.hidden = !usedIds.has(el.dataset.id!);
    }
  }

  // -------------------------------------------------------------------------
  // Decode pipeline with semaphore
  // -------------------------------------------------------------------------

  private _scheduleLoad(id: string, item: HTMLElement): void {
    const run = async () => {
      try {
        await this._loadProxy(id, item);
      } finally {
        this._active--;
        this._queue.shift()?.();
      }
    };

    if (this._active < DECODE_CONCURRENCY) {
      this._active++;
      run();
    } else {
      this._queue.push(() => { this._active++; run(); });
    }
  }

  private async _loadProxy(id: string, item: HTMLElement): Promise<void> {
    const handle = this._handles.get(id);
    if (!handle) return;

    const file = await handle.getFile();
    this._sizes.set(id, file.size);

    // createImageBitmap decodes off the main thread — no frame drops.
    // resizeWidth produces a downsampled proxy; fall back to full size on Safari.
    let proxy: ImageBitmap;
    try {
      proxy = await createImageBitmap(file, {
        resizeWidth: PROXY_MAX_PX,
        resizeQuality: 'medium',
      } as ImageBitmapOptions);
    } catch {
      proxy = await createImageBitmap(file);
    }

    this._proxies.set(id, proxy);

    // Paint thumbnail into the grid canvas, letterboxed into a square.
    const canvas = item.querySelector('canvas');
    if (canvas) {
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#3a3a3a';
      ctx.fillRect(0, 0, THUMB_MAX_PX, THUMB_MAX_PX);
      const scale = Math.max(THUMB_MAX_PX / proxy.width, THUMB_MAX_PX / proxy.height);
      const tw = Math.round(proxy.width  * scale);
      const th = Math.round(proxy.height * scale);
      const ox = Math.floor((THUMB_MAX_PX - tw) / 2);
      const oy = Math.floor((THUMB_MAX_PX - th) / 2);
      ctx.drawImage(proxy, ox, oy, tw, th);
    }

    this.onProxyReady(id);
  }

  // -------------------------------------------------------------------------
  // Public accessors
  // -------------------------------------------------------------------------

  /** Returns the 800px proxy ImageBitmap, or null if not yet decoded. */
  getProxy(id: string): ImageBitmap | null {
    return this._proxies.get(id) ?? null;
  }

  /** Returns the known file size in bytes, or null if not yet loaded. */
  getFileSize(id: string): number | null {
    return this._sizes.get(id) ?? null;
  }

  /** Returns the current sidebar selection. */
  getSelectedIds(): ReadonlySet<string> {
    return this._selectedIds;
  }

  /** Clears the sidebar selection without firing onPhotoSelect. */
  clearSelection(): void {
    this._selectedIds = new Set();
    this._lastClickedIdx = null;
    this._syncSelectedClass();
  }

  /**
   * Returns the raw file bytes for `id`, reading from disk on first call.
   * Used for PDF export. May return null if the handle is no longer valid.
   */
  async getBuffer(id: string): Promise<ArrayBuffer | null> {
    if (this._buffers.has(id)) return this._buffers.get(id)!;
    const handle = this._handles.get(id);
    if (!handle) return null;
    const file = await handle.getFile();
    const buf  = await file.arrayBuffer();
    this._buffers.set(id, buf);
    return buf;
  }

  /**
   * Returns the natural pixel dimensions of the image, decoding it once
   * at full resolution (off main thread) then immediately freeing the bitmap.
   * Cached after first call.
   */
  async ensureDimensions(id: string): Promise<[number, number] | null> {
    if (this._dims.has(id)) return this._dims.get(id)!;
    const handle = this._handles.get(id);
    if (!handle) return null;
    const file = await handle.getFile();
    const bm   = await createImageBitmap(file);
    const dims: [number, number] = [bm.width, bm.height];
    bm.close(); // free the full-resolution bitmap immediately
    this._dims.set(id, dims);
    return dims;
  }

  /** Returns the relative-path IDs of all images currently loaded from the folder. */
  loadedImageIds(): string[] {
    return [...this._handles.keys()];
  }

  /**
   * Async generator that yields buffer entries for every image in the folder.
   * Files not yet read are fetched on demand. Suitable for PDF export.
   */
  async *buffersForExport(): AsyncGenerator<ImageBufferEntry> {
    for (const id of this._handles.keys()) {
      const buf  = await this.getBuffer(id);
      if (!buf) continue;
      const dims = await this.ensureDimensions(id);
      yield {
        id,
        buffer:    buf,
        width_px:  dims?.[0] ?? 0,
        height_px: dims?.[1] ?? 0,
      };
    }
  }
}
