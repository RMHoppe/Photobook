// sidebar-photo-info.ts — Right-sidebar panel shown when images are selected
// in the left sidebar.
//
// Single selection: full preview + filename, dimensions, file size.
// Multi-selection:  compact thumbnail grid + "N photos selected" count.

import type { ImageSidebar } from './sidebar-left.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class SidebarPhotoInfoPanel {
  private containerEl: HTMLElement;
  private _sidebar: ImageSidebar;
  /** Dims resolved from full-resolution decodes — local cache for this panel. */
  private _dimsCache = new Map<string, [number, number]>();
  /** ID currently displayed in single-image view (for async re-render guard). */
  private _currentSingleId: string | null = null;

  constructor(containerEl: HTMLElement, sidebar: ImageSidebar) {
    this.containerEl = containerEl;
    this._sidebar    = sidebar;
  }

  /** Show info for the given selection. */
  show(ids: ReadonlySet<string>): void {
    if (ids.size === 0) { this.clear(); return; }
    if (ids.size === 1) {
      this._showSingle([...ids][0]);
    } else {
      this._currentSingleId = null;
      this._showMultiple(ids);
    }
  }

  clear(): void {
    this._currentSingleId = null;
    this.containerEl.innerHTML = '<p class="no-selection">Select a photo to preview it</p>';
  }

  // ---------------------------------------------------------------------------
  // Single-image view
  // ---------------------------------------------------------------------------

  private _showSingle(id: string): void {
    this._currentSingleId = id;
    const proxy    = this._sidebar.getProxy(id);
    const fileSize = this._sidebar.getFileSize(id);
    const dims     = this._dimsCache.get(id) ?? null;

    this.containerEl.innerHTML = '';

    // -- Preview --
    const previewWrap = document.createElement('div');
    previewWrap.className = 'pi-preview-wrap';

    if (proxy) {
      const canvas = document.createElement('canvas');
      canvas.className = 'pi-preview-canvas';
      canvas.width  = proxy.width;
      canvas.height = proxy.height;
      canvas.getContext('2d')!.drawImage(proxy, 0, 0);
      previewWrap.appendChild(canvas);
    } else {
      const ph = document.createElement('div');
      ph.className = 'pi-preview-placeholder';
      ph.textContent = '…';
      previewWrap.appendChild(ph);
    }

    this.containerEl.appendChild(previewWrap);

    // -- Metadata --
    const meta = document.createElement('div');
    meta.className = 'pi-meta';

    const rows: [string, string][] = [['Name', id]];

    if (dims) {
      rows.push(['Dimensions', `${dims[0]} × ${dims[1]} px`]);
    } else {
      rows.push(['Dimensions', 'loading…']);
      // Kick off resolution in the background.
      this._sidebar.ensureDimensions(id).then(resolved => {
        if (!resolved || this._currentSingleId !== id) return;
        this._dimsCache.set(id, resolved);
        this._showSingle(id); // re-render with real dims
      });
    }

    if (fileSize !== null) rows.push(['Size', formatBytes(fileSize)]);

    meta.innerHTML = rows.map(([k, v]) =>
      `<div class="pi-meta-row">` +
        `<span class="pi-meta-key">${k}</span>` +
        `<span class="pi-meta-val" title="${v}">${v}</span>` +
      `</div>`
    ).join('');

    this.containerEl.appendChild(meta);
  }

  // ---------------------------------------------------------------------------
  // Multi-image view
  // ---------------------------------------------------------------------------

  private _showMultiple(ids: ReadonlySet<string>): void {
    this.containerEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'pi-multi-header';
    header.textContent = `${ids.size} photos selected`;
    this.containerEl.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'pi-multi-grid';

    for (const id of ids) {
      const cell = document.createElement('div');
      cell.className = 'pi-multi-cell';
      cell.title = id;

      const proxy = this._sidebar.getProxy(id);
      if (proxy) {
        const canvas = document.createElement('canvas');
        canvas.width  = proxy.width;
        canvas.height = proxy.height;
        canvas.getContext('2d')!.drawImage(proxy, 0, 0);
        cell.appendChild(canvas);
      } else {
        cell.textContent = '…';
      }

      grid.appendChild(cell);
    }

    this.containerEl.appendChild(grid);
  }
}
