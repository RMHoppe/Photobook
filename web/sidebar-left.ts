// sidebar-left.ts — Image browser using the File System Access API.
//
// Loading strategy:
//   1. Folder scan stores FileSystemFileHandle refs only — no file bytes read upfront.
//      On browsers without showDirectoryPicker (e.g. Firefox), falls back to
//      <input webkitdirectory> and stores File objects in _files instead.
//   2. IntersectionObserver triggers decode only for visible grid items.
//   3. A semaphore caps concurrent createImageBitmap calls (DECODE_CONCURRENCY).
//   4. createImageBitmap runs off the main thread; no jank during proxy creation.
//   5. ArrayBuffers are read lazily: only when an image is exported or assigned.
//      Images loaded via loadImageFromBuffer() (from the image-loader modal) are
//      stored directly in _buffers and their proxies are decoded immediately.
//
// Navigation:
//   - openFolder() picks a root directory and shows its immediate contents.
//   - Subfolder tiles navigate into that directory (shallow scan on demand).
//   - A breadcrumb bar shows the current path; clicking any segment navigates up.
//   - Handles accumulate across all visited directories — images remain available
//     for export even after navigating away from the level where they were found.
//   - The <input> fallback path builds the full file index upfront from webkitRelativePath,
//     then filters per level — navigation UX is identical to the handle path.
//
// Selection model:
//   - Click: select single image (clears previous selection).
//   - Ctrl/Cmd+Click: toggle image into/out of the selection.
//   - Shift+Click: extend selection range from last-clicked item.
//   - Drag: initiates a canvas drop using the dragged image; does not alter
//     the sidebar selection.

import { PROXY_MAX_PX, THUMB_MAX_PX, DECODE_CONCURRENCY, IMAGE_EXTS, PROXY_CACHE_BUDGET_BYTES, BUFFER_CACHE_BUDGET_BYTES } from './constants.js';
import { LruCache, rasterBytes } from './lru.js';

export interface ImageBufferEntry {
  id: string;
  buffer: ArrayBuffer;
  width_px: number;
  height_px: number;
}

export class ImageSidebar {
  private gridEl: HTMLElement;
  private breadcrumbEl: HTMLElement;
  /** Called whenever the sidebar selection changes. */
  private onPhotoSelect: (ids: ReadonlySet<string>) => void;
  private onProxyReady: (id: string) => void;

  private _breadcrumb: Array<{ name: string; handle: FileSystemDirectoryHandle | null }> = [];
  private get _rootHandle(): FileSystemDirectoryHandle | null {
    return this._breadcrumb[0]?.handle ?? null;
  }
  private _handles      = new Map<string, FileSystemFileHandle>();
  /** Full file index for the <input webkitdirectory> fallback, keyed by stripped relative path. */
  private _fallbackFiles = new Map<string, { name: string; file: File }>();
  /** Called when a proxy bitmap is evicted from the LRU cache. Wire this up
   *  in main.ts to also evict from the canvas cache and call bitmap.close(). */
  onBitmapEvicted: ((id: string, bitmap: ImageBitmap) => void) | null = null;

  private _proxies  = new LruCache<ImageBitmap>(
    PROXY_CACHE_BUDGET_BYTES,
    rasterBytes,
    (id, bitmap) => this.onBitmapEvicted?.(id, bitmap),
  );  // 800px, for canvas rendering
  private _buffers  = new LruCache<ArrayBuffer>(BUFFER_CACHE_BUDGET_BYTES, b => b.byteLength);  // lazy, for PDF export
  private _dims     = new Map<string, [number, number]>();  // natural dims, lazy
  private _sizes    = new Map<string, number>();            // file sizes in bytes
  /** IDs loaded directly from raw buffers (no FileSystemFileHandle). */
  private _loadedIds = new Set<string>();

  /** Ordered list of IDs at the current nav level — used for shift-range selection. */
  private _ids: string[] = [];
  /** Currently selected image IDs. */
  private _selectedIds: Set<string> = new Set();
  /** Index of the last item clicked (for shift-range). */
  private _lastClickedIdx: number | null = null;

  // Semaphore
  private _active = 0;
  private _queue: Array<{ id: string; fn: () => void }> = [];

  // Off-thread proxy decode. `undefined` = not yet created; `null` = permanently
  // failed after too many crashes (falls back to main thread forever).
  private _decodeWorker: Worker | null | undefined = undefined;
  private _decodeWorkerCrashes = 0;
  private static readonly MAX_WORKER_CRASHES = 3;
  private _decodeReqSeq = 0;
  private _decodePending = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }>();
  private _cancelledReqIds = new Set<number>();

  // IntersectionObserver — fires when a grid item enters the scroll viewport
  private _observer: IntersectionObserver;

  private _emptyStateEl: HTMLElement | null;

  constructor(
    gridEl: HTMLElement,
    breadcrumbEl: HTMLElement,
    onPhotoSelect: (ids: ReadonlySet<string>) => void,
    onProxyReady?: (id: string) => void,
  ) {
    this.gridEl        = gridEl;
    this.breadcrumbEl  = breadcrumbEl;
    this.onPhotoSelect = onPhotoSelect;
    this.onProxyReady  = onProxyReady ?? (() => {});
    this._emptyStateEl = document.getElementById('sidebar-empty-state');

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
    if ('showDirectoryPicker' in window) {
      let dirHandle: FileSystemDirectoryHandle;
      try {
        dirHandle = await (window as typeof window & {
          showDirectoryPicker(opts?: object): Promise<FileSystemDirectoryHandle>;
        }).showDirectoryPicker({ mode: 'read' });
      } catch {
        return; // user cancelled
      }
      await this.openFolderHandle(dirHandle);
    } else {
      await this._openFolderViaInput();
    }
  }

  private _openFolderViaInput(): Promise<void> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
      input.addEventListener('change', () => {
        if (!input.files || input.files.length === 0) { resolve(); return; }
        void this.openFolderFallback(input.files).then(resolve);
      });
      input.addEventListener('cancel', () => resolve());
      input.click();
    });
  }

  /** Load a directory handle already acquired via showDirectoryPicker. */
  async openFolderHandle(dirHandle: FileSystemDirectoryHandle): Promise<void> {
    this._emptyStateEl?.classList.add('hidden');
    for (const id of [...this._handles.keys(), ...this._fallbackFiles.keys()]) {
      this._proxies.delete(id);
      this._dims.delete(id);
      this._sizes.delete(id);
    }
    this._handles.clear();
    this._fallbackFiles.clear();
    // _buffers kept intentionally: buffer-loaded entries stay for export.
    this._breadcrumb = [{ name: dirHandle.name, handle: dirHandle }];
    await this._loadCurrentDir();
  }

  /**
   * Fallback for browsers without showDirectoryPicker (e.g. Firefox).
   * Loads images from a FileList obtained via <input webkitdirectory>.
   * Builds a full file index from webkitRelativePath, then navigates the same
   * way as the handle-based path by filtering per level on demand.
   */
  async openFolderFallback(files: FileList): Promise<void> {
    this._emptyStateEl?.classList.add('hidden');
    for (const id of [...this._handles.keys(), ...this._fallbackFiles.keys()]) {
      this._proxies.delete(id);
      this._dims.delete(id);
      this._sizes.delete(id);
    }
    this._handles.clear();
    this._fallbackFiles.clear();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!IMAGE_EXTS.some(ext => file.name.toLowerCase().endsWith(ext))) continue;
      const relPath   = file.webkitRelativePath;
      const prefixLen = relPath.indexOf('/') + 1;
      const id = relPath.slice(prefixLen); // strip "rootFolder/" prefix
      this._fallbackFiles.set(id, { name: file.name, file });
    }

    const rootName = files[0]?.webkitRelativePath.split('/')[0] || 'Folder';
    this._breadcrumb = [{ name: rootName, handle: null }];
    await this._loadCurrentDir();
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  private async _navigateInto(name: string, handle: FileSystemDirectoryHandle | null): Promise<void> {
    this._breadcrumb.push({ name, handle });
    await this._loadCurrentDir();
  }

  private async _navigateTo(index: number): Promise<void> {
    this._breadcrumb = this._breadcrumb.slice(0, index + 1);
    await this._loadCurrentDir();
  }

  private async _loadCurrentDir(): Promise<void> {
    const { handle } = this._breadcrumb.at(-1)!;

    // Cancel any queued or in-flight decodes from the previous directory.
    this._cancelPendingDecodes();

    // Tear down current display, preserving buffer-loaded images.
    this._observer.disconnect();
    for (const el of this.gridEl.querySelectorAll<HTMLElement>('.folder-thumb, .image-thumb')) {
      if (el.classList.contains('folder-thumb') || !this._loadedIds.has(el.dataset.id!)) el.remove();
    }
    this._ids = this._ids.filter(id => this._loadedIds.has(id));
    this._selectedIds = new Set([...this._selectedIds].filter(id => this._loadedIds.has(id)));
    this._lastClickedIdx = null;

    this._renderBreadcrumb();
    if (handle) {
      await this._scanCurrentLevel(handle);
    } else {
      this._scanFallbackLevel();
    }
  }

  private _renderBreadcrumb(): void {
    if (this._breadcrumb.length <= 1) {
      this.breadcrumbEl.hidden = true;
      return;
    }

    this.breadcrumbEl.hidden = false;
    this.breadcrumbEl.innerHTML = '';

    for (let i = 0; i < this._breadcrumb.length; i++) {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'bc-sep';
        sep.textContent = '/';
        this.breadcrumbEl.appendChild(sep);
      }

      const { name } = this._breadcrumb[i];
      if (i === this._breadcrumb.length - 1) {
        const span = document.createElement('span');
        span.className = 'bc-current';
        span.textContent = name;
        this.breadcrumbEl.appendChild(span);
      } else {
        const btn = document.createElement('button');
        btn.className = 'bc-link';
        btn.textContent = name;
        btn.addEventListener('click', () => { void this._navigateTo(i); });
        this.breadcrumbEl.appendChild(btn);
      }
    }
  }

  private async _scanCurrentLevel(dirHandle: FileSystemDirectoryHandle): Promise<void> {
    type DirEntries = AsyncIterable<[string, FileSystemHandle]>;

    const subDirs: Array<{ name: string; handle: FileSystemDirectoryHandle }> = [];
    const pendingFiles: Array<{ name: string; fileHandle: FileSystemFileHandle }> = [];
    const imageFiles: Array<{ name: string; id: string; fileHandle: FileSystemFileHandle }> = [];

    for await (const [name, handle] of (dirHandle as unknown as DirEntries)) {
      if (handle.kind === 'directory') {
        subDirs.push({ name, handle: handle as FileSystemDirectoryHandle });
      } else if (handle.kind === 'file') {
        if (!IMAGE_EXTS.some(ext => name.toLowerCase().endsWith(ext))) continue;
        pendingFiles.push({ name, fileHandle: handle as FileSystemFileHandle });
      }
    }

    // Resolve all relative paths in parallel — avoids one sequential IPC per file.
    const rootHandle = this._rootHandle;
    const resolvedParts = rootHandle
      ? await Promise.all(pendingFiles.map(f => rootHandle.resolve(f.fileHandle)))
      : pendingFiles.map(() => null);
    for (let i = 0; i < pendingFiles.length; i++) {
      const { name, fileHandle } = pendingFiles[i];
      const parts = resolvedParts[i];
      imageFiles.push({ name, id: parts ? parts.join('/') : name, fileHandle });
    }

    subDirs.sort((a, b) => a.name.localeCompare(b.name));
    imageFiles.sort((a, b) => a.name.localeCompare(b.name));

    for (const { name, handle } of subDirs) {
      this.gridEl.appendChild(this._makeFolderItem(name, () => { void this._navigateInto(name, handle); }));
    }

    for (const { name, id, fileHandle } of imageFiles) {
      this._handles.set(id, fileHandle);
      this._ids.push(id);
      const item = this._makeItem(id, name);
      this.gridEl.appendChild(item);
      // Paint immediately if proxy already cached (re-visiting a directory);
      // otherwise queue lazy decode via IntersectionObserver.
      if (this._proxies.has(id)) {
        this._paintThumbnail(item.querySelector('canvas'), this._proxies.get(id)!);
      } else {
        this._observer.observe(item);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Fallback (input) navigation
  // -------------------------------------------------------------------------

  private _scanFallbackLevel(): void {
    // Path segments below the root are the breadcrumb entries after index 0.
    const pathSegs = this._breadcrumb.slice(1).map(e => e.name);

    const subfolderNames = new Set<string>();
    const imageEntries: Array<{ id: string; name: string; file: File }> = [];

    for (const [id, { name, file }] of this._fallbackFiles) {
      const parts = id.split('/');
      if (parts.length <= pathSegs.length) continue;
      if (!pathSegs.every((seg, i) => parts[i] === seg)) continue;

      if (parts.length === pathSegs.length + 1) {
        imageEntries.push({ id, name, file });
      } else {
        subfolderNames.add(parts[pathSegs.length]);
      }
    }

    [...subfolderNames].sort((a, b) => a.localeCompare(b)).forEach(folderName => {
      this.gridEl.appendChild(this._makeFolderItem(folderName, () => { void this._navigateInto(folderName, null); }));
    });

    imageEntries.sort((a, b) => a.name.localeCompare(b.name));
    for (const { id, name } of imageEntries) {
      this._ids.push(id);
      const item = this._makeItem(id, name);
      this.gridEl.appendChild(item);
      if (this._proxies.has(id)) {
        this._paintThumbnail(item.querySelector('canvas'), this._proxies.get(id)!);
      } else {
        this._observer.observe(item);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Grid item DOM
  // -------------------------------------------------------------------------

  private _makeFolderItem(name: string, onClick: () => void): HTMLElement {
    const div = document.createElement('div');
    div.className = 'folder-thumb';
    div.title = name;
    const label = document.createElement('span');
    label.className = 'folder-thumb-label';
    label.textContent = name;
    div.appendChild(label);
    div.addEventListener('click', onClick);
    return div;
  }

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
    badge.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i>';
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

  private _paintThumbnail(canvas: HTMLCanvasElement | null, proxy: ImageBitmap): void {
    if (!canvas) return;
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
        this._queue.shift()?.fn();
      }
    };

    if (this._active < DECODE_CONCURRENCY) {
      this._active++;
      run();
    } else {
      this._queue.push({ id, fn: () => { this._active++; run(); } });
    }
  }

  /** Cancel pending (queued + in-flight) decode requests from a prior directory scan. */
  private _cancelPendingDecodes(): void {
    this._queue = [];
    for (const [reqId] of this._decodePending) {
      this._cancelledReqIds.add(reqId);
    }
    // In-flight worker requests are not recalled — we just discard their responses.
  }

  private async _getFile(id: string): Promise<File | null> {
    const handle = this._handles.get(id);
    if (handle) return handle.getFile();
    return this._fallbackFiles.get(id)?.file ?? null;
  }

  private async _loadProxy(id: string, item: HTMLElement): Promise<void> {
    const file = await this._getFile(id);
    if (!file) return;

    this._sizes.set(id, file.size);

    // createImageBitmap decodes off the main thread — no frame drops.
    // resizeWidth produces a downsampled proxy; fall back to full size on Safari.
    let proxy: ImageBitmap;
    try {
      // Decode + downsize off the main thread (fresh read is transferred to
      // the worker); fall back to a direct main-thread decode on failure.
      proxy = await this._decodeProxy(await file.arrayBuffer(), PROXY_MAX_PX);
    } catch {
      proxy = await createImageBitmap(file);
    }

    this._proxies.set(id, proxy);
    this._paintThumbnail(item.querySelector('canvas'), proxy);
    this.onProxyReady(id);
  }

  // -------------------------------------------------------------------------
  // Public accessors
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Off-thread proxy decode
  // -------------------------------------------------------------------------

  private _getDecodeWorker(): Worker | null {
    if (this._decodeWorker !== undefined) return this._decodeWorker;
    try {
      const w = new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' });
      w.addEventListener('message', (e: MessageEvent) => {
        const m = e.data as { reqId: number; ok: boolean; bitmap?: ImageBitmap; message?: string };
        if (this._cancelledReqIds.has(m.reqId)) {
          this._cancelledReqIds.delete(m.reqId);
          this._decodePending.delete(m.reqId);
          m.bitmap?.close();  // release GPU memory for cancelled decodes
          return;
        }
        const pending = this._decodePending.get(m.reqId);
        if (!pending) return;
        this._decodePending.delete(m.reqId);
        if (m.ok && m.bitmap) pending.resolve(m.bitmap);
        else pending.reject(new Error(m.message ?? 'decode failed'));
      });
      w.addEventListener('error', () => {
        for (const p of this._decodePending.values()) p.reject(new Error('decode worker crashed'));
        this._decodePending.clear();
        this._decodeWorkerCrashes++;
        // After too many crashes, give up permanently; otherwise allow lazy re-creation.
        this._decodeWorker = this._decodeWorkerCrashes >= ImageSidebar.MAX_WORKER_CRASHES
          ? null
          : undefined;
      });
      this._decodeWorker = w;
    } catch {
      this._decodeWorkerCrashes++;
      this._decodeWorker = this._decodeWorkerCrashes >= ImageSidebar.MAX_WORKER_CRASHES
        ? null
        : undefined;
    }
    // If the field is `undefined` it means we want to retry next call; return
    // null to the caller so this request falls back to the main thread.
    return this._decodeWorker ?? null;
  }

  /**
   * Decode + downsize to a proxy ImageBitmap. `bytes` is transferred to the
   * worker, so pass a buffer the caller no longer needs (a fresh read or copy).
   */
  private async _decodeProxy(bytes: ArrayBuffer, maxWidth: number): Promise<ImageBitmap> {
    const worker = this._getDecodeWorker();
    if (!worker) return this._decodeMainThread(bytes, maxWidth);
    const reqId = ++this._decodeReqSeq;
    return new Promise<ImageBitmap>((resolve, reject) => {
      this._decodePending.set(reqId, { resolve, reject });
      worker.postMessage({ reqId, bytes, maxWidth }, [bytes]);
    });
  }

  private async _decodeMainThread(bytes: ArrayBuffer, maxWidth: number): Promise<ImageBitmap> {
    const blob = new Blob([bytes]);
    try {
      return await createImageBitmap(blob, { resizeWidth: maxWidth, resizeQuality: 'medium' } as ImageBitmapOptions);
    } catch {
      return await createImageBitmap(blob);
    }
  }

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
    const file = await this._getFile(id);
    if (!file) return null;
    const buf = await file.arrayBuffer();
    this._buffers.set(id, buf);
    return buf;
  }

  /**
   * Returns the natural pixel dimensions of the image, decoding it once
   * at full resolution (off main thread) then immediately freeing the bitmap.
   * Cached after first call. Falls back to _buffers for buffer-loaded images.
   */
  async ensureDimensions(id: string): Promise<[number, number] | null> {
    if (this._dims.has(id)) return this._dims.get(id)!;
    const file = await this._getFile(id);
    if (file) {
      const bm   = await createImageBitmap(file);
      const dims: [number, number] = [bm.width, bm.height];
      bm.close();
      this._dims.set(id, dims);
      return dims;
    }
    const buf = this._buffers.get(id);
    if (buf) {
      const bm   = await createImageBitmap(new Blob([buf]));
      const dims: [number, number] = [bm.width, bm.height];
      bm.close();
      this._dims.set(id, dims);
      return dims;
    }
    return null;
  }

  /** Returns the IDs of all images available for use (folder + buffer-loaded). */
  loadedImageIds(): string[] {
    return [...new Set([...this._handles.keys(), ...this._fallbackFiles.keys(), ...this._loadedIds])];
  }

  /**
   * Loads an image from raw bytes, adds it to the sidebar grid, and fires
   * onProxyReady so the canvas renderer caches it immediately.
   * Called by the image-loader modal for each matched file.
   */
  async loadImageFromBuffer(id: string, buf: ArrayBuffer): Promise<void> {
    this._emptyStateEl?.classList.add('hidden');
    this._buffers.set(id, buf);
    this._sizes.set(id, buf.byteLength);
    this._loadedIds.add(id);

    // Decode the proxy off-thread. Transfer a copy so the cached buffer (kept
    // in _buffers for export) isn't detached.
    const proxy = await this._decodeProxy(buf.slice(0), PROXY_MAX_PX);
    this._proxies.set(id, proxy);

    // Add grid item and paint thumbnail immediately.
    const name = id.split('/').at(-1) ?? id;
    const item = this._makeItem(id, name);
    this.gridEl.appendChild(item);
    this._ids.push(id);
    this._paintThumbnail(item.querySelector('canvas'), proxy);

    this.onProxyReady(id);
  }

  /**
   * Removes all buffer-loaded images (added via loadImageFromBuffer).
   * Called before loading a new project so stale images from the previous
   * session don't remain in the sidebar.
   */
  clearLoadedImages(): void {
    for (const id of this._loadedIds) {
      if (this._handles.has(id)) continue; // keep if folder also has it
      this._proxies.delete(id);
      this._buffers.delete(id);
      this._dims.delete(id);
      this._sizes.delete(id);
      this._selectedIds.delete(id);
      const idx = this._ids.indexOf(id);
      if (idx !== -1) this._ids.splice(idx, 1);
      this.gridEl.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
    }
    this._loadedIds.clear();
    this._lastClickedIdx = null;
  }

  /**
   * Async generator that yields buffer entries for every image in the sidebar.
   * Files not yet read are fetched on demand. Suitable for PDF export.
   */
  async *buffersForExport(): AsyncGenerator<ImageBufferEntry> {
    const allIds = new Set([...this._handles.keys(), ...this._fallbackFiles.keys(), ...this._loadedIds]);
    for (const id of allIds) {
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
