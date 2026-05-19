// footer.ts — Spread switcher with thumbnail strip.

import type { PhotobookEditor } from './pkg/photobook_core.js';
import type { SpreadSummary } from './types.js';
import { getSpreadInfo, getSpreadsInfo, getThumbnailData, getDirtySpreadIndices } from './wasm-bridge.js';
import type { CanvasRenderer } from './canvas.js';

export class Footer {
  private thumbsEl: HTMLElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private addSpreadBtn: HTMLButtonElement;
  private removeSpreadBtn: HTMLButtonElement;
  private spreadCountLabel: HTMLElement;
  private onSwitch: (idx: number) => void;
  private onReorder: ((from: number, to: number) => void) | null;
  private _thumbDivs: HTMLElement[] = [];
  private _renderedCount = -1;
  private _indicator: HTMLElement;
  private _dragSourceIdx = -1;
  currentIdx = 0;

  constructor(
    thumbsEl: HTMLElement,
    prevBtn: HTMLButtonElement,
    nextBtn: HTMLButtonElement,
    addSpreadBtn: HTMLButtonElement,
    removeSpreadBtn: HTMLButtonElement,
    spreadCountLabel: HTMLElement,
    onSwitch: (idx: number) => void,
    onReorder?: (from: number, to: number) => void,
  ) {
    this.thumbsEl        = thumbsEl;
    this.prevBtn         = prevBtn;
    this.nextBtn         = nextBtn;
    this.addSpreadBtn    = addSpreadBtn;
    this.removeSpreadBtn = removeSpreadBtn;
    this.spreadCountLabel = spreadCountLabel;
    this.onSwitch  = onSwitch;
    this.onReorder = onReorder ?? null;

    prevBtn.addEventListener('click', () => this.onSwitch(this.currentIdx - 1));
    nextBtn.addEventListener('click', () => this.onSwitch(this.currentIdx + 1));

    this._indicator = document.createElement('div');
    this._indicator.className = 'spread-drop-indicator';
    this._indicator.hidden = true;

    thumbsEl.addEventListener('dragover', (e) => {
      if (this._dragSourceIdx < 0) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      this._showIndicator(this._hitTestGap(e.clientX));
    });

    thumbsEl.addEventListener('dragleave', (e) => {
      if (!thumbsEl.contains(e.relatedTarget as Node | null)) {
        this._indicator.hidden = true;
      }
    });

    thumbsEl.addEventListener('drop', (e) => {
      e.preventDefault();
      if (this._dragSourceIdx < 0) return;
      const from = this._dragSourceIdx;
      const gapIdx = this._hitTestGap(e.clientX);
      const to = from < gapIdx ? gapIdx - 1 : gapIdx;
      this._indicator.hidden = true;
      this._dragSourceIdx = -1;
      if (from !== to && to > 0 && this.onReorder) this.onReorder(from, to);
    });
  }

  update(editor: PhotobookEditor, renderer: CanvasRenderer): void {
    const count = editor.get_spread_count();
    this.currentIdx = editor.get_current_spread_index();
    const spreadsInfo = getSpreadsInfo(editor);

    const spreadInfo   = getSpreadInfo(editor);
    const spreadAspect = spreadInfo.width_mm / spreadInfo.height_mm;
    const thumbH = 160;
    const thumbW = Math.round(thumbH * spreadAspect);
    const cssW   = Math.round(thumbW / 2) + 'px';

    // Rebuild DOM only when the spread count changes.
    const countChanged = count !== this._renderedCount;
    if (countChanged) {
      this.thumbsEl.innerHTML = '';
      this._thumbDivs = [];
      for (let i = 0; i < count; i++) {
        const spread = spreadsInfo[i];
        const div = document.createElement('div');
        div.className = 'spread-thumb';
        div.title = this._spreadLabel(spread, i, count);
        div.style.width = cssW;

        const canvas = document.createElement('canvas');
        canvas.width  = thumbW;
        canvas.height = thumbH;
        div.appendChild(canvas);

        const label = document.createElement('div');
        label.className = 'spread-label';
        label.textContent = this._spreadLabel(spread, i, count);
        div.appendChild(label);

        div.addEventListener('click', () => this.onSwitch(i));

        // Cover (index 0) is not draggable.
        if (i > 0 && this.onReorder) {
          div.draggable = true;
          div.addEventListener('dragstart', (e) => {
            this._dragSourceIdx = i;
            e.dataTransfer!.effectAllowed = 'move';
            e.dataTransfer!.setData('text/plain', String(i));
            div.classList.add('dragging');
          });
          div.addEventListener('dragend', () => {
            div.classList.remove('dragging');
            this._indicator.hidden = true;
            this._dragSourceIdx = -1;
          });
        }

        this.thumbsEl.appendChild(div);
        this._thumbDivs.push(div);
      }
      this._renderedCount = count;
    }

    // Update active class.
    for (let i = 0; i < this._thumbDivs.length; i++) {
      this._thumbDivs[i].classList.toggle('active', i === this.currentIdx);
    }

    // When the DOM was rebuilt all canvases are blank — re-render every spread.
    // Otherwise render only the ones the editor flagged dirty.
    if (countChanged) {
      getDirtySpreadIndices(editor); // drain flags so nothing double-renders later
      for (let i = 0; i < count; i++) {
        this._renderThumbnail(i, editor, renderer);
      }
    } else {
      const dirtyIndices = getDirtySpreadIndices(editor);
      for (const idx of dirtyIndices) {
        this._renderThumbnail(idx, editor, renderer);
      }
    }

    const endpapers = editor.get_endpapers();
    this.prevBtn.disabled         = this.currentIdx <= 0;
    this.nextBtn.disabled         = this.currentIdx >= count - 1;
    this.removeSpreadBtn.disabled = this.currentIdx <= 0 || count <= (endpapers ? 3 : 2);
    this.spreadCountLabel.textContent = `${count} spread${count === 1 ? '' : 's'}`;
  }

  // -------------------------------------------------------------------------
  // Drag helpers
  // -------------------------------------------------------------------------

  /** Returns the gap index (0..count) closest to clientX. */
  private _hitTestGap(clientX: number): number {
    for (let i = 0; i < this._thumbDivs.length; i++) {
      const rect = this._thumbDivs[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return this._thumbDivs.length;
  }

  /** Inserts the drop indicator at gap position g (clamped to never precede the cover). */
  private _showIndicator(gapIdx: number): void {
    const g = Math.max(1, gapIdx);
    if (g >= this._thumbDivs.length) {
      this.thumbsEl.appendChild(this._indicator);
    } else {
      this.thumbsEl.insertBefore(this._indicator, this._thumbDivs[g]);
    }
    this._indicator.hidden = false;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private _spreadLabel(spread: SpreadSummary, _idx: number, _total: number): string {
    if (spread.kind === 'cover') return 'Cover';
    return `Spread ${_idx}`;
  }

  private _renderThumbnail(spreadIdx: number, editor: PhotobookEditor, renderer: CanvasRenderer): void {
    const el = this._thumbDivs[spreadIdx];
    if (!el) return;
    const canvas = el.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    this.drawThumbnail(spreadIdx, editor, renderer);
  }

  drawThumbnail(
    spreadIdx: number,
    editor: PhotobookEditor,
    rendererOrCache: CanvasRenderer | Map<string, HTMLImageElement | ImageBitmap>,
  ): void {
    const renderer   = (rendererOrCache instanceof Map) ? null : rendererOrCache;
    const imageCache = renderer ? renderer.imageCache : (rendererOrCache as Map<string, HTMLImageElement | ImageBitmap>);
    const el = this._thumbDivs[spreadIdx] ?? this.thumbsEl.children[spreadIdx] as HTMLElement | undefined;
    if (!el) return;
    const canvas = el.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;

    // For endpaper spreads, resolve the layout against half the thumbnail width.
    const spreadsInfo = getSpreadsInfo(editor);
    const endpaperSide = spreadsInfo[spreadIdx]?.endpaper_side ?? null;
    const layoutW    = endpaperSide ? Math.floor(W / 2) : W;
    const layoutOffX = endpaperSide === 'left' ? W - layoutW : 0;

    // Pure read — does not mutate current_spread or selection.
    const renderList = getThumbnailData(editor, spreadIdx, layoutW, H);

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);

    for (const frame of renderList) {
      const x = frame.rect.x + layoutOffX;
      const { y, w, h } = frame.rect;
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      if (frame.image_id && imageCache.has(frame.image_id)) {
        const img = imageCache.get(frame.image_id)!;
        if (renderer?._drawImageCover) {
          renderer._drawImageCover(ctx, img, x, y, w, h,
            frame.pan_x, frame.pan_y, frame.object_fit, frame.scale, frame.rotation_deg);
        } else {
          ctx.drawImage(img as CanvasImageSource, x, y, w, h);
        }
      } else {
        ctx.fillStyle = 'rgba(70, 70, 70, 0.45)';
        ctx.fillRect(x, y, w, h);
      }
      ctx.restore();
      ctx.strokeStyle = '#aaa';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x, y, w, h);
    }

    // Non-printable overlay on the thumbnail.
    if (endpaperSide) {
      const npX = endpaperSide === 'left' ? 0 : W - layoutW;
      ctx.fillStyle = 'rgba(80, 80, 80, 0.35)';
      ctx.fillRect(npX, 0, layoutW, H);
    }

    ctx.strokeStyle = 'rgba(100,100,100,0.4)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
