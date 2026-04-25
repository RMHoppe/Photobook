// canvas.ts — All 2D rendering for the double-page spread canvas.
// Receives data from the Wasm editor and draws using Canvas 2D API.

import { PAD, RULER_SIZE, NULL_ID } from './constants.js';
import {
  getSpreadInfo, getLowDpiFrames,
  getSplitNodeBorders, getSelectedSplitInfo, getSelectedTransformHandles,
  computeImageCover, getTextElements,
  getResolvedSpreadDelta,
} from './wasm-bridge.js';
import { drawRulers } from './canvas-draw-rulers.js';
import type { PhotobookEditor } from './pkg/photobook_core.js';
import type {
  SpreadInfo, SpreadRect, RenderFrame, TransformHandles,
  DpiBadge, Overlays, ObjectFit, TextElement, EdgeDragPreview, CrossHandle, CrossHandleDragPreview,
  Divider, NodeBg, SplitBorder, SpreadDelta,
} from './types.js';

// ---------------------------------------------------------------------------
// Geometry cache — avoids repeated JSON parsing on unchanged data
// ---------------------------------------------------------------------------

class SpreadGeometryCache {
  private _leavesOrdered: RenderFrame[] = [];
  private _leafIndex = new Map<number, number>();
  dividers: Divider[] = [];
  backgrounds: NodeBg[] = [];
  splitBorders: SplitBorder[] = [];
  crossHandles: CrossHandle[] = [];

  applyDelta(delta: SpreadDelta): void {
    if (delta.full !== null) {
      const full = delta.full;
      this._leavesOrdered = full.leaves;
      this._leafIndex.clear();
      for (let i = 0; i < full.leaves.length; i++) {
        this._leafIndex.set(full.leaves[i].id, i);
      }
      this.dividers = full.dividers;
      this.backgrounds = full.backgrounds;
      this.splitBorders = full.split_borders;
      this.crossHandles = full.cross_handles;
    } else if (delta.updated_leaves !== null) {
      for (const leaf of delta.updated_leaves) {
        const idx = this._leafIndex.get(leaf.id);
        if (idx !== undefined) this._leavesOrdered[idx] = leaf;
      }
    }
  }

  getLeaves(): RenderFrame[] { return this._leavesOrdered; }
}

const BLEED_COLOR = 'rgba(220, 50, 50, 0.35)';
const SAFE_COLOR  = 'rgba(0, 150, 255, 0.25)';
const FOLD_COLOR  = 'rgba(0, 180, 255, 0.85)';
const SPINE_COLOR = 'rgba(255, 160, 0, 0.85)';
const DIVIDER_HOVER_COLOR = '#aaa';
const SELECTED_COLOR = '#4a90e2';
const ANCESTOR_COLOR = 'rgba(74, 144, 226, 0.45)';
const PLACEHOLDER_BORDER = '#444';
const TRANSFORM_COLOR = '#e8a020';
const TRANSFORM_FILL  = 'rgba(232, 160, 32, 0.10)';
const HANDLE_RADIUS = 8;
const TEXT_HANDLE_RADIUS = 6;
const TEXT_SELECTED_COLOR = '#34c9a0';
const ROTATION_HANDLE_DIST = 22; // px from top-center to rotation handle

interface HandlePosition {
  side: 'tl' | 'tr' | 'bl' | 'br';
  cx: number;
  cy: number;
}

/** Hit-test info for a text element rendered on the last frame. */
export interface TextHitInfo {
  id: number;
  /** Centre of the bounding box in canvas pixels. */
  cx: number;
  cy: number;
  /** Half-dimensions after scale (canvas pixels). */
  hw: number;
  hh: number;
  /** Rotation angle in radians (CCW positive). */
  rad: number;
  /** Corner handles: TL, TR, BR, BL (canvas pixels). */
  corners: Array<{ x: number; y: number }>;
  /** Rotation handle position (canvas pixels). */
  rotHandle: { x: number; y: number };
}

export class CanvasRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  dpr: number;
  imageCache = new Map<string, HTMLImageElement | ImageBitmap>();
  hoveredDivider: number | null = null;
  hoveredEdge: 'top' | 'bottom' | 'left' | 'right' | null = null;
  hoveredCrossHandle: CrossHandle | null = null;
  hoveredMarginHandle: 'tl' | 'tr' | 'bl' | 'br' | null = null;
  hoveredRotationHandle = false;
  hoveredLeaf: number;
  private _hatchPattern: CanvasPattern | null = null;
  private _placeholderImg: HTMLImageElement | null = null;
  showBleed = true;
  showSafeZone = true;
  showRulers = true;
  zoom = 1.0;
  cssW = 0;
  cssH = 0;
  _dpiBadges: DpiBadge[] = [];
  /** Hit-test info for all text elements from the last draw call. */
  _textHits: TextHitInfo[] = [];
  /** Cross handles from the last draw call, used for hit-testing in idleMode. */
  _crossHandles: CrossHandle[] = [];
  /** ID of the currently selected text element (null = none). */
  selectedTextId: number | null = null;
  /** ID of the text element currently being edited inline (null = none). */
  editingTextId: number | null = null;
  private _geoCache = new SpreadGeometryCache();

  constructor(canvasEl: HTMLCanvasElement, onPlaceholderLoad?: () => void) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d')!;
    this.dpr = window.devicePixelRatio || 1;
    this.hoveredLeaf = NULL_ID;

    const ph = new Image();
    ph.onload = () => { this._placeholderImg = ph; onPlaceholderLoad?.(); };
    ph.src = './placeholder.svg';
  }

  resize(cssW: number, cssH: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width  = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width  = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
  }

  cacheImage(id: string, imgElement: HTMLImageElement | ImageBitmap): void {
    this.imageCache.set(id, imgElement);
  }

  spreadRect(spreadInfo: SpreadInfo): SpreadRect {
    const rulerOffset = this.showRulers ? RULER_SIZE : 0;
    const availW = this.cssW - rulerOffset - PAD * 2;
    const availH = this.cssH - rulerOffset - PAD * 2;
    const spreadAspect = spreadInfo.width_mm / spreadInfo.height_mm;
    let fitW: number, fitH: number;
    if (availW / availH > spreadAspect) {
      fitH = availH; fitW = fitH * spreadAspect;
    } else {
      fitW = availW; fitH = fitW / spreadAspect;
    }
    const scaledW = fitW * this.zoom;
    const scaledH = fitH * this.zoom;
    return {
      x: rulerOffset + PAD + (availW - scaledW) / 2,
      y: rulerOffset + PAD + (availH - scaledH) / 2,
      w: scaledW,
      h: scaledH,
    };
  }

  draw(editor: PhotobookEditor, overlays: Overlays = { marqueeRect: null, splitPreview: null, swapOverlay: null, edgeDragPreview: null, crossHandleDragPreview: null }): void {
    const { marqueeRect = null, splitPreview = null, swapOverlay = null, edgeDragPreview = null, crossHandleDragPreview = null } = overlays;
    const { ctx, dpr, cssW, cssH } = this;
    if (!cssW || !cssH) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    ctx.fillStyle = '#3c3c3c';
    ctx.fillRect(0, 0, cssW, cssH);

    const rulerOffset = this.showRulers ? RULER_SIZE : 0;

    const spreadInfo = getSpreadInfo(editor);
    const bleedMm    = editor.get_bleed_mm();
    const safeZoneMm = editor.get_safe_zone_mm();

    const spreadRect = this.spreadRect(spreadInfo);

    const mmToPx  = spreadRect.w / spreadInfo.width_mm;
    const pageWPx = spreadInfo.page_width_mm * mmToPx;
    const pageHPx = spreadRect.h;
    const spinePx = spreadInfo.spine_mm * mmToPx;
    const bleedPx = bleedMm * mmToPx;
    const safePx  = safeZoneMm * mmToPx;

    // When bleed is hidden, clip everything to the trim boundary.
    const visibleBleedPx = this.showBleed ? bleedPx : 0;

    ctx.fillStyle = '#fff';
    ctx.fillRect(
      spreadRect.x - visibleBleedPx, spreadRect.y - visibleBleedPx,
      spreadRect.w + visibleBleedPx * 2, spreadRect.h + visibleBleedPx * 2,
    );

    if (this.showBleed) {
      ctx.strokeStyle = BLEED_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        spreadRect.x - bleedPx, spreadRect.y - bleedPx,
        spreadRect.w + bleedPx * 2, spreadRect.h + bleedPx * 2,
      );
      ctx.setLineDash([]);
    }

    if (this.showSafeZone) {
      ctx.strokeStyle = SAFE_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      if (spreadInfo.kind === 'cover') {
        ctx.strokeRect(spreadRect.x + safePx, spreadRect.y + safePx,
          pageWPx - safePx * 2, pageHPx - safePx * 2);
        ctx.strokeRect(spreadRect.x + pageWPx + spinePx + safePx, spreadRect.y + safePx,
          pageWPx - safePx * 2, pageHPx - safePx * 2);
      } else {
        ctx.strokeRect(spreadRect.x + safePx, spreadRect.y + safePx,
          spreadRect.w - safePx * 2, spreadRect.h - safePx * 2);
      }
      ctx.setLineDash([]);
    }

    const delta = getResolvedSpreadDelta(editor, spreadRect.w, spreadRect.h);
    this._geoCache.applyDelta(delta);
    const renderList = this._geoCache.getLeaves();
    const nodeBgs = this._geoCache.backgrounds;

    // Node backgrounds and images share the same clip so neither bleeds outside
    // the visible area. When showBleed is false, visibleBleedPx=0 clips to the
    // trim boundary; when true, it clips to the full bleed extent.
    ctx.save();
    ctx.beginPath();
    ctx.rect(spreadRect.x - visibleBleedPx, spreadRect.y - visibleBleedPx,
             spreadRect.w + visibleBleedPx * 2, spreadRect.h + visibleBleedPx * 2);
    ctx.clip();

    for (const bg of nodeBgs) {
      ctx.fillStyle = bg.color;
      ctx.fillRect(spreadRect.x + bg.rect.x, spreadRect.y + bg.rect.y, bg.rect.w, bg.rect.h);
    }

    const lowDpiFrames = getLowDpiFrames(editor, spreadRect.w, spreadRect.h);
    const lowDpiMap = new Map<number, number>(lowDpiFrames.map(f => [f.id, f.effective_dpi]));
    const printDpi = editor.get_print_dpi();
    this._dpiBadges = [];

    for (const frame of renderList) {
      const rx = spreadRect.x + frame.rect.x;
      const ry = spreadRect.y + frame.rect.y;
      const rw = frame.rect.w;
      const rh = frame.rect.h;
      this._drawFrame(ctx, frame, rx, ry, rw, rh, lowDpiMap, printDpi);
    }

    ctx.restore();

    if (this.showBleed && bleedPx > 0) {
      ctx.save();
      ctx.fillStyle = this._getHatchPattern(ctx);
      ctx.beginPath();
      ctx.rect(spreadRect.x - bleedPx, spreadRect.y - bleedPx,
               spreadRect.w + bleedPx * 2, spreadRect.h + bleedPx * 2);
      ctx.rect(spreadRect.x, spreadRect.y, spreadRect.w, spreadRect.h);
      ctx.fill('evenodd');
      ctx.restore();
    }

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
          ctx.moveTo(lx, fy); ctx.lineTo(lx, fy + frameRect.h);
          ctx.moveTo(fx, ly); ctx.lineTo(fx + frameRect.w, ly);
        }
      } else if (axis === 'v') {
        for (let i = 1; i <= numCuts; i++) {
          const r = numCuts === 1 ? ratio : i / (numCuts + 1);
          const lx = fx + r * frameRect.w;
          ctx.moveTo(lx, fy); ctx.lineTo(lx, fy + frameRect.h);
        }
      } else {
        for (let i = 1; i <= numCuts; i++) {
          const r = numCuts === 1 ? ratio : i / (numCuts + 1);
          const ly = fy + r * frameRect.h;
          ctx.moveTo(fx, ly); ctx.lineTo(fx + frameRect.w, ly);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Edge-drag preview: shade the incoming new frame and draw the proposed divider.
    if (edgeDragPreview) {
      this._drawEdgeDragPreview(ctx, spreadRect, edgeDragPreview);
    } else if (this.hoveredEdge) {
      this._drawEdgeHoverHint(ctx, spreadRect, this.hoveredEdge);
    }

    if (swapOverlay) {
      const { sourceId, targetId } = swapOverlay;
      for (const frame of renderList) {
        if (frame.id !== sourceId && frame.id !== targetId) continue;
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
        } else {
          ctx.fillStyle = 'rgba(74, 144, 226, 0.35)';
          ctx.fillRect(fx, fy, fw, fh);
          ctx.strokeStyle = SELECTED_COLOR;
          ctx.lineWidth = 2.5;
          ctx.setLineDash([]);
          ctx.strokeRect(fx, fy, fw, fh);
        }
      }
    }

    const dividers = this._geoCache.dividers;
    for (const div of dividers) {
      if (this.hoveredDivider !== div.node_id) continue;
      ctx.strokeStyle = DIVIDER_HOVER_COLOR;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      if (div.axis === 'v') {
        const dx = spreadRect.x + div.x;
        ctx.moveTo(dx, spreadRect.y + div.y);
        ctx.lineTo(dx, spreadRect.y + div.y + div.length);
      } else {
        const dy = spreadRect.y + div.y;
        ctx.moveTo(spreadRect.x + div.x, dy);
        ctx.lineTo(spreadRect.x + div.x + div.length, dy);
      }
      ctx.stroke();
    }

    // Cross handles — render after dividers so they appear on top.
    const crossHandles = this._geoCache.crossHandles;
    this._crossHandles = crossHandles;
    for (const ch of crossHandles) {
      const hx = spreadRect.x + ch.x;
      const hy = spreadRect.y + ch.y;
      const isHovered = this.hoveredCrossHandle !== null &&
        this.hoveredCrossHandle.parent_id === ch.parent_id &&
        Math.abs(this.hoveredCrossHandle.x - ch.x) < 1 &&
        Math.abs(this.hoveredCrossHandle.y - ch.y) < 1;
      if (ch.kind === 'pinwheel_spawn') {
        this._drawPinwheelSpawnHandle(ctx, hx, hy, isHovered);
      } else {
        this._drawCrossHandle(ctx, hx, hy, isHovered);
      }
    }

    // Cross handle drag preview — a dashed line across the spread.
    if (crossHandleDragPreview) {
      ctx.save();
      ctx.strokeStyle = SELECTED_COLOR;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      if (crossHandleDragPreview.axis === 'h') {
        const ly = spreadRect.y + crossHandleDragPreview.position;
        ctx.moveTo(spreadRect.x, ly);
        ctx.lineTo(spreadRect.x + spreadRect.w, ly);
      } else {
        const lx = spreadRect.x + crossHandleDragPreview.position;
        ctx.moveTo(lx, spreadRect.y);
        ctx.lineTo(lx, spreadRect.y + spreadRect.h);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    const splitBorders = this._geoCache.splitBorders;
    for (const sb of splitBorders) {
      const lw = sb.width_px;
      const bx = spreadRect.x + sb.rect.x;
      const by = spreadRect.y + sb.rect.y;
      ctx.save();
      ctx.strokeStyle = sb.color;
      ctx.lineWidth = lw;
      ctx.setLineDash([]);
      if (sb.position === 'inner') {
        ctx.strokeRect(bx + lw / 2, by + lw / 2, sb.rect.w - lw, sb.rect.h - lw);
      } else if (sb.position === 'outer') {
        ctx.strokeRect(bx - lw / 2, by - lw / 2, sb.rect.w + lw, sb.rect.h + lw);
      } else {
        ctx.strokeRect(bx, by, sb.rect.w, sb.rect.h);
      }
      ctx.restore();
    }

    const splitInfo = getSelectedSplitInfo(editor, spreadRect.w, spreadRect.h);
    if (splitInfo) {
      const sx = spreadRect.x + splitInfo.x;
      const sy = spreadRect.y + splitInfo.y;
      ctx.strokeStyle = SELECTED_COLOR;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(sx, sy, splitInfo.w, splitInfo.h);
      ctx.setLineDash([]);
    }

    if (marqueeRect) {
      const { x, y, w, h } = marqueeRect;
      const mx = spreadRect.x + x;
      const my = spreadRect.y + y;
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

    // Text elements — drawn after frames but before transform handles.
    const textElements = getTextElements(editor);
    this._textHits = [];
    for (const el of textElements) {
      this._drawTextElement(ctx, el, spreadRect, mmToPx, el.id === this.selectedTextId);
    }

    this._drawTransformBox(ctx, editor, spreadRect);
    this._drawGuides(ctx, spreadInfo, spreadRect, pageWPx, pageHPx, spinePx, mmToPx);

    if (this.showRulers) {
      drawRulers(ctx, cssW, cssH, spreadRect, spreadInfo, mmToPx, rulerOffset);
    }

    ctx.restore();
  }

  _drawFrame(
    ctx: CanvasRenderingContext2D,
    frame: RenderFrame,
    rx: number, ry: number, rw: number, rh: number,
    lowDpiMap: Map<number, number> | null,
    printDpi: number,
  ): void {
    const nodeRad = ((frame.node_rotation_deg ?? 0) * Math.PI) / 180;
    const hasNodeTransform = nodeRad !== 0;
    const fcx = rx + rw / 2;
    const fcy = ry + rh / 2;

    ctx.save();
    if (hasNodeTransform) {
      ctx.translate(fcx, fcy);
      ctx.rotate(-nodeRad);
      ctx.translate(-fcx, -fcy);
    }

    // Image (clipped to frame bounds).
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();

    if (frame.image_id && this.imageCache.has(frame.image_id)) {
      const img = this.imageCache.get(frame.image_id)!;
      this._drawImageCover(ctx, img, rx, ry, rw, rh, frame.pan_x, frame.pan_y, frame.object_fit, frame.scale, frame.rotation_deg);
    } else {
      this._drawEmptyFramePlaceholder(ctx, rx, ry, rw, rh);
    }

    ctx.restore();

    const hasBorder = frame.border_width > 0;
    if (hasBorder) {
      const lw = frame.border_width;
      ctx.save();
      ctx.strokeStyle = frame.border_color;
      ctx.lineWidth = lw;
      ctx.setLineDash([]);
      if (frame.border_position === 'inner') {
        ctx.strokeRect(rx + lw / 2, ry + lw / 2, rw - lw, rh - lw);
      } else if (frame.border_position === 'outer') {
        ctx.strokeRect(rx - lw / 2, ry - lw / 2, rw + lw, rh + lw);
      } else {
        ctx.strokeRect(rx, ry, rw, rh);
      }
      ctx.restore();
    }

    if (frame.is_selected) {
      ctx.strokeStyle = SELECTED_COLOR;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(rx, ry, rw, rh);
    } else if (frame.is_ancestor) {
      ctx.strokeStyle = ANCESTOR_COLOR;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
    } else if (!hasBorder && !frame.image_id) {
      ctx.strokeStyle = PLACEHOLDER_BORDER;
      ctx.lineWidth = 0.5;
      ctx.strokeRect(rx, ry, rw, rh);
    }

    if (lowDpiMap && lowDpiMap.has(frame.id)) {
      const effectiveDpi = lowDpiMap.get(frame.id)!;
      const { cx, cy } = this._drawDpiWarning(ctx, rx, ry, rw, rh);
      this._dpiBadges.push({ cx, cy, r: 8, effectiveDpi, printDpi });
    }

    ctx.restore(); // restore node transform
  }

  private _drawEmptyFramePlaceholder(
    ctx: CanvasRenderingContext2D,
    rx: number, ry: number, rw: number, rh: number,
  ): void {
    const BG = '#DDDFE4';
    const ICON_SIZE = 150; // px at which to render the SVG icon

    // Always fill the frame with the placeholder background colour first.
    ctx.fillStyle = BG;
    ctx.fillRect(rx, ry, rw, rh);

    if (!this._placeholderImg) return;

    // Draw the SVG centred, capped at ICON_SIZE, never stretched.
    const sz = Math.min(ICON_SIZE, rw, rh);
    const ix = rx + (rw - sz) / 2;
    const iy = ry + (rh - sz) / 2;
    ctx.drawImage(this._placeholderImg, ix, iy, sz, sz);
  }

  private _drawDpiWarning(
    ctx: CanvasRenderingContext2D,
    rx: number, ry: number, rw: number, rh: number,
  ): { cx: number; cy: number } {
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

  dpiBadgeAt(canvasX: number, canvasY: number): DpiBadge | null {
    for (const b of this._dpiBadges) {
      const dx = canvasX - b.cx;
      const dy = canvasY - b.cy;
      if (dx * dx + dy * dy <= (b.r + 3) * (b.r + 3)) return b;
    }
    return null;
  }

  _drawImageCover(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement | ImageBitmap,
    rx: number, ry: number, rw: number, rh: number,
    panX: number | undefined, panY: number | undefined,
    objectFit: ObjectFit,
    userScale: number | undefined,
    rotationDeg: number | undefined,
  ): void {
    if (objectFit === 'fill') {
      ctx.save();
      ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip();
      ctx.drawImage(img as CanvasImageSource, rx, ry, rw, rh);
      ctx.restore();
      return;
    }

    const iw = img instanceof ImageBitmap ? img.width  : img.naturalWidth;
    const ih = img instanceof ImageBitmap ? img.height : img.naturalHeight;
    if (!iw || !ih) return;

    const frameRatio = rw / rh;
    const imgRatio   = iw / ih;

    if (objectFit === 'contain') {
      let sw: number, sh: number;
      if (imgRatio > frameRatio) {
        sw = rw; sh = rw / imgRatio;
      } else {
        sh = rh; sw = rh * imgRatio;
      }
      const sx = rx + (rw - sw) / 2;
      const sy = ry + (rh - sh) / 2;
      ctx.save();
      ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip();
      ctx.drawImage(img as CanvasImageSource, sx, sy, sw, sh);
      ctx.restore();
      return;
    }

    // cover (default) with pan, scale, rotation
    const cov = computeImageCover(
      rw, rh, iw, ih,
      panX !== undefined ? panX : 0.5,
      panY !== undefined ? panY : 0.5,
      userScale ?? 1.0,
      rotationDeg ?? 0,
    );
    if (!cov) return;
    const { sw, sh, pan_off_x: panOffX, pan_off_y: panOffY } = cov;

    const rad = ((rotationDeg ?? 0) * Math.PI) / 180;
    const cx = rx + rw / 2;
    const cy = ry + rh / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-rad);
    ctx.drawImage(img as CanvasImageSource,
      -rw / 2 - panOffX,
      -rh / 2 - panOffY,
      sw, sh);
    ctx.restore();
  }

  private _getHatchPattern(ctx: CanvasRenderingContext2D): CanvasPattern {
    if (this._hatchPattern) return this._hatchPattern;
    const s = Math.ceil(8 * this.dpr);
    const off = document.createElement('canvas');
    off.width = s; off.height = s;
    const oc = off.getContext('2d')!;
    oc.strokeStyle = 'rgba(180, 50, 50, 0.22)';
    oc.lineWidth = Math.max(1, this.dpr * 0.75);
    oc.beginPath();
    oc.moveTo(0, s); oc.lineTo(s, 0);
    oc.stroke();
    this._hatchPattern = ctx.createPattern(off, 'repeat')!;
    return this._hatchPattern;
  }

  private _drawGuides(
    ctx: CanvasRenderingContext2D,
    spreadInfo: SpreadInfo,
    spreadRect: SpreadRect,
    pageWPx: number, pageHPx: number, spinePx: number, mmToPx: number,
  ): void {
    const top    = spreadRect.y;
    const bottom = spreadRect.y + pageHPx;
    const TICK   = 6;

    if (spreadInfo.kind === 'cover') {
      const spineLeft  = spreadRect.x + pageWPx;
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
      ctx.beginPath(); ctx.moveTo(spineLeft, top - TICK * 2); ctx.lineTo(spineLeft, top - TICK * 2 - 6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(spineRight, top - TICK * 2); ctx.lineTo(spineRight, top - TICK * 2 - 6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(spineLeft, top - TICK * 2 - 3); ctx.lineTo(spineRight, top - TICK * 2 - 3); ctx.stroke();

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
    } else {
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
      ctx.beginPath(); ctx.moveTo(foldX - 3, top - TICK * 2); ctx.lineTo(foldX + 3, top - TICK * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(foldX - 3, bottom + TICK * 2); ctx.lineTo(foldX + 3, bottom + TICK * 2); ctx.stroke();

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

  updateHover(
    editor: PhotobookEditor,
    canvasX: number, canvasY: number,
    spreadRect: SpreadRect,
  ): boolean {
    const relX = canvasX - spreadRect.x;
    const relY = canvasY - spreadRect.y;
    editor.set_mouse_pos(relX, relY);

    const hov = editor.hovered_divider(spreadRect.w, spreadRect.h);
    const newDivider = hov === 0xFFFFFFFF ? null : hov;

    let newMarginHandle: 'tl' | 'tr' | 'bl' | 'br' | null = null;
    let newRotationHandle = false;
    const handles = getSelectedTransformHandles(editor, spreadRect.w, spreadRect.h);
    if (handles) {
      for (const h of this._handlePositions(handles, spreadRect)) {
        const dx = canvasX - h.cx;
        const dy = canvasY - h.cy;
        if (dx * dx + dy * dy <= HANDLE_RADIUS * HANDLE_RADIUS) {
          newMarginHandle = h.side;
          break;
        }
      }
      if (!newMarginHandle) {
        const rh = this._rotationHandlePos(handles, spreadRect);
        const dx = canvasX - rh.x;
        const dy = canvasY - rh.y;
        if (dx * dx + dy * dy <= HANDLE_RADIUS * HANDLE_RADIUS) newRotationHandle = true;
      }
    }

    // Point-like handles take precedence over edge-like dividers.
    const effectiveDivider = (newMarginHandle !== null || newRotationHandle) ? null : newDivider;
    const newLeaf = editor.hit_test(relX, relY, spreadRect.w, spreadRect.h);
    const changed = effectiveDivider !== this.hoveredDivider
      || newMarginHandle !== this.hoveredMarginHandle
      || newRotationHandle !== this.hoveredRotationHandle
      || newLeaf !== this.hoveredLeaf;
    this.hoveredDivider = effectiveDivider;
    this.hoveredMarginHandle = newMarginHandle;
    this.hoveredRotationHandle = newRotationHandle;
    this.hoveredLeaf = newLeaf;
    return changed;
  }

  _rotationHandlePos(handles: TransformHandles, spreadRect: SpreadRect): { x: number; y: number } {
    const { outer } = handles;
    return {
      x: spreadRect.x + outer.x + outer.w / 2,
      y: spreadRect.y + outer.y - ROTATION_HANDLE_DIST,
    };
  }

  _handlePositions(handles: TransformHandles, spreadRect: SpreadRect): HandlePosition[] {
    const { inner } = handles;
    const ix = spreadRect.x + inner.x;
    const iy = spreadRect.y + inner.y;
    return [
      { side: 'tl', cx: ix,           cy: iy },
      { side: 'tr', cx: ix + inner.w, cy: iy },
      { side: 'bl', cx: ix,           cy: iy + inner.h },
      { side: 'br', cx: ix + inner.w, cy: iy + inner.h },
    ];
  }

  // ---------------------------------------------------------------------------
  // Text element rendering helpers
  // ---------------------------------------------------------------------------

  /** Rotate point (px, py) around (cx, cy) by rad radians (CCW in canvas space). */
  private _rotatePoint(px: number, py: number, cx: number, cy: number, rad: number): { x: number; y: number } {
    const dx = px - cx, dy = py - cy;
    return {
      x: cx + dx * Math.cos(rad) + dy * Math.sin(rad),
      y: cy - dx * Math.sin(rad) + dy * Math.cos(rad),
    };
  }

  _drawTextElement(
    ctx: CanvasRenderingContext2D,
    el: TextElement,
    spreadRect: SpreadRect,
    mmToPx: number,
    isSelected: boolean,
  ): void {
    const isInlineEditing = el.id === this.editingTextId;
    const rad = (el.rotation_deg * Math.PI) / 180;
    // 1 pt = 1/72 inch = 25.4/72 mm
    const fontPx = el.font_size_pt * (25.4 / 72) * mmToPx;
    const lineH  = fontPx * 1.2;

    const lines = (el.content || '').split('\n');
    const fontStyle = (el.italic ? 'italic ' : '') + (el.bold ? 'bold ' : '');
    ctx.font = `${fontStyle}${fontPx}px "${el.font_family}", sans-serif`;

    // Measure actual text extent so the handles match what the user sees.
    const lineWidths = lines.map(l => ctx.measureText(l || ' ').width);
    const textW = Math.max(...lineWidths, 1);  // canvas px
    const textH = lines.length * lineH;         // canvas px

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
      ctx.textAlign = (el.align || 'left') as CanvasTextAlign;

      let textX: number;
      if (el.align === 'center')      textX = ox + hw;
      else if (el.align === 'right')  textX = ox + textW;
      else                             textX = ox;

      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], textX, oy + i * lineH);
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
    const corners  = rawCorners.map(c => this._rotatePoint(c.x, c.y, cx, cy, rad));
    const rotHandle = this._rotatePoint(cx, cy - hh - ROTATION_HANDLE_DIST, cx, cy, rad);
    const hit: TextHitInfo = { id: el.id, cx, cy, hw, hh, rad, corners, rotHandle };
    this._textHits.push(hit);

    if (isSelected && !isInlineEditing) this._drawTextHandles(ctx, hit);
  }

  private _drawTextHandles(ctx: CanvasRenderingContext2D, hit: TextHitInfo): void {
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
  hitTestText(cx: number, cy: number): { id: number; part: 'body' | 'corner' | 'rotate'; cornerIndex?: number } | null {
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

  private _drawTransformBox(
    ctx: CanvasRenderingContext2D,
    editor: PhotobookEditor,
    spreadRect: SpreadRect,
  ): void {
    const handles = getSelectedTransformHandles(editor, spreadRect.w, spreadRect.h);
    if (!handles) return;

    const { outer, inner } = handles;
    const ox = spreadRect.x + outer.x;
    const oy = spreadRect.y + outer.y;
    const ix = spreadRect.x + inner.x;
    const iy = spreadRect.y + inner.y;

    ctx.save();

    const mTop    = inner.y - outer.y;
    const mBottom = outer.h - mTop - inner.h;
    const mLeft   = inner.x - outer.x;
    const mRight  = outer.w - mLeft - inner.w;
    if (mTop > 0 || mBottom > 0 || mLeft > 0 || mRight > 0) {
      ctx.fillStyle = TRANSFORM_FILL;
      if (mTop    > 0) ctx.fillRect(ox,           oy,           outer.w, mTop);
      if (mBottom > 0) ctx.fillRect(ox,           iy + inner.h, outer.w, mBottom);
      if (mLeft   > 0) ctx.fillRect(ox,           iy,           mLeft,   inner.h);
      if (mRight  > 0) ctx.fillRect(ix + inner.w, iy,           mRight,  inner.h);
    }

    ctx.strokeStyle = TRANSFORM_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(ix, iy, inner.w, inner.h);
    ctx.setLineDash([]);

    const positions = this._handlePositions(handles, spreadRect);
    for (const h of positions) {
      const isHovered = this.hoveredMarginHandle === h.side;
      const s = isHovered ? 7 : 5.5;
      ctx.fillStyle = TRANSFORM_COLOR;
      ctx.fillRect(h.cx - s / 2, h.cy - s / 2, s, s);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(h.cx - s / 2, h.cy - s / 2, s, s);
    }

    // Rotation handle — dashed stem from outer top-center, circle at tip.
    const rh = this._rotationHandlePos(handles, spreadRect);
    const stemBaseY = spreadRect.y + outer.y;
    ctx.strokeStyle = TRANSFORM_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.moveTo(rh.x, stemBaseY);
    ctx.lineTo(rh.x, rh.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const rotR = this.hoveredRotationHandle ? 7 : TEXT_HANDLE_RADIUS;
    ctx.beginPath();
    ctx.arc(rh.x, rh.y, rotR, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = TRANSFORM_COLOR;
    ctx.lineWidth = 2;
    ctx.stroke();
    // Small arc inside to indicate rotate.
    ctx.beginPath();
    ctx.arc(rh.x, rh.y, rotR * 0.45, -Math.PI * 0.75, Math.PI * 0.25);
    ctx.strokeStyle = TRANSFORM_COLOR;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  }

  toSpreadCoords(clientX: number, clientY: number, spreadRect: SpreadRect): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    return { x: cssX - spreadRect.x, y: cssY - spreadRect.y };
  }

  private _drawEdgeDragPreview(
    ctx: CanvasRenderingContext2D,
    sr: SpreadRect,
    preview: EdgeDragPreview,
  ): void {
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
    } else {
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

  private _drawCrossHandle(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    hovered: boolean,
  ): void {
    const R = 6;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx + R, cy);
    ctx.lineTo(cx, cy + R);
    ctx.lineTo(cx - R, cy);
    ctx.closePath();
    ctx.fillStyle = hovered ? 'rgba(240,160,48,0.9)' : 'rgba(240,160,48,0.55)';
    ctx.fill();
    ctx.strokeStyle = hovered ? '#f0a030' : 'rgba(240,160,48,0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  private _drawPinwheelSpawnHandle(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    hovered: boolean,
  ): void {
    const R = 7;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = hovered ? 'rgba(64,196,160,0.95)' : 'rgba(64,196,160,0.6)';
    ctx.fill();
    ctx.strokeStyle = hovered ? '#20c4a0' : 'rgba(32,180,140,0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Small cross inside to hint "add".
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy); ctx.lineTo(cx + 3, cy);
    ctx.moveTo(cx, cy - 3); ctx.lineTo(cx, cy + 3);
    ctx.stroke();
    ctx.restore();
  }

  private _drawEdgeHoverHint(
    ctx: CanvasRenderingContext2D,
    sr: SpreadRect,
    edge: 'top' | 'bottom' | 'left' | 'right',
  ): void {
    const STRIP = 3;
    ctx.save();
    ctx.fillStyle = 'rgba(74, 144, 226, 0.5)';
    switch (edge) {
      case 'top':    ctx.fillRect(sr.x, sr.y, sr.w, STRIP); break;
      case 'bottom': ctx.fillRect(sr.x, sr.y + sr.h - STRIP, sr.w, STRIP); break;
      case 'left':   ctx.fillRect(sr.x, sr.y, STRIP, sr.h); break;
      case 'right':  ctx.fillRect(sr.x + sr.w - STRIP, sr.y, STRIP, sr.h); break;
    }
    ctx.restore();
  }
}
