// sidebar-left.ts — Image browser using the File System Access API.
//
// Loading strategy:
//   1. Folder scan stores FileSystemFileHandle refs only — no file bytes read upfront.
//   2. IntersectionObserver triggers decode only for visible grid items.
//   3. A semaphore caps concurrent createImageBitmap calls (DECODE_CONCURRENCY).
//   4. createImageBitmap runs off the main thread; no jank during proxy creation.
//   5. ArrayBuffers are read lazily: only when an image is exported or assigned.
import { PROXY_MAX_PX, THUMB_MAX_PX, DECODE_CONCURRENCY } from './constants.js';
export class ImageSidebar {
    gridEl;
    onSelect;
    onProxyReady;
    selectedId = null;
    _handles = new Map();
    _proxies = new Map(); // 800px, for canvas rendering
    _buffers = new Map(); // lazy, for PDF export
    _dims = new Map(); // natural dims, lazy
    // Semaphore
    _active = 0;
    _queue = [];
    // IntersectionObserver — fires when a grid item enters the scroll viewport
    _observer;
    constructor(gridEl, onSelect, onProxyReady) {
        this.gridEl = gridEl;
        this.onSelect = onSelect;
        this.onProxyReady = onProxyReady ?? (() => { });
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
        if (!('showDirectoryPicker' in window)) {
            alert('File System Access API not supported in this browser. Use Chrome or Edge.');
            return;
        }
        let dirHandle;
        try {
            dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        }
        catch {
            return; // user cancelled
        }
        // Tear down previous state.
        this._observer.disconnect();
        this.gridEl.innerHTML = '';
        this.selectedId = null;
        this._handles.clear();
        this._proxies.clear();
        this._buffers.clear();
        this._dims.clear();
        const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];
        for await (const [name, handle] of dirHandle) {
            if (handle.kind !== 'file')
                continue;
            if (!IMAGE_EXTS.some(ext => name.toLowerCase().endsWith(ext)))
                continue;
            const id = name;
            this._handles.set(id, handle);
            const item = this._makeItem(id, name);
            this.gridEl.appendChild(item);
            this._observer.observe(item);
        }
    }
    // -------------------------------------------------------------------------
    // Grid item DOM
    // -------------------------------------------------------------------------
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
        div.addEventListener('click', () => this._selectItem(id, div));
        div.draggable = true;
        div.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', id);
            e.dataTransfer.effectAllowed = 'copy';
            this._selectItem(id, div);
        });
        return div;
    }
    _selectItem(id, el) {
        if (this.selectedId) {
            const prev = this.gridEl.querySelector(`[data-id="${CSS.escape(this.selectedId)}"]`);
            prev?.classList.remove('selected');
        }
        this.selectedId = id;
        el.classList.add('selected');
        this.onSelect(id);
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
    async _loadProxy(id, item) {
        const handle = this._handles.get(id);
        if (!handle)
            return;
        const file = await handle.getFile();
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
        // Paint thumbnail into the grid canvas, letterboxed into a square.
        const canvas = item.querySelector('canvas');
        if (canvas) {
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
        this.onProxyReady(id);
    }
    // -------------------------------------------------------------------------
    // Public accessors
    // -------------------------------------------------------------------------
    /** Returns the 800px proxy ImageBitmap, or null if not yet decoded. */
    getProxy(id) {
        return this._proxies.get(id) ?? null;
    }
    /**
     * Returns the raw file bytes for `id`, reading from disk on first call.
     * Used for PDF export. May return null if the handle is no longer valid.
     */
    async getBuffer(id) {
        if (this._buffers.has(id))
            return this._buffers.get(id);
        const handle = this._handles.get(id);
        if (!handle)
            return null;
        const file = await handle.getFile();
        const buf = await file.arrayBuffer();
        this._buffers.set(id, buf);
        return buf;
    }
    /**
     * Returns the natural pixel dimensions of the image, decoding it once
     * at full resolution (off main thread) then immediately freeing the bitmap.
     * Cached after first call.
     */
    async ensureDimensions(id) {
        if (this._dims.has(id))
            return this._dims.get(id);
        const handle = this._handles.get(id);
        if (!handle)
            return null;
        const file = await handle.getFile();
        const bm = await createImageBitmap(file);
        const dims = [bm.width, bm.height];
        bm.close(); // free the full-resolution bitmap immediately
        this._dims.set(id, dims);
        return dims;
    }
    /**
     * Async generator that yields buffer entries for every image in the folder.
     * Files not yet read are fetched on demand. Suitable for PDF export.
     */
    async *buffersForExport() {
        for (const id of this._handles.keys()) {
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
