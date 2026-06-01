// canvas.ts — All 2D rendering for the double-page spread canvas.
// Receives data from the Wasm editor and draws using Canvas 2D API.
import { PAD, RULER_SIZE, NULL_ID, CANVAS_IMAGE_BUDGET_BYTES } from './constants.js';
import { LruCache, rasterBytes } from './lru.js';
import { getSpreadInfo, getLowDpiFrames, computeImageCover, getTextElements, getResolvedSpreadDelta, getXJunctions, getSpreadMargin, } from './wasm-bridge.js';
import { drawRulers } from './canvas-draw-rulers.js';
// ---------------------------------------------------------------------------
// Geometry cache — avoids repeated JSON parsing on unchanged data
// ---------------------------------------------------------------------------
class SpreadGeometryCache {
    _frames = [];
    _frameIndex = new Map();
    dividers = [];
    twinHandles = [];
    applyDelta(delta) {
        if (delta.full !== null) {
            const full = delta.full;
            this._frames = full.frames;
            this._frameIndex.clear();
            for (let i = 0; i < full.frames.length; i++) {
                this._frameIndex.set(full.frames[i].id, i);
            }
            this.dividers = full.dividers;
            this.twinHandles = full.twin_handles;
        }
        else if (delta.updated_frames !== null) {
            for (const frame of delta.updated_frames) {
                const idx = this._frameIndex.get(frame.id);
                if (idx !== undefined)
                    this._frames[idx] = frame;
            }
        }
    }
    getFrames() { return this._frames; }
    getFrameById(id) {
        const idx = this._frameIndex.get(id);
        return idx !== undefined ? this._frames[idx] : undefined;
    }
}
const BLEED_COLOR = 'rgba(220, 50, 50, 0.35)';
const SAFE_COLOR = 'rgba(0, 150, 255, 0.65)';
const FOLD_COLOR = 'rgba(0, 180, 255, 0.85)';
const SPINE_COLOR = 'rgba(255, 160, 0, 0.85)';
const FRAME_EMPTY_COLOR = '#ccc';
const DIVIDER_HOVER_COLOR = '#aaa';
const SELECTED_COLOR = '#4a90e2';
const TEXT_HANDLE_RADIUS = 6;
const TEXT_SELECTED_COLOR = '#34c9a0';
const ROTATION_HANDLE_DIST = 22; // px from top-center to rotation handle
export class CanvasRenderer {
    canvas;
    ctx;
    dpr;
    imageCache = new LruCache(CANVAS_IMAGE_BUDGET_BYTES, rasterBytes);
    hoveredDivider = null;
    hoveredEdge = null;
    hoveredTwinHandle = null;
    /** True when the current segment selection was made by clicking a twin handle (not the full-chain divider). */
    twinSegmentSelected = false;
    hoveredLeaf;
    _hatchPattern = null;
    _placeholderImg = null;
    showBleed = true;
    showSafeZone = true;
    showRulers = true;
    previewMode = false;
    zoom = 1.0;
    panX = 0;
    panY = 0;
    cssW = 0;
    cssH = 0;
    _dpiBadges = [];
    /** Hit-test info for all text elements from the last draw call. */
    _textHits = [];
    /** Twin handles from the last draw call, used for hit-testing in idleMode. */
    _twinHandles = [];
    /** X-junctions from the last draw call, used for hit-testing. */
    _xJunctions = [];
    /** Bleed in CSS px as of the last draw — needed for junction hit-testing. */
    _bleedPx = 0;
    /** Spread margin in CSS px as of the last draw — needed for junction hit-testing. */
    _spreadMarginPx = { top: 0, right: 0, bottom: 0, left: 0 };
    /** Currently hovered X-junction handle, or null. */
    hoveredXJunction = null;
    /** ID of the currently selected text element (null = none). */
    selectedTextIds = new Set();
    /** ID of the text element currently being edited inline (null = none). */
    editingTextId = null;
    /** Layout rect for the current spread (printable half only for endpaper spreads). */
    lastLayoutRect = { x: 0, y: 0, w: 0, h: 0 };
    /** Canvas X of the full spread's left edge (differs from lastLayoutRect.x on left-endpaper spreads). */
    fullSpreadOriginX = 0;
    _geoCache = new SpreadGeometryCache();
    getFrameById(id) {
        return this._geoCache.getFrameById(id);
    }
    /** Bleed extent in CSS px that is currently visible (0 when bleed display is off). */
    get visibleBleedPx() { return this.showBleed ? this._bleedPx : 0; }
    constructor(canvasEl, onPlaceholderLoad) {
        this.canvas = canvasEl;
        this.ctx = canvasEl.getContext('2d');
        this.dpr = window.devicePixelRatio || 1;
        this.hoveredLeaf = NULL_ID;
        const ph = new Image();
        ph.onload = () => { this._placeholderImg = ph; onPlaceholderLoad?.(); };
        ph.src = './placeholder.svg';
    }
    resize(cssW, cssH) {
        this.cssW = cssW;
        this.cssH = cssH;
        this.canvas.width = Math.round(cssW * this.dpr);
        this.canvas.height = Math.round(cssH * this.dpr);
        this.canvas.style.width = cssW + 'px';
        this.canvas.style.height = cssH + 'px';
    }
    cacheImage(id, imgElement) {
        this.imageCache.set(id, imgElement);
    }
    evictImage(id) {
        this.imageCache.delete(id);
    }
    spreadRect(spreadInfo) {
        const rulerOffset = this.showRulers ? RULER_SIZE : 0;
        const availW = this.cssW - rulerOffset - PAD * 2;
        const availH = this.cssH - rulerOffset - PAD * 2;
        const spreadAspect = spreadInfo.width_mm / spreadInfo.height_mm;
        let fitW, fitH;
        if (availW / availH > spreadAspect) {
            fitH = availH;
            fitW = fitH * spreadAspect;
        }
        else {
            fitW = availW;
            fitH = fitW / spreadAspect;
        }
        const scaledW = fitW * this.zoom;
        const scaledH = fitH * this.zoom;
        const naturalCx = rulerOffset + PAD + availW / 2;
        const naturalCy = rulerOffset + PAD + availH / 2;
        return {
            x: naturalCx + this.panX - scaledW / 2,
            y: naturalCy + this.panY - scaledH / 2,
            w: scaledW,
            h: scaledH,
        };
    }
    /** Natural (unpanned) center of the spread in CSS canvas coords. */
    naturalCenter() {
        const rulerOffset = this.showRulers ? RULER_SIZE : 0;
        const availW = this.cssW - rulerOffset - PAD * 2;
        const availH = this.cssH - rulerOffset - PAD * 2;
        return {
            cx: rulerOffset + PAD + availW / 2,
            cy: rulerOffset + PAD + availH / 2,
        };
    }
    draw(editor, overlays = { marqueeRect: null, splitPreview: null, swapOverlay: null, edgeDragPreview: null, imageDropPreview: null }) {
        const { marqueeRect = null } = overlays;
        const { ctx, dpr, cssW, cssH } = this;
        if (!cssW || !cssH)
            return;
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, cssW, cssH);
        if (!this.previewMode) {
            ctx.fillStyle = '#3c3c3c';
            ctx.fillRect(0, 0, cssW, cssH);
        }
        const rulerOffset = this.showRulers ? RULER_SIZE : 0;
        const spreadInfo = getSpreadInfo(editor);
        const spreadRect = this.spreadRect(spreadInfo);
        const mmToPx = spreadRect.w / spreadInfo.width_mm;
        const pageWPx = spreadInfo.page_width_mm * mmToPx;
        const pageHPx = spreadRect.h;
        const spinePx = spreadInfo.spine_mm * mmToPx;
        const bleedPx = editor.get_bleed_mm() * mmToPx;
        const safePx = editor.get_safe_zone_mm() * mmToPx;
        const metrics = {
            mmToPx, pageWPx, pageHPx, spinePx, bleedPx, safePx,
            visibleBleedPx: this.showBleed ? bleedPx : 0,
        };
        // For endpaper spreads, the editable layout occupies only the printable half.
        const endpaperSide = spreadInfo.endpaper_side;
        const layoutOffsetX = endpaperSide === 'left' ? spreadRect.w / 2 : 0;
        const layoutRect = endpaperSide
            ? { x: spreadRect.x + layoutOffsetX, y: spreadRect.y, w: spreadRect.w / 2, h: spreadRect.h }
            : spreadRect;
        this.lastLayoutRect = layoutRect;
        this.fullSpreadOriginX = spreadRect.x;
        const delta = getResolvedSpreadDelta(editor, layoutRect.w, layoutRect.h);
        this._geoCache.applyDelta(delta);
        const renderList = this._geoCache.getFrames();
        const drawList = this.previewMode ? renderList.filter(f => !!f.image_id) : renderList;
        const lowDpiFrames = this.previewMode ? [] : getLowDpiFrames(editor, layoutRect.w, layoutRect.h);
        const lowDpiMap = new Map(lowDpiFrames.map(f => [f.id, f.effective_dpi]));
        const printDpi = editor.get_print_dpi();
        const selectedSegmentId = editor.get_selected_segment();
        this._drawSpreadBackground(ctx, spreadRect, spreadInfo, metrics);
        this._drawFrames(ctx, layoutRect, drawList, lowDpiMap, printDpi, metrics);
        if (!this.previewMode) {
            // Grey overlay on the non-printable page.
            if (endpaperSide) {
                const npX = endpaperSide === 'left' ? spreadRect.x : spreadRect.x + spreadRect.w / 2;
                ctx.save();
                ctx.fillStyle = 'rgba(80, 80, 80, 0.35)';
                ctx.fillRect(npX, spreadRect.y, spreadRect.w / 2, spreadRect.h);
                ctx.fillStyle = 'rgba(200, 200, 200, 0.65)';
                const fontSize = Math.max(10, spreadRect.h * 0.035);
                ctx.font = `${fontSize}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('Not printed', npX + spreadRect.w / 4, spreadRect.y + spreadRect.h / 2);
                ctx.restore();
            }
            this._drawSafeZone(ctx, spreadRect, spreadInfo, metrics);
            this._drawSplitOverlays(ctx, layoutRect, overlays, renderList);
            const spreadMargin = getSpreadMargin(editor);
            const marginPx = {
                top: spreadMargin.top * mmToPx,
                right: spreadMargin.right * mmToPx,
                bottom: spreadMargin.bottom * mmToPx,
                left: spreadMargin.left * mmToPx,
            };
            this._drawDividerLayer(ctx, layoutRect, editor, renderList, selectedSegmentId, bleedPx, marginPx);
            if (marqueeRect) {
                const { x, y, w, h } = marqueeRect;
                const mx = layoutRect.x + x;
                const my = layoutRect.y + y;
                ctx.save();
                ctx.fillStyle = 'rgba(74, 144, 226, 0.10)';
                ctx.fillRect(mx, my, w, h);
                ctx.strokeStyle = SELECTED_COLOR;
                ctx.lineWidth = 1.5;
                ctx.setLineDash([5, 3]);
                ctx.strokeRect(mx, my, w, h);
                ctx.setLineDash([]);
                ctx.restore();
            }
            if (this.showRulers) {
                drawRulers(ctx, cssW, cssH, spreadRect, spreadInfo, metrics.mmToPx, rulerOffset);
            }
        }
        // Text elements — drawn after frames but before transform handles.
        const textElements = getTextElements(editor);
        this._textHits = [];
        for (const el of textElements) {
            this._drawTextElement(ctx, el, spreadRect, metrics.mmToPx, this.selectedTextIds.has(el.id));
        }
        if (!this.previewMode) {
            this._drawGuides(ctx, spreadInfo, spreadRect, pageWPx, pageHPx, spinePx, metrics.mmToPx);
        }
        ctx.restore();
    }
    _drawSpreadBackground(ctx, spreadRect, spreadInfo, metrics) {
        const { pageWPx, spinePx, bleedPx, visibleBleedPx } = metrics;
        ctx.fillStyle = '#fff';
        ctx.fillRect(spreadRect.x - visibleBleedPx, spreadRect.y - visibleBleedPx, spreadRect.w + visibleBleedPx * 2, spreadRect.h + visibleBleedPx * 2);
        if (spreadInfo.left_bg) {
            ctx.fillStyle = spreadInfo.left_bg;
            ctx.fillRect(spreadRect.x - visibleBleedPx, spreadRect.y - visibleBleedPx, pageWPx + visibleBleedPx, spreadRect.h + visibleBleedPx * 2);
        }
        if (spreadInfo.right_bg) {
            ctx.fillStyle = spreadInfo.right_bg;
            const rightX = spreadInfo.kind === 'cover'
                ? spreadRect.x + pageWPx + spinePx
                : spreadRect.x + pageWPx;
            ctx.fillRect(rightX, spreadRect.y - visibleBleedPx, pageWPx + visibleBleedPx, spreadRect.h + visibleBleedPx * 2);
        }
        if (this.showBleed) {
            ctx.strokeStyle = BLEED_COLOR;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(spreadRect.x - bleedPx, spreadRect.y - bleedPx, spreadRect.w + bleedPx * 2, spreadRect.h + bleedPx * 2);
            ctx.setLineDash([]);
        }
    }
    _drawFrames(ctx, spreadRect, renderList, lowDpiMap, printDpi, metrics) {
        const { bleedPx, visibleBleedPx } = metrics;
        // Images and borders share the same clip so neither bleeds outside the
        // visible area. When showBleed is false, visibleBleedPx=0 clips to the
        // trim boundary; when true, it clips to the full bleed extent.
        this._dpiBadges = [];
        ctx.save();
        ctx.beginPath();
        ctx.rect(spreadRect.x - visibleBleedPx, spreadRect.y - visibleBleedPx, spreadRect.w + visibleBleedPx * 2, spreadRect.h + visibleBleedPx * 2);
        ctx.clip();
        for (const frame of renderList) {
            const rx = spreadRect.x + frame.rect.x;
            const ry = spreadRect.y + frame.rect.y;
            this._drawFrame(ctx, frame, rx, ry, frame.rect.w, frame.rect.h, lowDpiMap, printDpi);
        }
        ctx.restore();
        if (this.showBleed && bleedPx > 0) {
            ctx.save();
            ctx.fillStyle = this._getHatchPattern(ctx);
            ctx.beginPath();
            ctx.rect(spreadRect.x - bleedPx, spreadRect.y - bleedPx, spreadRect.w + bleedPx * 2, spreadRect.h + bleedPx * 2);
            ctx.rect(spreadRect.x, spreadRect.y, spreadRect.w, spreadRect.h);
            ctx.fill('evenodd');
            ctx.restore();
        }
    }
    _drawSafeZone(ctx, spreadRect, spreadInfo, metrics) {
        if (!this.showSafeZone)
            return;
        const { safePx, pageWPx, pageHPx, spinePx } = metrics;
        ctx.strokeStyle = SAFE_COLOR;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        if (spreadInfo.kind === 'cover') {
            ctx.strokeRect(spreadRect.x + safePx, spreadRect.y + safePx, pageWPx - safePx * 2, pageHPx - safePx * 2);
            ctx.strokeRect(spreadRect.x + pageWPx + spinePx + safePx, spreadRect.y + safePx, pageWPx - safePx * 2, pageHPx - safePx * 2);
        }
        else {
            ctx.strokeRect(spreadRect.x + safePx, spreadRect.y + safePx, spreadRect.w - safePx * 2, spreadRect.h - safePx * 2);
        }
        ctx.setLineDash([]);
    }
    _drawSplitOverlays(ctx, spreadRect, overlays, renderList) {
        const { splitPreview, edgeDragPreview, swapOverlay, imageDropPreview } = overlays;
        if (splitPreview) {
            const { frameRect, axis, ratio, numCuts } = splitPreview;
            const fx = spreadRect.x + frameRect.x;
            const fy = spreadRect.y + frameRect.y;
            ctx.save();
            ctx.beginPath();
            ctx.rect(fx, fy, frameRect.w, frameRect.h);
            ctx.clip();
            ctx.strokeStyle = SELECTED_COLOR;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            if (axis === 'quadrant') {
                for (let i = 1; i <= numCuts; i++) {
                    const r = i / (numCuts + 1);
                    const lx = fx + r * frameRect.w;
                    const ly = fy + r * frameRect.h;
                    ctx.moveTo(lx, fy);
                    ctx.lineTo(lx, fy + frameRect.h);
                    ctx.moveTo(fx, ly);
                    ctx.lineTo(fx + frameRect.w, ly);
                }
            }
            else if (axis === 'v') {
                for (let i = 1; i <= numCuts; i++) {
                    const r = numCuts === 1 ? ratio : i / (numCuts + 1);
                    const lx = fx + r * frameRect.w;
                    ctx.moveTo(lx, fy);
                    ctx.lineTo(lx, fy + frameRect.h);
                }
            }
            else {
                for (let i = 1; i <= numCuts; i++) {
                    const r = numCuts === 1 ? ratio : i / (numCuts + 1);
                    const ly = fy + r * frameRect.h;
                    ctx.moveTo(fx, ly);
                    ctx.lineTo(fx + frameRect.w, ly);
                }
            }
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }
        if (edgeDragPreview) {
            this._drawEdgeDragPreview(ctx, spreadRect, edgeDragPreview);
        }
        else if (this.hoveredEdge) {
            this._drawEdgeHoverHint(ctx, spreadRect, this.hoveredEdge);
        }
        if (swapOverlay) {
            const { sourceId, targetId } = swapOverlay;
            for (const frame of renderList) {
                if (frame.id !== sourceId && frame.id !== targetId)
                    continue;
                const fx = spreadRect.x + frame.rect.x;
                const fy = spreadRect.y + frame.rect.y;
                const fw = frame.rect.w;
                const fh = frame.rect.h;
                if (frame.id === sourceId) {
                    ctx.fillStyle = 'rgba(74, 144, 226, 0.20)';
                    ctx.fillRect(fx, fy, fw, fh);
                    ctx.strokeStyle = SELECTED_COLOR;
                    ctx.lineWidth = 2;
                    ctx.setLineDash([5, 3]);
                    ctx.strokeRect(fx, fy, fw, fh);
                    ctx.setLineDash([]);
                }
                else {
                    ctx.fillStyle = 'rgba(74, 144, 226, 0.35)';
                    ctx.fillRect(fx, fy, fw, fh);
                    ctx.strokeStyle = SELECTED_COLOR;
                    ctx.lineWidth = 2.5;
                    ctx.setLineDash([]);
                    ctx.strokeRect(fx, fy, fw, fh);
                }
            }
        }
        if (imageDropPreview) {
            this._drawImageDropPreview(ctx, spreadRect, imageDropPreview);
        }
    }
    _drawImageDropPreview(ctx, layoutRect, preview) {
        const { frameRect, zone, hasExistingImage } = preview;
        const fx = layoutRect.x + frameRect.x;
        const fy = layoutRect.y + frameRect.y;
        const fw = frameRect.w;
        const fh = frameRect.h;
        ctx.save();
        if (zone === 'center') {
            ctx.fillStyle = 'rgba(74, 144, 226, 0.22)';
            ctx.fillRect(fx, fy, fw, fh);
            ctx.strokeStyle = SELECTED_COLOR;
            ctx.lineWidth = 2.5;
            ctx.setLineDash([]);
            ctx.strokeRect(fx, fy, fw, fh);
        }
        else {
            const half = 0.5;
            let newX = fx, newY = fy, newW = fw, newH = fh;
            let keepX = fx, keepY = fy, keepW = fw, keepH = fh;
            let lx1, ly1, lx2, ly2;
            if (zone === 'left') {
                newW = fw * half;
                keepX = fx + fw * half;
                keepW = fw * half;
                lx1 = fx + fw * half;
                ly1 = fy;
                lx2 = lx1;
                ly2 = fy + fh;
            }
            else if (zone === 'right') {
                newX = fx + fw * half;
                newW = fw * half;
                keepW = fw * half;
                lx1 = fx + fw * half;
                ly1 = fy;
                lx2 = lx1;
                ly2 = fy + fh;
            }
            else if (zone === 'top') {
                newH = fh * half;
                keepY = fy + fh * half;
                keepH = fh * half;
                lx1 = fx;
                ly1 = fy + fh * half;
                lx2 = fx + fw;
                ly2 = ly1;
            }
            else {
                newY = fy + fh * half;
                newH = fh * half;
                keepH = fh * half;
                lx1 = fx;
                ly1 = fy + fh * half;
                lx2 = fx + fw;
                ly2 = ly1;
            }
            ctx.fillStyle = 'rgba(74, 144, 226, 0.35)';
            ctx.fillRect(newX, newY, newW, newH);
            ctx.fillStyle = 'rgba(200, 200, 200, 0.18)';
            ctx.fillRect(keepX, keepY, keepW, keepH);
            ctx.strokeStyle = SELECTED_COLOR;
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 3]);
            ctx.beginPath();
            ctx.moveTo(lx1, ly1);
            ctx.lineTo(lx2, ly2);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.lineWidth = 1.5;
            ctx.strokeRect(fx, fy, fw, fh);
        }
        ctx.restore();
    }
    _drawDividerLayer(ctx, spreadRect, editor, renderList, selectedSegmentId, bleedPx, marginPx) {
        const twinHandles = this._geoCache.twinHandles;
        const selectedTwin = this.twinSegmentSelected && selectedSegmentId !== NULL_ID
            ? twinHandles.find(th => th.edge_id === selectedSegmentId) ?? null
            : null;
        const dividers = this._geoCache.dividers;
        for (const div of dividers) {
            // Suppress the full-chain highlight when a specific twin segment is selected.
            const isSelected = selectedTwin === null && selectedSegmentId !== NULL_ID && div.segment_id === selectedSegmentId;
            const isHovered = this.hoveredDivider === div.segment_id;
            if (!isSelected && !isHovered)
                continue;
            ctx.strokeStyle = isSelected ? SELECTED_COLOR : DIVIDER_HOVER_COLOR;
            ctx.lineWidth = isSelected ? 2.5 : 1.5;
            ctx.setLineDash([]);
            ctx.beginPath();
            if (div.axis === 'v') {
                const dx = spreadRect.x + div.x;
                ctx.moveTo(dx, spreadRect.y + div.y);
                ctx.lineTo(dx, spreadRect.y + div.y + div.length);
            }
            else {
                const dy = spreadRect.y + div.y;
                ctx.moveTo(spreadRect.x + div.x, dy);
                ctx.lineTo(spreadRect.x + div.x + div.length, dy);
            }
            ctx.stroke();
        }
        if (selectedTwin !== null) {
            ctx.strokeStyle = SELECTED_COLOR;
            ctx.lineWidth = 2.5;
            ctx.setLineDash([]);
            ctx.beginPath();
            const hx = spreadRect.x + selectedTwin.x;
            const hy = spreadRect.y + selectedTwin.y;
            if (selectedTwin.axis === 'v') {
                ctx.moveTo(hx, hy - selectedTwin.length / 2);
                ctx.lineTo(hx, hy + selectedTwin.length / 2);
            }
            else {
                ctx.moveTo(hx - selectedTwin.length / 2, hy);
                ctx.lineTo(hx + selectedTwin.length / 2, hy);
            }
            ctx.stroke();
        }
        // Room outlines — blue border around the room rect of every selected frame,
        // drawn above all frame content and dividers but below the transform box.
        for (const frame of renderList) {
            if (!frame.is_selected)
                continue;
            const rr = frame.face_rect;
            const rrx = spreadRect.x + rr.x;
            const rry = spreadRect.y + rr.y;
            const nodeRad = (frame.face_rotation_deg * Math.PI) / 180;
            ctx.save();
            if (nodeRad !== 0) {
                const rcx = rrx + rr.w / 2;
                const rcy = rry + rr.h / 2;
                ctx.translate(rcx, rcy);
                ctx.rotate(-nodeRad);
                ctx.translate(-rcx, -rcy);
            }
            ctx.strokeStyle = SELECTED_COLOR;
            const lw = 2;
            ctx.lineWidth = lw;
            ctx.setLineDash([]);
            // Inset by half the stroke width so the border stays fully inside the face
            // boundary — prevents double-width lines where two selected faces share an edge.
            ctx.strokeRect(rrx + lw / 2, rry + lw / 2, rr.w - lw, rr.h - lw);
            ctx.restore();
        }
        // Twin handles — only visible while hovering the divider (or the handle itself).
        this._twinHandles = twinHandles;
        if (this.hoveredDivider !== null || this.hoveredTwinHandle !== null) {
            for (const th of twinHandles) {
                const isHovered = this.hoveredTwinHandle !== null && this.hoveredTwinHandle.edge_id === th.edge_id;
                const hx = spreadRect.x + th.x;
                const hy = spreadRect.y + th.y;
                this._drawTwinHandle(ctx, hx, hy, isHovered);
            }
        }
        // X-junction handles — only visible while hovering a divider (or the handle itself).
        this._bleedPx = bleedPx;
        this._spreadMarginPx = marginPx;
        this._xJunctions = getXJunctions(editor);
        if (this.hoveredDivider !== null || this.hoveredXJunction !== null) {
            for (const jx of this._xJunctions) {
                const cx = spreadRect.x + (-bleedPx + marginPx.left + jx.nx * (spreadRect.w + 2 * bleedPx - marginPx.left - marginPx.right));
                const cy = spreadRect.y + (-bleedPx + marginPx.top + jx.ny * (spreadRect.h + 2 * bleedPx - marginPx.top - marginPx.bottom));
                const isHovered = this.hoveredXJunction !== null
                    && this.hoveredXJunction.tl_id === jx.tl_id;
                this._drawXJunctionHandle(ctx, cx, cy, isHovered);
            }
        }
    }
    _drawFrame(ctx, frame, rx, ry, rw, rh, lowDpiMap, printDpi) {
        const nodeRad = ((frame.face_rotation_deg ?? 0) * Math.PI) / 180;
        const hasNodeTransform = nodeRad !== 0;
        const fcx = rx + rw / 2;
        const fcy = ry + rh / 2;
        ctx.save();
        if (hasNodeTransform) {
            ctx.translate(fcx, fcy);
            ctx.rotate(-nodeRad);
            ctx.translate(-fcx, -fcy);
        }
        const rtl = Math.max(0, frame.border_radius ?? 0);
        const rtr = Math.max(0, frame.border_radius_tr ?? 0);
        const rbr = Math.max(0, frame.border_radius_br ?? 0);
        const rbl = Math.max(0, frame.border_radius_bl ?? 0);
        const radii = [rtl, rtr, rbr, rbl];
        const anyRad = rtl > 0 || rtr > 0 || rbr > 0 || rbl > 0;
        // Image (clipped to frame bounds, with rounded corners if radius > 0).
        ctx.save();
        ctx.beginPath();
        if (anyRad)
            ctx.roundRect(rx, ry, rw, rh, radii);
        else
            ctx.rect(rx, ry, rw, rh);
        ctx.clip();
        if (frame.image_id && this.imageCache.has(frame.image_id)) {
            const img = this.imageCache.get(frame.image_id);
            this._drawImageCover(ctx, img, rx, ry, rw, rh, frame.pan_x, frame.pan_y, frame.object_fit, frame.scale, frame.rotation_deg);
        }
        else {
            this._drawEmptyFramePlaceholder(ctx, rx, ry, rw, rh);
        }
        ctx.restore();
        const bwt = frame.border_width_top, bwr = frame.border_width_right;
        const bwb = frame.border_width_bottom, bwl = frame.border_width_left;
        const hasBorder = bwt > 0 || bwr > 0 || bwb > 0 || bwl > 0;
        if (hasBorder) {
            ctx.save();
            ctx.strokeStyle = frame.border_color;
            ctx.setLineDash([]);
            const allEqual = bwt === bwr && bwr === bwb && bwb === bwl;
            if (allEqual) {
                const lw = bwt;
                const hw = lw / 2;
                ctx.lineWidth = lw;
                ctx.beginPath();
                if (frame.border_position === 'inner') {
                    const br = radii.map(r => Math.max(0, r - hw));
                    if (anyRad)
                        ctx.roundRect(rx + hw, ry + hw, rw - lw, rh - lw, br);
                    else
                        ctx.rect(rx + hw, ry + hw, rw - lw, rh - lw);
                }
                else if (frame.border_position === 'outer') {
                    const br = radii.map(r => r > 0 ? r + hw : 0);
                    if (anyRad)
                        ctx.roundRect(rx - hw, ry - hw, rw + lw, rh + lw, br);
                    else
                        ctx.rect(rx - hw, ry - hw, rw + lw, rh + lw);
                }
                else {
                    if (anyRad)
                        ctx.roundRect(rx, ry, rw, rh, radii);
                    else
                        ctx.rect(rx, ry, rw, rh);
                }
                ctx.stroke();
            }
            else {
                const pos = frame.border_position;
                const line = (w, x1, y1, x2, y2) => {
                    if (w <= 0)
                        return;
                    ctx.lineWidth = w;
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    ctx.stroke();
                };
                if (pos === 'inner') {
                    line(bwt, rx, ry + bwt / 2, rx + rw, ry + bwt / 2);
                    line(bwr, rx + rw - bwr / 2, ry, rx + rw - bwr / 2, ry + rh);
                    line(bwb, rx, ry + rh - bwb / 2, rx + rw, ry + rh - bwb / 2);
                    line(bwl, rx + bwl / 2, ry, rx + bwl / 2, ry + rh);
                }
                else if (pos === 'outer') {
                    line(bwt, rx, ry - bwt / 2, rx + rw, ry - bwt / 2);
                    line(bwr, rx + rw + bwr / 2, ry, rx + rw + bwr / 2, ry + rh);
                    line(bwb, rx, ry + rh + bwb / 2, rx + rw, ry + rh + bwb / 2);
                    line(bwl, rx - bwl / 2, ry, rx - bwl / 2, ry + rh);
                }
                else {
                    line(bwt, rx, ry, rx + rw, ry);
                    line(bwr, rx + rw, ry, rx + rw, ry + rh);
                    line(bwb, rx, ry + rh, rx + rw, ry + rh);
                    line(bwl, rx, ry, rx, ry + rh);
                }
            }
            ctx.restore();
        }
        if (!hasBorder && !frame.image_id) {
            ctx.strokeStyle = FRAME_EMPTY_COLOR;
            ctx.lineWidth = 1;
            ctx.setLineDash([]);
            ctx.beginPath();
            if (anyRad)
                ctx.roundRect(rx, ry, rw, rh, radii);
            else
                ctx.rect(rx, ry, rw, rh);
            ctx.stroke();
        }
        if (lowDpiMap && lowDpiMap.has(frame.id)) {
            const effectiveDpi = lowDpiMap.get(frame.id);
            const { cx, cy } = this._drawDpiWarning(ctx, rx, ry, rw, rh);
            this._dpiBadges.push({ cx, cy, r: 8, effectiveDpi, printDpi });
        }
        ctx.restore(); // restore node transform
    }
    _drawEmptyFramePlaceholder(ctx, rx, ry, rw, rh) {
        const BG = '#DDDFE4';
        const ICON_SIZE = 150; // px at which to render the SVG icon
        // Always fill the frame with the placeholder background colour first.
        ctx.fillStyle = BG;
        ctx.fillRect(rx, ry, rw, rh);
        if (!this._placeholderImg)
            return;
        // Draw the SVG centred, capped at ICON_SIZE, never stretched.
        const sz = Math.min(ICON_SIZE, rw, rh);
        const ix = rx + (rw - sz) / 2;
        const iy = ry + (rh - sz) / 2;
        ctx.drawImage(this._placeholderImg, ix, iy, sz, sz);
    }
    _drawDpiWarning(ctx, rx, ry, rw, rh) {
        const sz = 16;
        const pad = 5;
        const cx = rx + pad + sz / 2;
        const cy = ry + rh - pad - sz / 2;
        ctx.save();
        ctx.fillStyle = '#e8a020';
        ctx.beginPath();
        ctx.arc(cx, cy, sz / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1a1a1a';
        ctx.font = `bold ${Math.round(sz * 0.65)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', cx, cy + 0.5);
        ctx.restore();
        return { cx, cy };
    }
    dpiBadgeAt(canvasX, canvasY) {
        for (const b of this._dpiBadges) {
            const dx = canvasX - b.cx;
            const dy = canvasY - b.cy;
            if (dx * dx + dy * dy <= (b.r + 3) * (b.r + 3))
                return b;
        }
        return null;
    }
    _drawImageCover(ctx, img, rx, ry, rw, rh, panX, panY, objectFit, userScale, rotationDeg) {
        if (objectFit === 'fill') {
            ctx.save();
            ctx.beginPath();
            ctx.rect(rx, ry, rw, rh);
            ctx.clip();
            ctx.drawImage(img, rx, ry, rw, rh);
            ctx.restore();
            return;
        }
        const iw = img instanceof ImageBitmap ? img.width : img.naturalWidth;
        const ih = img instanceof ImageBitmap ? img.height : img.naturalHeight;
        if (!iw || !ih)
            return;
        const frameRatio = rw / rh;
        const imgRatio = iw / ih;
        if (objectFit === 'contain') {
            let sw, sh;
            if (imgRatio > frameRatio) {
                sw = rw;
                sh = rw / imgRatio;
            }
            else {
                sh = rh;
                sw = rh * imgRatio;
            }
            const sx = rx + (rw - sw) / 2;
            const sy = ry + (rh - sh) / 2;
            ctx.save();
            ctx.beginPath();
            ctx.rect(rx, ry, rw, rh);
            ctx.clip();
            ctx.drawImage(img, sx, sy, sw, sh);
            ctx.restore();
            return;
        }
        // cover (default) with pan, scale, rotation
        const cov = computeImageCover(rw, rh, iw, ih, panX !== undefined ? panX : 0.5, panY !== undefined ? panY : 0.5, userScale ?? 1.0, rotationDeg ?? 0);
        if (!cov)
            return;
        const { sw, sh, pan_off_x: panOffX, pan_off_y: panOffY } = cov;
        const rad = ((rotationDeg ?? 0) * Math.PI) / 180;
        const cx = rx + rw / 2;
        const cy = ry + rh / 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(rx, ry, rw, rh);
        ctx.clip();
        ctx.translate(cx, cy);
        ctx.rotate(-rad);
        ctx.drawImage(img, -rw / 2 - panOffX, -rh / 2 - panOffY, sw, sh);
        ctx.restore();
    }
    _getHatchPattern(ctx) {
        if (this._hatchPattern)
            return this._hatchPattern;
        const s = Math.ceil(8 * this.dpr);
        const off = document.createElement('canvas');
        off.width = s;
        off.height = s;
        const oc = off.getContext('2d');
        oc.strokeStyle = 'rgba(180, 50, 50, 0.55)';
        oc.lineWidth = Math.max(1, this.dpr * 0.75);
        oc.beginPath();
        oc.moveTo(0, s);
        oc.lineTo(s, 0);
        oc.stroke();
        this._hatchPattern = ctx.createPattern(off, 'repeat');
        return this._hatchPattern;
    }
    _drawGuides(ctx, spreadInfo, spreadRect, pageWPx, pageHPx, spinePx, mmToPx) {
        const top = spreadRect.y;
        const bottom = spreadRect.y + pageHPx;
        const TICK = 6;
        if (spreadInfo.kind === 'cover') {
            const spineLeft = spreadRect.x + pageWPx;
            const spineRight = spineLeft + spinePx;
            for (const gx of [spineLeft, spineRight]) {
                ctx.strokeStyle = SPINE_COLOR;
                ctx.lineWidth = 1;
                ctx.setLineDash([5, 3]);
                ctx.beginPath();
                ctx.moveTo(gx, top - TICK * 2);
                ctx.lineTo(gx, bottom + TICK * 2);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            ctx.fillStyle = 'rgba(255,160,0,0.08)';
            ctx.fillRect(spineLeft, top, spinePx, pageHPx);
            const spineMmLabel = spreadInfo.spine_mm.toFixed(1) + ' mm';
            const midX = spineLeft + spinePx / 2;
            const labelY = top - TICK * 2 - 4;
            ctx.strokeStyle = SPINE_COLOR;
            ctx.lineWidth = 1;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(spineLeft, top - TICK * 2);
            ctx.lineTo(spineLeft, top - TICK * 2 - 6);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(spineRight, top - TICK * 2);
            ctx.lineTo(spineRight, top - TICK * 2 - 6);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(spineLeft, top - TICK * 2 - 3);
            ctx.lineTo(spineRight, top - TICK * 2 - 3);
            ctx.stroke();
            ctx.font = '9px system-ui, sans-serif';
            ctx.textAlign = 'center';
            const tw = ctx.measureText(spineMmLabel).width + 4;
            ctx.fillStyle = '#3c3c3c';
            ctx.fillRect(midX - tw / 2, labelY - 9, tw, 11);
            ctx.fillStyle = SPINE_COLOR;
            ctx.fillText(spineMmLabel, midX, labelY);
            if (spinePx >= 16) {
                ctx.save();
                ctx.fillStyle = 'rgba(255,160,0,0.7)';
                ctx.font = `bold ${Math.min(11, spinePx * 0.55)}px system-ui, sans-serif`;
                ctx.textAlign = 'center';
                ctx.translate(midX, top + pageHPx / 2);
                ctx.rotate(-Math.PI / 2);
                ctx.fillText('SPINE', 0, 0);
                ctx.restore();
            }
        }
        else {
            const foldX = spreadRect.x + spreadRect.w / 2;
            ctx.strokeStyle = FOLD_COLOR;
            ctx.lineWidth = 1;
            ctx.setLineDash([6, 3]);
            ctx.beginPath();
            ctx.moveTo(foldX, top - TICK * 2);
            ctx.lineTo(foldX, bottom + TICK * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.strokeStyle = FOLD_COLOR;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(foldX - 3, top - TICK * 2);
            ctx.lineTo(foldX + 3, top - TICK * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(foldX - 3, bottom + TICK * 2);
            ctx.lineTo(foldX + 3, bottom + TICK * 2);
            ctx.stroke();
            const labelY = top - TICK * 2 - 4;
            ctx.font = '9px system-ui, sans-serif';
            ctx.textAlign = 'center';
            const tw = ctx.measureText('Fold').width + 4;
            ctx.fillStyle = '#3c3c3c';
            ctx.fillRect(foldX - tw / 2, labelY - 9, tw, 11);
            ctx.fillStyle = FOLD_COLOR;
            ctx.fillText('Fold', foldX, labelY);
        }
        void mmToPx; // used indirectly via pageWPx / spinePx
    }
    updateHover(editor, canvasX, canvasY) {
        // Use the layout rect (printable half for endpaper spreads) for all WASM calls
        // so hit-testing and handle positions match what was rendered.
        const layoutRect = this.lastLayoutRect;
        const layoutRelX = canvasX - layoutRect.x;
        const layoutRelY = canvasY - layoutRect.y;
        editor.set_mouse_pos(layoutRelX, layoutRelY);
        const hov = editor.hovered_divider(layoutRect.w, layoutRect.h);
        const newDivider = hov === 0xFFFFFFFF ? null : hov;
        const newLeaf = editor.hit_test(layoutRelX, layoutRelY, layoutRect.w, layoutRect.h);
        const changed = newDivider !== this.hoveredDivider || newLeaf !== this.hoveredLeaf;
        this.hoveredDivider = newDivider;
        this.hoveredLeaf = newLeaf;
        return changed;
    }
    // ---------------------------------------------------------------------------
    // Text element rendering helpers
    // ---------------------------------------------------------------------------
    /** Rotate point (px, py) around (cx, cy) by rad radians (CCW in canvas space). */
    _rotatePoint(px, py, cx, cy, rad) {
        const dx = px - cx, dy = py - cy;
        return {
            x: cx + dx * Math.cos(rad) + dy * Math.sin(rad),
            y: cy - dx * Math.sin(rad) + dy * Math.cos(rad),
        };
    }
    _drawTextElement(ctx, el, spreadRect, mmToPx, isSelected) {
        const isInlineEditing = el.id === this.editingTextId;
        const rad = (el.rotation_deg * Math.PI) / 180;
        // 1 pt = 1/72 inch = 25.4/72 mm
        const fontPx = el.font_size_pt * (25.4 / 72) * mmToPx;
        const lineH = fontPx * 1.2;
        const lines = (el.content || '').split('\n');
        const fontStyle = (el.italic ? 'italic ' : '') + (el.bold ? 'bold ' : '');
        ctx.font = `${fontStyle}${fontPx}px "${el.font_family}", sans-serif`;
        // Measure actual text extent so the handles match what the user sees.
        const lineWidths = lines.map(l => ctx.measureText(l || ' ').width);
        const textW = Math.max(...lineWidths, 1); // canvas px
        const textH = lines.length * lineH; // canvas px
        const hw = textW / 2;
        const hh = textH / 2;
        // Top-left origin and centre in canvas space (unrotated).
        const ox = spreadRect.x + el.x_mm * mmToPx;
        const oy = spreadRect.y + el.y_mm * mmToPx;
        const cx = ox + hw;
        const cy = oy + hh;
        // Don't draw text or handles while the inline editor overlay is active for
        // this element — the textarea is visible on top of the canvas instead.
        if (!isInlineEditing) {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(-rad);
            ctx.translate(-cx, -cy);
            ctx.fillStyle = el.color || '#000';
            ctx.textBaseline = 'top';
            ctx.textAlign = (el.align || 'left');
            let textX;
            if (el.align === 'center')
                textX = ox + hw;
            else if (el.align === 'right')
                textX = ox + textW;
            else
                textX = ox;
            for (let i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], textX, oy + i * lineH);
            }
            if (el.underline) {
                const ulY = oy + fontPx * 0.87;
                const thickness = Math.max(1, fontPx * 0.06);
                ctx.strokeStyle = el.color || '#000';
                ctx.lineWidth = thickness;
                for (let i = 0; i < lines.length; i++) {
                    const lw = lineWidths[i];
                    let x0, x1;
                    if (el.align === 'center') {
                        x0 = textX - lw / 2;
                        x1 = textX + lw / 2;
                    }
                    else if (el.align === 'right') {
                        x0 = textX - lw;
                        x1 = textX;
                    }
                    else {
                        x0 = textX;
                        x1 = textX + lw;
                    }
                    ctx.beginPath();
                    ctx.moveTo(x0, ulY + i * lineH);
                    ctx.lineTo(x1, ulY + i * lineH);
                    ctx.stroke();
                }
            }
            ctx.restore();
        }
        // Always build hit-test geometry so the element remains selectable.
        const rawCorners = [
            { x: cx - hw, y: cy - hh },
            { x: cx + hw, y: cy - hh },
            { x: cx + hw, y: cy + hh },
            { x: cx - hw, y: cy + hh },
        ];
        const corners = rawCorners.map(c => this._rotatePoint(c.x, c.y, cx, cy, rad));
        const rotHandle = this._rotatePoint(cx, cy - hh - ROTATION_HANDLE_DIST, cx, cy, rad);
        const hit = { id: el.id, cx, cy, hw, hh, rad, corners, rotHandle };
        this._textHits.push(hit);
        if (isSelected && !isInlineEditing)
            this._drawTextHandles(ctx, hit);
    }
    _drawTextHandles(ctx, hit) {
        const { cx, cy, hw, hh, rad, corners, rotHandle } = hit;
        // Dashed bounding box.
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-rad);
        ctx.translate(-cx, -cy);
        ctx.strokeStyle = TEXT_SELECTED_COLOR;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(cx - hw, cy - hh, hw * 2, hh * 2);
        ctx.setLineDash([]);
        ctx.restore();
        // Rotation handle line (top-centre → handle).
        const topCentreRaw = this._rotatePoint(cx, cy - hh, cx, cy, rad);
        ctx.save();
        ctx.strokeStyle = TEXT_SELECTED_COLOR;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(topCentreRaw.x, topCentreRaw.y);
        ctx.lineTo(rotHandle.x, rotHandle.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        // Corner handles.
        for (const c of corners) {
            ctx.beginPath();
            ctx.arc(c.x, c.y, TEXT_HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = TEXT_SELECTED_COLOR;
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        // Rotation handle (circle).
        ctx.beginPath();
        ctx.arc(rotHandle.x, rotHandle.y, TEXT_HANDLE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = TEXT_SELECTED_COLOR;
        ctx.lineWidth = 2;
        ctx.stroke();
        // Small arc inside to indicate rotate.
        ctx.beginPath();
        ctx.arc(rotHandle.x, rotHandle.y, TEXT_HANDLE_RADIUS * 0.45, -Math.PI * 0.75, Math.PI * 0.25);
        ctx.strokeStyle = TEXT_SELECTED_COLOR;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
    /**
     * Given a canvas-space point, return info about which text element / handle was hit.
     * Returns null if nothing was hit.
     */
    hitTestText(cx, cy) {
        for (const hit of this._textHits) {
            // Check rotation handle first (highest priority).
            const rdx = cx - hit.rotHandle.x, rdy = cy - hit.rotHandle.y;
            if (rdx * rdx + rdy * rdy <= (TEXT_HANDLE_RADIUS + 3) ** 2) {
                return { id: hit.id, part: 'rotate' };
            }
            // Check corner handles.
            for (let i = 0; i < hit.corners.length; i++) {
                const c = hit.corners[i];
                const dx = cx - c.x, dy = cy - c.y;
                if (dx * dx + dy * dy <= (TEXT_HANDLE_RADIUS + 3) ** 2) {
                    return { id: hit.id, part: 'corner', cornerIndex: i };
                }
            }
            // Check interior: inverse-rotate mouse point and test AABB.
            const dx = cx - hit.cx, dy = cy - hit.cy;
            const localX = dx * Math.cos(hit.rad) - dy * Math.sin(hit.rad);
            const localY = dx * Math.sin(hit.rad) + dy * Math.cos(hit.rad);
            if (Math.abs(localX) <= hit.hw + 4 && Math.abs(localY) <= hit.hh + 4) {
                return { id: hit.id, part: 'body' };
            }
        }
        return null;
    }
    toSpreadCoords(clientX, clientY, spreadRect) {
        const rect = this.canvas.getBoundingClientRect();
        const cssX = clientX - rect.left;
        const cssY = clientY - rect.top;
        return { x: cssX - spreadRect.x, y: cssY - spreadRect.y };
    }
    _drawEdgeDragPreview(ctx, sr, preview) {
        const { axis, ratio, newIsFirst } = preview;
        ctx.save();
        ctx.fillStyle = 'rgba(74, 144, 226, 0.15)';
        if (axis === 'h') {
            const divY = sr.y + ratio * sr.h;
            ctx.fillRect(sr.x, newIsFirst ? sr.y : divY, sr.w, newIsFirst ? ratio * sr.h : (1 - ratio) * sr.h);
            ctx.strokeStyle = SELECTED_COLOR;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(sr.x, divY);
            ctx.lineTo(sr.x + sr.w, divY);
            ctx.stroke();
        }
        else {
            const divX = sr.x + ratio * sr.w;
            ctx.fillRect(newIsFirst ? sr.x : divX, sr.y, newIsFirst ? ratio * sr.w : (1 - ratio) * sr.w, sr.h);
            ctx.strokeStyle = SELECTED_COLOR;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(divX, sr.y);
            ctx.lineTo(divX, sr.y + sr.h);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();
    }
    _drawTwinHandle(ctx, cx, cy, hovered) {
        const R = 6;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx, cy - R);
        ctx.lineTo(cx + R, cy);
        ctx.lineTo(cx, cy + R);
        ctx.lineTo(cx - R, cy);
        ctx.closePath();
        ctx.fillStyle = hovered ? 'rgba(240,160,48,0.9)' : 'rgba(240,160,48,0.40)';
        ctx.fill();
        ctx.strokeStyle = hovered ? '#f0a030' : 'rgba(240,160,48,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
    }
    _drawXJunctionHandle(ctx, cx, cy, hovered) {
        const R = 7;
        const r = R * 0.45;
        ctx.save();
        ctx.beginPath();
        // 4-pointed star
        for (let i = 0; i < 8; i++) {
            const angle = (i * Math.PI) / 4;
            const rad = i % 2 === 0 ? R : r;
            const x = cx + Math.cos(angle - Math.PI / 2) * rad;
            const y = cy + Math.sin(angle - Math.PI / 2) * rad;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = hovered ? 'rgba(80,200,120,0.95)' : 'rgba(80,200,120,0.45)';
        ctx.strokeStyle = hovered ? '#38b86a' : 'rgba(80,200,120,0.7)';
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }
    /** Return the X-junction handle at canvas coords (x, y), or null. */
    xJunctionAt(canvasX, canvasY, spreadRect) {
        const HIT_R = 11;
        const bp = this._bleedPx;
        const mp = this._spreadMarginPx;
        for (const jx of this._xJunctions) {
            const cx = spreadRect.x + (-bp + mp.left + jx.nx * (spreadRect.w + 2 * bp - mp.left - mp.right));
            const cy = spreadRect.y + (-bp + mp.top + jx.ny * (spreadRect.h + 2 * bp - mp.top - mp.bottom));
            const dx = canvasX - cx;
            const dy = canvasY - cy;
            if (dx * dx + dy * dy <= HIT_R * HIT_R)
                return jx;
        }
        return null;
    }
    /**
     * Convert a canvas-space point to normalized grid coords, accounting for
     * bleed and spread margins. Mirrors `root_rect_with_bleed` in Rust.
     */
    canvasToNorm(cx, cy, sr) {
        const bp = this._bleedPx;
        const mp = this._spreadMarginPx;
        const rootX = sr.x - bp + mp.left;
        const rootY = sr.y - bp + mp.top;
        const rootW = sr.w + 2 * bp - mp.left - mp.right;
        const rootH = sr.h + 2 * bp - mp.top - mp.bottom;
        return {
            nx: (cx - rootX) / rootW,
            ny: (cy - rootY) / rootH,
        };
    }
    _drawEdgeHoverHint(ctx, sr, edge) {
        const STRIP = 3;
        const bp = this.visibleBleedPx;
        ctx.save();
        ctx.fillStyle = 'rgba(74, 144, 226, 0.5)';
        switch (edge) {
            case 'top':
                ctx.fillRect(sr.x - bp, sr.y - bp, sr.w + 2 * bp, STRIP);
                break;
            case 'bottom':
                ctx.fillRect(sr.x - bp, sr.y + sr.h + bp - STRIP, sr.w + 2 * bp, STRIP);
                break;
            case 'left':
                ctx.fillRect(sr.x - bp, sr.y - bp, STRIP, sr.h + 2 * bp);
                break;
            case 'right':
                ctx.fillRect(sr.x + sr.w + bp - STRIP, sr.y - bp, STRIP, sr.h + 2 * bp);
                break;
        }
        ctx.restore();
    }
}
