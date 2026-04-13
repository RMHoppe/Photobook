// sidebar-left.js — Image browser using the File System Access API.

import { PROXY_MAX_PX, PROXY_QUALITY } from './constants.js';

export class ImageSidebar {
  constructor(gridEl, onSelect) {
    this.gridEl = gridEl;
    this.onSelect = onSelect; // callback(imageId)
    this.selectedId = null;
    this.imageBuffers = new Map(); // id -> ArrayBuffer (full resolution)
    this.imageElements = new Map(); // id -> HTMLImageElement (full resolution)
    this.imageProxies = new Map();  // id -> HTMLImageElement (downsampled, for canvas)
  }

  async openFolder() {
    if (!('showDirectoryPicker' in window)) {
      alert('File System Access API not supported in this browser. Use Chrome or Edge.');
      return;
    }

    let dirHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    } catch (e) {
      return; // user cancelled
    }

    this.gridEl.innerHTML = '';
    this.imageBuffers.clear();
    this.imageElements.clear();
    this.selectedId = null;

    const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];

    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind !== 'file') continue;
      const lower = name.toLowerCase();
      if (!IMAGE_EXTS.some(ext => lower.endsWith(ext))) continue;

      const file = await handle.getFile();
      const buffer = await file.arrayBuffer();
      const id = name; // use filename as id

      this.imageBuffers.set(id, buffer);

      const url = URL.createObjectURL(new Blob([buffer]));
      const img = new Image();
      img.src = url;
      img.className = 'image-thumb';
      img.title = name;
      img.dataset.id = id;

      img.addEventListener('load', () => {
        this.imageElements.set(id, img);
        this._makeProxy(id, img);
      });

      img.addEventListener('click', () => {
        this._selectImage(id, img);
      });

      img.draggable = true;
      img.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'copy';
        this._selectImage(id, img);
      });

      this.gridEl.appendChild(img);
    }
  }

  _selectImage(id, imgEl) {
    // Deselect previous
    if (this.selectedId) {
      const prev = this.gridEl.querySelector(`[data-id="${CSS.escape(this.selectedId)}"]`);
      if (prev) prev.classList.remove('selected');
    }
    this.selectedId = id;
    imgEl.classList.add('selected');
    this.onSelect(id, this.imageElements.get(id));
  }

  /** Create and store a downsampled proxy image for fast canvas rendering. */
  _makeProxy(id, img, maxPx = PROXY_MAX_PX) {
    const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const proxy = new Image();
    proxy.src = canvas.toDataURL('image/jpeg', PROXY_QUALITY);
    proxy.naturalWidthOverride = img.naturalWidth;
    proxy.naturalHeightOverride = img.naturalHeight;
    this.imageProxies.set(id, proxy);
  }

  /** Return the proxy (downsampled) image for canvas rendering, or null. */
  getProxy(id) {
    return this.imageProxies.get(id) || this.imageElements.get(id) || null;
  }

  getBuffer(id) {
    return this.imageBuffers.get(id) || null;
  }

  getImage(id) {
    return this.imageElements.get(id) || null;
  }

  getAllBuffers() {
    const result = [];
    for (const [id, buf] of this.imageBuffers) {
      const img = this.imageElements.get(id);
      result.push({
        id,
        buffer: buf,
        width_px: img ? img.naturalWidth : 0,
        height_px: img ? img.naturalHeight : 0,
      });
    }
    return result;
  }
}
