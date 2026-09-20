// sidebar-frame-image.ts — Bottom-of-right-sidebar panel with metadata for
// the image placed in the single selected frame: file name, natural pixel
// size, capture time, GPS location (when present), effective print
// resolution, and the current placement (scale / rotation).

import type { FrameImageInfo } from './types.js';
import type { ImageSidebar } from './sidebar-left.js';
import type { ExifInfo } from './exif.js';

function formatTimestamp(d: Date): string {
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatCoord(v: number, pos: string, neg: string): string {
  return `${Math.abs(v).toFixed(5)}° ${v < 0 ? neg : pos}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

export class FrameImagePanel {
  private containerEl: HTMLElement;
  private _sidebar: ImageSidebar;
  /** Image id currently displayed (guards async re-render after dims resolve). */
  private _currentId: string | null = null;
  /** Last info rendered — replayed when EXIF resolves asynchronously. */
  private _lastInfo: FrameImageInfo | null = null;
  private _exifCache = new Map<string, ExifInfo>();

  constructor(containerEl: HTMLElement, sidebar: ImageSidebar) {
    this.containerEl = containerEl;
    this._sidebar    = sidebar;
  }

  /**
   * Render metadata for `info`. `onDimsResolved` is invoked once the natural
   * size has been decoded so the caller can register it with the editor and
   * refresh (which re-enters `show` with `effective_dpi` populated).
   */
  show(info: FrameImageInfo, onDimsResolved: (id: string, dims: [number, number]) => void): void {
    this._currentId = info.image_id;
    this._lastInfo  = info;
    this.containerEl.hidden = false;

    const rows: [string, string, string?][] = [['Name', info.image_id]];

    if (info.image_w_px !== null && info.image_h_px !== null) {
      rows.push(['Pixels', `${info.image_w_px} × ${info.image_h_px} px`]);
    } else {
      rows.push(['Pixels', 'loading…']);
      this._sidebar.ensureDimensions(info.image_id).then(dims => {
        if (!dims || this._currentId !== info.image_id) return;
        onDimsResolved(info.image_id, dims);
      });
    }

    const exif = this._exifCache.get(info.image_id);
    if (exif) {
      if (exif.timestamp) {
        rows.push([exif.timestampIsFileTime ? 'Modified' : 'Taken', formatTimestamp(exif.timestamp)]);
      }
      if (exif.location) {
        rows.push(['Location', `${formatCoord(exif.location.lat, 'N', 'S')}, ${formatCoord(exif.location.lon, 'E', 'W')}`, 'fi-location']);
      }
    } else {
      rows.push(['Taken', 'loading…']);
      this._sidebar.ensureExif(info.image_id).then(resolved => {
        this._exifCache.set(info.image_id, resolved);
        if (this._currentId === info.image_id && this._lastInfo) this.show(this._lastInfo, onDimsResolved);
      });
    }

    if (info.effective_dpi !== null) {
      const low = info.effective_dpi < info.print_dpi;
      rows.push([
        'Print res.',
        `${info.effective_dpi} dpi` + (low ? ` (below ${Math.round(info.print_dpi)})` : ''),
        low ? 'fi-low' : 'fi-ok',
      ]);
    } else {
      rows.push(['Print res.', '—']);
    }

    const placement: string[] = [];
    if (Math.abs(info.scale - 1) > 1e-3)   placement.push(`${Math.round(info.scale * 100)} %`);
    if (Math.abs(info.rotation_deg) > 1e-3) placement.push(`${info.rotation_deg.toFixed(1)}°`);
    if (placement.length) rows.push(['Placement', placement.join(', ')]);

    this.containerEl.innerHTML =
      `<div class="fi-header">Image</div>` +
      `<div class="pi-meta">` +
      rows.map(([k, v, cls]) =>
        `<div class="pi-meta-row">` +
          `<span class="pi-meta-key">${k}</span>` +
          `<span class="pi-meta-val${cls ? ' ' + cls : ''}" title="${esc(v)}">${esc(v)}</span>` +
        `</div>`
      ).join('') +
      `</div>`;

    // Location opens the spot on OpenStreetMap in a new tab.
    const loc = exif?.location;
    const locEl = this.containerEl.querySelector<HTMLElement>('.fi-location');
    if (loc && locEl) {
      const a = document.createElement('a');
      a.href = `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lon}#map=15/${loc.lat}/${loc.lon}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = locEl.textContent;
      a.title = 'Open in OpenStreetMap';
      locEl.replaceChildren(a);
    }
  }

  hide(): void {
    this._currentId = null;
    this._lastInfo  = null;
    this.containerEl.hidden = true;
    this.containerEl.innerHTML = '';
  }
}
