// footer.ts — Spread switcher with thumbnail strip.
import { getSpreadInfo, getSpreadsInfo, getThumbnailData, getDirtySpreadIndices } from './wasm-bridge.js';
export class Footer {
    thumbsEl;
    prevBtn;
    nextBtn;
    onSwitch;
    _thumbDivs = [];
    _renderedCount = -1;
    currentIdx = 0;
    constructor(thumbsEl, prevBtn, nextBtn, onSwitch) {
        this.thumbsEl = thumbsEl;
        this.prevBtn = prevBtn;
        this.nextBtn = nextBtn;
        this.onSwitch = onSwitch;
        prevBtn.addEventListener('click', () => this.onSwitch(this.currentIdx - 1));
        nextBtn.addEventListener('click', () => this.onSwitch(this.currentIdx + 1));
    }
    update(editor, renderer) {
        const count = editor.get_spread_count();
        this.currentIdx = editor.get_current_spread_index();
        const spreadsInfo = getSpreadsInfo(editor);
        const spreadInfo = getSpreadInfo(editor);
        const spreadAspect = spreadInfo.width_mm / spreadInfo.height_mm;
        const thumbH = 160;
        const thumbW = Math.round(thumbH * spreadAspect);
        const cssW = Math.round(thumbW / 2) + 'px';
        // Rebuild DOM only when the spread count changes.
        if (count !== this._renderedCount) {
            this.thumbsEl.innerHTML = '';
            this._thumbDivs = [];
            for (let i = 0; i < count; i++) {
                const spread = spreadsInfo[i];
                const div = document.createElement('div');
                div.className = 'spread-thumb';
                div.title = this._spreadLabel(spread, i, count);
                div.style.width = cssW;
                const canvas = document.createElement('canvas');
                canvas.width = thumbW;
                canvas.height = thumbH;
                div.appendChild(canvas);
                const label = document.createElement('div');
                label.className = 'spread-label';
                label.textContent = this._spreadLabel(spread, i, count);
                div.appendChild(label);
                const idx = i;
                div.addEventListener('click', () => this.onSwitch(idx));
                this.thumbsEl.appendChild(div);
                this._thumbDivs.push(div);
            }
            this._renderedCount = count;
        }
        // Update active class.
        for (let i = 0; i < this._thumbDivs.length; i++) {
            this._thumbDivs[i].classList.toggle('active', i === this.currentIdx);
        }
        // Render only dirty thumbnails.
        const dirtyIndices = getDirtySpreadIndices(editor);
        for (const idx of dirtyIndices) {
            this._renderThumbnail(idx, editor, renderer);
        }
        this.prevBtn.disabled = this.currentIdx <= 0;
        this.nextBtn.disabled = this.currentIdx >= count - 1;
    }
    _spreadLabel(spread, _idx, _total) {
        if (spread.kind === 'cover')
            return 'Cover';
        return `Spread ${_idx}`;
    }
    _renderThumbnail(spreadIdx, editor, renderer) {
        const el = this._thumbDivs[spreadIdx];
        if (!el)
            return;
        const canvas = el.querySelector('canvas');
        if (!canvas)
            return;
        this.drawThumbnail(spreadIdx, editor, renderer);
    }
    drawThumbnail(spreadIdx, editor, rendererOrCache) {
        const renderer = (rendererOrCache instanceof Map) ? null : rendererOrCache;
        const imageCache = renderer ? renderer.imageCache : rendererOrCache;
        const el = this._thumbDivs[spreadIdx] ?? this.thumbsEl.children[spreadIdx];
        if (!el)
            return;
        const canvas = el.querySelector('canvas');
        if (!canvas)
            return;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        // Pure read — does not mutate current_spread or selection.
        const renderList = getThumbnailData(editor, spreadIdx, W, H);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, W, H);
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
                    renderer._drawImageCover(ctx, img, x, y, w, h, frame.pan_x, frame.pan_y, frame.object_fit, frame.scale, frame.rotation_deg);
                }
                else {
                    ctx.drawImage(img, x, y, w, h);
                }
            }
            else {
                ctx.fillStyle = 'rgba(70, 70, 70, 0.45)';
                ctx.fillRect(x, y, w, h);
            }
            ctx.restore();
            ctx.strokeStyle = '#aaa';
            ctx.lineWidth = 0.5;
            ctx.strokeRect(x, y, w, h);
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
