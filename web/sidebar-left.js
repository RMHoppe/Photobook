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
import { PROXY_MAX_PX, THUMB_MAX_PX, DECODE_CONCURRENCY, IMAGE_EXTS } from './constants.js';
export class ImageSidebar {
    gridEl;
    breadcrumbEl;
    /** Called whenever the sidebar selection changes. */
    onPhotoSelect;
    onProxyReady;
    _breadcrumb = [];
    get _rootHandle() {
        return this._breadcrumb[0]?.handle ?? null;
    }
    _handles = new Map();
    /** Full file index for the <input webkitdirectory> fallback, keyed by stripped relative path. */
    _fallbackFiles = new Map();
    _proxies = new Map(); // 800px, for canvas rendering
    _buffers = new Map(); // lazy, for PDF export
    _dims = new Map(); // natural dims, lazy
    _sizes = new Map(); // file sizes in bytes
    /** IDs loaded directly from raw buffers (no FileSystemFileHandle). */
    _loadedIds = new Set();
    /** Ordered list of IDs at the current nav level — used for shift-range selection. */
    _ids = [];
    /** Currently selected image IDs. */
    _selectedIds = new Set();
    /** Index of the last item clicked (for shift-range). */
    _lastClickedIdx = null;
    // Semaphore
    _active = 0;
    _queue = [];
    // IntersectionObserver — fires when a grid item enters the scroll viewport
    _observer;
    _emptyStateEl;
    constructor(gridEl, breadcrumbEl, onPhotoSelect, onProxyReady) {
        this.gridEl = gridEl;
        this.breadcrumbEl = breadcrumbEl;
        this.onPhotoSelect = onPhotoSelect;
        this.onProxyReady = onProxyReady ?? (() => { });
        this._emptyStateEl = document.getElementById('sidebar-empty-state');
        this._observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting)
                    continue;
                const el = entry.target;
                const id = el.dataset.id;
                if (!id || this._proxies.has(id))
                    continue;
                this._observer.unobserve(el);
                this._scheduleLoad(id, el);
            }
        }, { rootMargin: '300px' }); // pre-load 300 px before item scrolls into view
    }
    async openFolder() {
        if ('showDirectoryPicker' in window) {
            let dirHandle;
            try {
                dirHandle = await window.showDirectoryPicker({ mode: 'read' });
            }
            catch {
                return; // user cancelled
            }
            await this.openFolderHandle(dirHandle);
        }
        else {
            await this._openFolderViaInput();
        }
    }
    _openFolderViaInput() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.webkitdirectory = true;
            input.addEventListener('change', () => {
                if (!input.files || input.files.length === 0) {
                    resolve();
                    return;
                }
                void this.openFolderFallback(input.files).then(resolve);
            });
            input.addEventListener('cancel', () => resolve());
            input.click();
        });
    }
    /** Load a directory handle already acquired via showDirectoryPicker. */
    async openFolderHandle(dirHandle) {
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
    async openFolderFallback(files) {
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
            if (!IMAGE_EXTS.some(ext => file.name.toLowerCase().endsWith(ext)))
                continue;
            const relPath = file.webkitRelativePath;
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
    async _navigateInto(name, handle) {
        this._breadcrumb.push({ name, handle });
        await this._loadCurrentDir();
    }
    async _navigateTo(index) {
        this._breadcrumb = this._breadcrumb.slice(0, index + 1);
        await this._loadCurrentDir();
    }
    async _loadCurrentDir() {
        const { handle } = this._breadcrumb.at(-1);
        // Tear down current display, preserving buffer-loaded images.
        this._observer.disconnect();
        for (const el of this.gridEl.querySelectorAll('.folder-thumb, .image-thumb')) {
            if (el.classList.contains('folder-thumb') || !this._loadedIds.has(el.dataset.id))
                el.remove();
        }
        this._ids = this._ids.filter(id => this._loadedIds.has(id));
        this._selectedIds = new Set([...this._selectedIds].filter(id => this._loadedIds.has(id)));
        this._lastClickedIdx = null;
        this._renderBreadcrumb();
        if (handle) {
            await this._scanCurrentLevel(handle);
        }
        else {
            this._scanFallbackLevel();
        }
    }
    _renderBreadcrumb() {
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
            }
            else {
                const btn = document.createElement('button');
                btn.className = 'bc-link';
                btn.textContent = name;
                btn.addEventListener('click', () => { void this._navigateTo(i); });
                this.breadcrumbEl.appendChild(btn);
            }
        }
    }
    async _scanCurrentLevel(dirHandle) {
        const subDirs = [];
        const pendingFiles = [];
        const imageFiles = [];
        for await (const [name, handle] of dirHandle) {
            if (handle.kind === 'directory') {
                subDirs.push({ name, handle: handle });
            }
            else if (handle.kind === 'file') {
                if (!IMAGE_EXTS.some(ext => name.toLowerCase().endsWith(ext)))
                    continue;
                pendingFiles.push({ name, fileHandle: handle });
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
                this._paintThumbnail(item.querySelector('canvas'), this._proxies.get(id));
            }
            else {
                this._observer.observe(item);
            }
        }
    }
    // -------------------------------------------------------------------------
    // Fallback (input) navigation
    // -------------------------------------------------------------------------
    _scanFallbackLevel() {
        // Path segments below the root are the breadcrumb entries after index 0.
        const pathSegs = this._breadcrumb.slice(1).map(e => e.name);
        const subfolderNames = new Set();
        const imageEntries = [];
        for (const [id, { name, file }] of this._fallbackFiles) {
            const parts = id.split('/');
            if (parts.length <= pathSegs.length)
                continue;
            if (!pathSegs.every((seg, i) => parts[i] === seg))
                continue;
            if (parts.length === pathSegs.length + 1) {
                imageEntries.push({ id, name, file });
            }
            else {
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
                this._paintThumbnail(item.querySelector('canvas'), this._proxies.get(id));
            }
            else {
                this._observer.observe(item);
            }
        }
    }
    // -------------------------------------------------------------------------
    // Grid item DOM
    // -------------------------------------------------------------------------
    _makeFolderItem(name, onClick) {
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
    _makeItem(id, name) {
        const div = document.createElement('div');
        div.className = 'image-thumb';
        div.dataset.id = id;
        div.title = name;
        // Placeholder canvas — grey fill until proxy is decoded.
        const canvas = document.createElement('canvas');
        canvas.width = THUMB_MAX_PX;
        canvas.height = THUMB_MAX_PX;
        const pCtx = canvas.getContext('2d');
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
        div.addEventListener('dragstart', (e) => {
            // If the dragged item is already part of a multi-selection, carry all
            // selected IDs. Otherwise drag only this one.
            const dragIds = (this._selectedIds.has(id) && this._selectedIds.size > 1)
                ? [...this._selectedIds]
                : [id];
            e.dataTransfer.setData('text/plain', JSON.stringify(dragIds));
            e.dataTransfer.effectAllowed = 'copy';
            // Refresh proxy cache for all dragged images.
            this.onPhotoSelect(this._selectedIds);
        });
        return div;
    }
    _paintThumbnail(canvas, proxy) {
        if (!canvas)
            return;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#3a3a3a';
        ctx.fillRect(0, 0, THUMB_MAX_PX, THUMB_MAX_PX);
        const scale = Math.max(THUMB_MAX_PX / proxy.width, THUMB_MAX_PX / proxy.height);
        const tw = Math.round(proxy.width * scale);
        const th = Math.round(proxy.height * scale);
        const ox = Math.floor((THUMB_MAX_PX - tw) / 2);
        const oy = Math.floor((THUMB_MAX_PX - th) / 2);
        ctx.drawImage(proxy, ox, oy, tw, th);
    }
    _handleClick(e, id) {
        const idx = this._ids.indexOf(id);
        if (idx === -1)
            return;
        if (e.ctrlKey || e.metaKey) {
            // Toggle this item.
            if (this._selectedIds.has(id)) {
                this._selectedIds.delete(id);
            }
            else {
                this._selectedIds.add(id);
            }
            this._lastClickedIdx = idx;
        }
        else if (e.shiftKey && this._lastClickedIdx !== null) {
            // Extend selection range from last click to here.
            const lo = Math.min(this._lastClickedIdx, idx);
            const hi = Math.max(this._lastClickedIdx, idx);
            for (let i = lo; i <= hi; i++)
                this._selectedIds.add(this._ids[i]);
            // Don't update _lastClickedIdx on shift-click.
        }
        else {
            // Plain click — select only this item.
            this._selectedIds = new Set([id]);
            this._lastClickedIdx = idx;
        }
        this._syncSelectedClass();
        this.onPhotoSelect(this._selectedIds);
    }
    _syncSelectedClass() {
        for (const el of this.gridEl.querySelectorAll('.image-thumb')) {
            el.classList.toggle('selected', this._selectedIds.has(el.dataset.id));
        }
    }
    // -------------------------------------------------------------------------
    // Used-image badge
    // -------------------------------------------------------------------------
    /** Update the green tick badges to reflect which images are currently placed on any spread. */
    updateUsedBadges(usedIds) {
        for (const el of this.gridEl.querySelectorAll('.image-thumb')) {
            const badge = el.querySelector('.image-used-badge');
            if (badge)
                badge.hidden = !usedIds.has(el.dataset.id);
        }
    }
    // -------------------------------------------------------------------------
    // Decode pipeline with semaphore
    // -------------------------------------------------------------------------
    _scheduleLoad(id, item) {
        const run = async () => {
            try {
                await this._loadProxy(id, item);
            }
            finally {
                this._active--;
                this._queue.shift()?.();
            }
        };
        if (this._active < DECODE_CONCURRENCY) {
            this._active++;
            run();
        }
        else {
            this._queue.push(() => { this._active++; run(); });
        }
    }
    async _getFile(id) {
        const handle = this._handles.get(id);
        if (handle)
            return handle.getFile();
        return this._fallbackFiles.get(id)?.file ?? null;
    }
    async _loadProxy(id, item) {
        const file = await this._getFile(id);
        if (!file)
            return;
        this._sizes.set(id, file.size);
        // createImageBitmap decodes off the main thread — no frame drops.
        // resizeWidth produces a downsampled proxy; fall back to full size on Safari.
        let proxy;
        try {
            proxy = await createImageBitmap(file, {
                resizeWidth: PROXY_MAX_PX,
                resizeQuality: 'medium',
            });
        }
        catch {
            proxy = await createImageBitmap(file);
        }
        this._proxies.set(id, proxy);
        this._paintThumbnail(item.querySelector('canvas'), proxy);
        this.onProxyReady(id);
    }
    // -------------------------------------------------------------------------
    // Public accessors
    // -------------------------------------------------------------------------
    /** Returns the 800px proxy ImageBitmap, or null if not yet decoded. */
    getProxy(id) {
        return this._proxies.get(id) ?? null;
    }
    /** Returns the known file size in bytes, or null if not yet loaded. */
    getFileSize(id) {
        return this._sizes.get(id) ?? null;
    }
    /** Returns the current sidebar selection. */
    getSelectedIds() {
        return this._selectedIds;
    }
    /** Clears the sidebar selection without firing onPhotoSelect. */
    clearSelection() {
        this._selectedIds = new Set();
        this._lastClickedIdx = null;
        this._syncSelectedClass();
    }
    /**
     * Returns the raw file bytes for `id`, reading from disk on first call.
     * Used for PDF export. May return null if the handle is no longer valid.
     */
    async getBuffer(id) {
        if (this._buffers.has(id))
            return this._buffers.get(id);
        const file = await this._getFile(id);
        if (!file)
            return null;
        const buf = await file.arrayBuffer();
        this._buffers.set(id, buf);
        return buf;
    }
    /**
     * Returns the natural pixel dimensions of the image, decoding it once
     * at full resolution (off main thread) then immediately freeing the bitmap.
     * Cached after first call. Falls back to _buffers for buffer-loaded images.
     */
    async ensureDimensions(id) {
        if (this._dims.has(id))
            return this._dims.get(id);
        const file = await this._getFile(id);
        if (file) {
            const bm = await createImageBitmap(file);
            const dims = [bm.width, bm.height];
            bm.close();
            this._dims.set(id, dims);
            return dims;
        }
        const buf = this._buffers.get(id);
        if (buf) {
            const bm = await createImageBitmap(new Blob([buf]));
            const dims = [bm.width, bm.height];
            bm.close();
            this._dims.set(id, dims);
            return dims;
        }
        return null;
    }
    /** Returns the IDs of all images available for use (folder + buffer-loaded). */
    loadedImageIds() {
        return [...new Set([...this._handles.keys(), ...this._fallbackFiles.keys(), ...this._loadedIds])];
    }
    /**
     * Loads an image from raw bytes, adds it to the sidebar grid, and fires
     * onProxyReady so the canvas renderer caches it immediately.
     * Called by the image-loader modal for each matched file.
     */
    async loadImageFromBuffer(id, buf) {
        this._emptyStateEl?.classList.add('hidden');
        this._buffers.set(id, buf);
        this._sizes.set(id, buf.byteLength);
        this._loadedIds.add(id);
        const blob = new Blob([buf]);
        let proxy;
        try {
            proxy = await createImageBitmap(blob, {
                resizeWidth: PROXY_MAX_PX,
                resizeQuality: 'medium',
            });
        }
        catch {
            proxy = await createImageBitmap(blob);
        }
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
    clearLoadedImages() {
        for (const id of this._loadedIds) {
            if (this._handles.has(id))
                continue; // keep if folder also has it
            this._proxies.delete(id);
            this._buffers.delete(id);
            this._dims.delete(id);
            this._sizes.delete(id);
            this._selectedIds.delete(id);
            const idx = this._ids.indexOf(id);
            if (idx !== -1)
                this._ids.splice(idx, 1);
            this.gridEl.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
        }
        this._loadedIds.clear();
        this._lastClickedIdx = null;
    }
    /**
     * Async generator that yields buffer entries for every image in the sidebar.
     * Files not yet read are fetched on demand. Suitable for PDF export.
     */
    async *buffersForExport() {
        const allIds = new Set([...this._handles.keys(), ...this._fallbackFiles.keys(), ...this._loadedIds]);
        for (const id of allIds) {
            const buf = await this.getBuffer(id);
            if (!buf)
                continue;
            const dims = await this.ensureDimensions(id);
            yield {
                id,
                buffer: buf,
                width_px: dims?.[0] ?? 0,
                height_px: dims?.[1] ?? 0,
            };
        }
    }
}
