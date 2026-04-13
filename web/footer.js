// footer.js — Spread switcher with thumbnail strip.

export class Footer {
  constructor(thumbsEl, prevBtn, nextBtn, onSwitch) {
    this.thumbsEl = thumbsEl;
    this.prevBtn  = prevBtn;
    this.nextBtn  = nextBtn;
    this.onSwitch = onSwitch; // callback(spreadIndex)
    this.currentIdx = 0;

    prevBtn.addEventListener('click', () => this.onSwitch(this.currentIdx - 1));
    nextBtn.addEventListener('click', () => this.onSwitch(this.currentIdx + 1));
  }

  update(editor, renderer) {
    const count = editor.get_spread_count();
    this.currentIdx = editor.get_current_spread_index();
    const spreadsInfo = JSON.parse(editor.get_spreads_info());

    // Use current spread info for aspect ratio (cover difference is ignored per spec).
    const spreadInfo  = JSON.parse(editor.get_current_spread_info());
    const spreadAspect = spreadInfo.width_mm / spreadInfo.height_mm;
    const thumbH = 160; // canvas bitmap height; CSS displays at 80px (2×)
    const thumbW = Math.round(thumbH * spreadAspect);
    const cssW   = Math.round(thumbW / 2) + 'px';

    // Rebuild thumbnails
    this.thumbsEl.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const spread = spreadsInfo[i];
      const div = document.createElement('div');
      div.className = 'spread-thumb' + (i === this.currentIdx ? ' active' : '');
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

      const idx = i;
      div.addEventListener('click', () => this.onSwitch(idx));
      this.thumbsEl.appendChild(div);
    }

    // Draw thumbnails — set_current_spread clears the Wasm selection, so save and restore it.
    const savedSel  = editor.get_selected();
    const savedSprd = editor.get_current_spread_index();
    for (let i = 0; i < count; i++) {
      this.drawThumbnail(i, editor, renderer);
    }
    editor.set_current_spread(savedSprd);
    if (savedSel !== 0xFFFFFFFF) editor.select_node(savedSel);

    this.prevBtn.disabled = this.currentIdx <= 0;
    this.nextBtn.disabled = this.currentIdx >= count - 1;
  }

  _spreadLabel(spread, idx, total) {
    if (spread.kind === 'cover') return 'Cover';
    return `Spread ${idx}`;
  }

  /** Draw a mini thumbnail for spread i using a simplified layout render. */
  drawThumbnail(spreadIdx, editor, rendererOrCache) {
    // Accept either a CanvasRenderer instance or a plain imageCache Map.
    const renderer   = (rendererOrCache instanceof Map) ? null : rendererOrCache;
    const imageCache = renderer ? renderer.imageCache : (rendererOrCache ?? new Map());
    const el = this.thumbsEl.children[spreadIdx];
    if (!el) return;
    const canvas = el.querySelector('canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;

    // Switch to this spread to obtain its render list and node backgrounds.
    editor.set_current_spread(spreadIdx);
    const renderList = JSON.parse(editor.get_render_list(W, H));

    // White base + node backgrounds.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    const nodeBgs = JSON.parse(editor.get_node_backgrounds(W, H));
    for (const bg of nodeBgs) {
      ctx.fillStyle = bg.color;
      ctx.fillRect(bg.rect.x, bg.rect.y, bg.rect.w, bg.rect.h);
    }

    for (const frame of renderList) {
      const { x, y, w, h } = frame.rect;
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      if (frame.image_id && imageCache.has(frame.image_id)) {
        const img = imageCache.get(frame.image_id);
        if (renderer?._drawImageCover) {
          renderer._drawImageCover(ctx, img, x, y, w, h,
            frame.pan_x, frame.pan_y, frame.object_fit, frame.scale, frame.rotation_deg);
        } else {
          ctx.drawImage(img, x, y, w, h);
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

    // Fold guide
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
