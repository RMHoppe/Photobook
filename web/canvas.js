// canvas.js — All 2D rendering for the double-page spread canvas.
// Receives data from the Wasm editor and draws using Canvas 2D API.

import { PAD, RULER_SIZE } from './constants.js';

const BLEED_COLOR = 'rgba(220, 50, 50, 0.35)';
const SAFE_COLOR  = 'rgba(0, 150, 255, 0.25)';
const FOLD_COLOR  = 'rgba(0, 180, 255, 0.85)';   // cyan guide line
const SPINE_COLOR = 'rgba(255, 160, 0, 0.85)';    // amber guide lines
const DIVIDER_HOVER_COLOR = '#aaa';
const SELECTED_COLOR = '#4a90e2';
const ANCESTOR_COLOR = 'rgba(74, 144, 226, 0.45)';
const GUTTER_COLOR = 'rgba(120,120,120,0.4)';
const RULER_BG = '#252525';
const RULER_TEXT = '#777';
const PLACEHOLDER_COLOR = '#2e2e2e';
const PLACEHOLDER_BORDER = '#444';
const TRANSFORM_COLOR = '#e8a020';        // amber for margin transform handles
const TRANSFORM_FILL  = 'rgba(232, 160, 32, 0.10)';
const HANDLE_RADIUS = 8; // CSS px hit zone radius for margin handles

export class CanvasRenderer {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.imageCache = new Map(); // id -> HTMLImageElement
    this.hoveredDivider = null;
    this.hoveredMarginHandle = null; // 'top' | 'right' | 'bottom' | 'left' | null
    this._hatchPattern = null;
    this.splitPreview = null;  // { frameRect:{x,y,w,h}, axis:'v'|'h', ratio:number }
    this.swapOverlay  = null;  // { sourceId:number, targetId:number|null }
    this.showBleed = true;
    this.showSafeZone = true;
    this.showRulers = true;
    this.zoom = 1.0;
  }

  /** Resize canvas to fill its CSS container. Called on init and window resize. */
  resize(cssW, cssH) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width  = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width  = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
  }

  /** Provide an image to the cache. */
  cacheImage(id, imgElement) {
    this.imageCache.set(id, imgElement);
  }

  /**
   * Compute the CSS rectangle occupied by the spread on the canvas.
   * Single source of truth — used by both draw() and main.js event handlers.
   */
  spreadRect(spreadInfo) {
    const rulerOffset = this.showRulers ? RULER_SIZE : 0;
    const availW = this.cssW - rulerOffset - PAD * 2;
    const availH = this.cssH - rulerOffset - PAD * 2;
    const spreadAspect = spreadInfo.width_mm / spreadInfo.height_mm;
    let fitW, fitH;
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

  /** Full redraw. editor is the Wasm PhotobookEditor instance. */
  draw(editor) {
    const { ctx, dpr, cssW, cssH } = this;
    if (!cssW || !cssH) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    // Background of the canvas area
    ctx.fillStyle = '#3c3c3c';
    ctx.fillRect(0, 0, cssW, cssH);

    const rulerOffset = this.showRulers ? RULER_SIZE : 0;
    const drawW = cssW - rulerOffset;
    const drawH = cssH - rulerOffset;

    // Spread info (kind, dimensions in mm, spine)
    const spreadInfo = JSON.parse(editor.get_current_spread_info());
    const bleedMm    = editor.get_bleed_mm();
    const safeZoneMm = editor.get_safe_zone_mm();

    // Fit spread into the area right/below the ruler band, with fixed padding.
    const spreadRect = this.spreadRect(spreadInfo);

    const mmToPx  = spreadRect.w / spreadInfo.width_mm;
    const pageWPx = spreadInfo.page_width_mm * mmToPx;
    const pageHPx = spreadRect.h;
    const spinePx = spreadInfo.spine_mm * mmToPx;
    const bleedPx = bleedMm * mmToPx;
    const safePx  = safeZoneMm * mmToPx;

    // --- White base: fill bleed extension and spread ---
    ctx.fillStyle = '#fff';
    ctx.fillRect(
      spreadRect.x - bleedPx, spreadRect.y - bleedPx,
      spreadRect.w + bleedPx * 2, spreadRect.h + bleedPx * 2
    );

    // --- Node background colours (tree-walk order: parents before children) ---
    const nodeBgs = JSON.parse(editor.get_node_backgrounds(spreadRect.w, spreadRect.h));
    for (const bg of nodeBgs) {
      ctx.fillStyle = bg.color;
      ctx.fillRect(spreadRect.x + bg.rect.x, spreadRect.y + bg.rect.y, bg.rect.w, bg.rect.h);
    }

    // Bleed outline
    if (this.showBleed) {
      ctx.strokeStyle = BLEED_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        spreadRect.x - bleedPx, spreadRect.y - bleedPx,
        spreadRect.w + bleedPx * 2, spreadRect.h + bleedPx * 2
      );
      ctx.setLineDash([]);
    }

    // Safe zone
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

    // --- Frames (leaves) ---
    const renderListJson = editor.get_render_list(spreadRect.w, spreadRect.h);
    const renderList = JSON.parse(renderListJson);

    // Clip all frame drawing (content + borders) to the bleed boundary so borders
    // on edge-touching frames don't extend past the bleed line.
    ctx.save();
    ctx.beginPath();
    ctx.rect(spreadRect.x - bleedPx, spreadRect.y - bleedPx,
             spreadRect.w + bleedPx * 2, spreadRect.h + bleedPx * 2);
    ctx.clip();

    for (const frame of renderList) {
      const rx = spreadRect.x + frame.rect.x;
      const ry = spreadRect.y + frame.rect.y;
      const rw = frame.rect.w;
      const rh = frame.rect.h;

      this._drawFrame(ctx, frame, rx, ry, rw, rh);
    }

    ctx.restore();

    // --- Bleed zone hatch (over images, clipped to donut) ---
    if (bleedPx > 0) {
      ctx.save();
      ctx.fillStyle = this._getHatchPattern(ctx);
      ctx.beginPath();
      ctx.rect(spreadRect.x - bleedPx, spreadRect.y - bleedPx,
               spreadRect.w + bleedPx * 2, spreadRect.h + bleedPx * 2);
      ctx.rect(spreadRect.x, spreadRect.y, spreadRect.w, spreadRect.h);
      ctx.fill('evenodd');
      ctx.restore();
    }

    // --- Split preview line ---
    if (this.splitPreview) {
      const { frameRect, axis, ratio } = this.splitPreview;
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
      if (axis === 'v') {
        const lx = fx + ratio * frameRect.w;
        ctx.moveTo(lx, fy);
        ctx.lineTo(lx, fy + frameRect.h);
      } else {
        const ly = fy + ratio * frameRect.h;
        ctx.moveTo(fx, ly);
        ctx.lineTo(fx + frameRect.w, ly);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // --- Image swap overlay ---
    if (this.swapOverlay) {
      const { sourceId, targetId } = this.swapOverlay;
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

    // --- Dividers ---
    const dividersJson = editor.get_dividers(spreadRect.w, spreadRect.h);
    const dividers = JSON.parse(dividersJson);

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

    // --- Selected split-node highlight ---
    const splitInfoJson = editor.get_selected_split_info(spreadRect.w, spreadRect.h);
    const splitInfo = JSON.parse(splitInfoJson);
    if (splitInfo) {
      const sx = spreadRect.x + splitInfo.x;
      const sy = spreadRect.y + splitInfo.y;
      ctx.strokeStyle = SELECTED_COLOR;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(sx, sy, splitInfo.w, splitInfo.h);
      ctx.setLineDash([]);
    }

    // --- Transform box (margin handles for selected node) ---
    this._drawTransformBox(ctx, editor, spreadRect);

    // --- Fold / spine guides (on top of frames) ---
    this._drawGuides(ctx, spreadInfo, spreadRect, pageWPx, pageHPx, spinePx, mmToPx);

    // --- Rulers ---
    if (this.showRulers) {
      this._drawRulers(ctx, cssW, cssH, spreadRect, spreadInfo, mmToPx, rulerOffset);
    }

    ctx.restore();
  }

  _drawFrame(ctx, frame, rx, ry, rw, rh) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();

    if (frame.image_id && this.imageCache.has(frame.image_id)) {
      const img = this.imageCache.get(frame.image_id);
      this._drawImageCover(ctx, img, rx, ry, rw, rh, frame.pan_x, frame.pan_y, frame.object_fit, frame.scale, frame.rotation_deg);
    } else {
      // Empty slot — fully transparent so background colour shows through.
      // Only draw a subtle plus icon to indicate a drop target.
      ctx.strokeStyle = 'rgba(160, 160, 160, 0.5)';
      ctx.lineWidth = 1.5;
      const cx = rx + rw / 2, cy = ry + rh / 2;
      const arm = Math.min(rw, rh) * 0.12;
      ctx.beginPath();
      ctx.moveTo(cx - arm, cy); ctx.lineTo(cx + arm, cy);
      ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy + arm);
      ctx.stroke();
    }

    ctx.restore();

    // Custom border from box model (drawn at full opacity, on top of content).
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

    // Selection / ancestor / default frame indicator.
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
  }

  _drawImageCover(ctx, img, rx, ry, rw, rh, panX, panY, objectFit, userScale, rotationDeg) {
    if (objectFit === 'fill') {
      ctx.save();
      ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip();
      ctx.drawImage(img, rx, ry, rw, rh);
      ctx.restore();
      return;
    }

    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return;

    const frameRatio = rw / rh;
    const imgRatio   = iw / ih;

    if (objectFit === 'contain') {
      let sw, sh;
      if (imgRatio > frameRatio) {
        sw = rw; sh = rw / imgRatio;
      } else {
        sh = rh; sw = rh * imgRatio;
      }
      const sx = rx + (rw - sw) / 2;
      const sy = ry + (rh - sh) / 2;
      ctx.save();
      ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip();
      ctx.drawImage(img, sx, sy, sw, sh);
      ctx.restore();
      return;
    }

    // --- cover (default) with pan, scale, rotation ---
    // 1. Base cover scale (ignoring rotation).
    const coverScale = imgRatio > frameRatio ? rh / ih : rw / iw;

    // 2. Rotation compensation: ensure rotated image still fully covers frame.
    const rad = ((rotationDeg || 0) * Math.PI) / 180;
    const cosA = Math.abs(Math.cos(rad));
    const sinA = Math.abs(Math.sin(rad));
    const sw0 = iw * coverScale;
    const sh0 = ih * coverScale;
    const rotFactor = Math.max(
      (rw * cosA + rh * sinA) / sw0,
      (rw * sinA + rh * cosA) / sh0,
      1.0
    );

    // 3. Total scale = base × rotation-compensation × user scale (≥ 1.0).
    const totalFactor = rotFactor * Math.max(userScale || 1.0, 1.0);
    const sw = iw * coverScale * totalFactor;
    const sh = ih * coverScale * totalFactor;

    // 4. Pan offsets (0.5 = centered, 0 = left/top edge, 1 = right/bottom edge).
    const overflowX = sw - rw; // ≥ 0
    const overflowY = sh - rh;
    const panOffX = overflowX * (panX !== undefined ? panX : 0.5);
    const panOffY = overflowY * (panY !== undefined ? panY : 0.5);

    // 5. Draw: rotate context around frame centre, then place image.
    const cx = rx + rw / 2;
    const cy = ry + rh / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-rad); // canvas rotate() is CW for positive values; negate for CCW
    // Image top-left relative to rotated frame centre:
    // centre the image then shift by pan offset, then offset by overflow to keep left/top alignment semantics.
    ctx.drawImage(img,
      -rw / 2 - panOffX,
      -rh / 2 - panOffY,
      sw, sh);
    ctx.restore();
  }

  _getHatchPattern(ctx) {
    if (this._hatchPattern) return this._hatchPattern;
    const s = Math.ceil(8 * this.dpr);
    const off = document.createElement('canvas');
    off.width = s; off.height = s;
    const oc = off.getContext('2d');
    oc.strokeStyle = 'rgba(180, 50, 50, 0.22)';
    oc.lineWidth = Math.max(1, this.dpr * 0.75);
    oc.beginPath();
    oc.moveTo(0, s); oc.lineTo(s, 0);
    oc.stroke();
    this._hatchPattern = ctx.createPattern(off, 'repeat');
    return this._hatchPattern;
  }

  _drawGuides(ctx, spreadInfo, spreadRect, pageWPx, pageHPx, spinePx, mmToPx) {
    const top    = spreadRect.y;
    const bottom = spreadRect.y + pageHPx;
    const TICK   = 6; // px tick outside spread edge

    if (spreadInfo.kind === 'cover') {
      // Two spine guide lines (left and right edge of spine)
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

      // Spine fill tint between the two lines
      ctx.fillStyle = 'rgba(255,160,0,0.08)';
      ctx.fillRect(spineLeft, top, spinePx, pageHPx);

      // Dimension callout: spine width in mm, centred above the spine
      const spineMmLabel = spreadInfo.spine_mm.toFixed(1) + ' mm';
      const midX = spineLeft + spinePx / 2;
      const labelY = top - TICK * 2 - 4;

      // Arrow ticks
      ctx.strokeStyle = SPINE_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      // Left tick cap
      ctx.beginPath(); ctx.moveTo(spineLeft, top - TICK * 2); ctx.lineTo(spineLeft, top - TICK * 2 - 6); ctx.stroke();
      // Right tick cap
      ctx.beginPath(); ctx.moveTo(spineRight, top - TICK * 2); ctx.lineTo(spineRight, top - TICK * 2 - 6); ctx.stroke();
      // Horizontal connector
      ctx.beginPath(); ctx.moveTo(spineLeft, top - TICK * 2 - 3); ctx.lineTo(spineRight, top - TICK * 2 - 3); ctx.stroke();

      // Label background
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const tw = ctx.measureText(spineMmLabel).width + 4;
      ctx.fillStyle = '#3c3c3c';
      ctx.fillRect(midX - tw / 2, labelY - 9, tw, 11);
      ctx.fillStyle = SPINE_COLOR;
      ctx.fillText(spineMmLabel, midX, labelY);

      // Rotated label inside spine (if wide enough)
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
      // Content spread: single fold guide at centre
      const foldX = spreadRect.x + spreadRect.w / 2;

      ctx.strokeStyle = FOLD_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(foldX, top - TICK * 2);
      ctx.lineTo(foldX, bottom + TICK * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Tick caps
      ctx.strokeStyle = FOLD_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(foldX - 3, top - TICK * 2); ctx.lineTo(foldX + 3, top - TICK * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(foldX - 3, bottom + TICK * 2); ctx.lineTo(foldX + 3, bottom + TICK * 2); ctx.stroke();

      // Label above
      const labelY = top - TICK * 2 - 4;
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const tw = ctx.measureText('Fold').width + 4;
      ctx.fillStyle = '#3c3c3c';
      ctx.fillRect(foldX - tw / 2, labelY - 9, tw, 11);
      ctx.fillStyle = FOLD_COLOR;
      ctx.fillText('Fold', foldX, labelY);
    }
  }

  _drawRulers(ctx, cssW, cssH, spreadRect, spreadInfo, mmToPx, rulerOffset) {
    const ox = spreadRect.x;
    const oy = spreadRect.y;

    ctx.fillStyle = RULER_BG;
    ctx.fillRect(0, 0, cssW, rulerOffset);  // full-width top ruler bar
    ctx.fillRect(0, 0, rulerOffset, cssH);  // full-height left ruler bar

    ctx.fillStyle = RULER_TEXT;
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';

    const stepMm = this._rulerStep(spreadInfo.width_mm, spreadRect.w / 100);
    for (let mm = 0; mm <= spreadInfo.width_mm; mm += stepMm) {
      const px = ox + mm * mmToPx;
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(px, rulerOffset - 4);
      ctx.lineTo(px, rulerOffset);
      ctx.stroke();
      if (mm % (stepMm * 2) === 0) {
        ctx.fillText(mm + 'mm', px, rulerOffset - 5);
      }
    }

    ctx.textAlign = 'right';
    const stepHMm = this._rulerStep(spreadInfo.height_mm, spreadRect.h / 100);
    for (let mm = 0; mm <= spreadInfo.height_mm; mm += stepHMm) {
      const py = oy + mm * mmToPx;
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(rulerOffset - 4, py);
      ctx.lineTo(rulerOffset, py);
      ctx.stroke();
      if (mm % (stepHMm * 2) === 0) {
        ctx.save();
        ctx.translate(rulerOffset - 5, py);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText(mm + '', 0, 0);
        ctx.restore();
      }
    }
  }

  _rulerStep(totalMm, desiredSteps) {
    const raw = totalMm / desiredSteps;
    const nice = [1, 2, 5, 10, 20, 50, 100];
    return nice.find(s => s >= raw) || 100;
  }

  /** Update hovered divider and margin handle state; returns true if anything changed. */
  updateHover(editor, canvasX, canvasY, spreadRect) {
    const relX = canvasX - spreadRect.x;
    const relY = canvasY - spreadRect.y;
    editor.set_mouse_pos(relX, relY);

    const hov = editor.hovered_divider(spreadRect.w, spreadRect.h);
    const newDivider = hov === 0xFFFFFFFF ? null : hov;

    // Margin handle proximity check
    let newMarginHandle = null;
    const handlesJson = editor.get_selected_transform_handles(spreadRect.w, spreadRect.h);
    const handles = JSON.parse(handlesJson);
    if (handles) {
      for (const h of this._handlePositions(handles, spreadRect)) {
        const dx = canvasX - h.cx;
        const dy = canvasY - h.cy;
        if (dx * dx + dy * dy <= HANDLE_RADIUS * HANDLE_RADIUS) {
          newMarginHandle = h.side;
          break;
        }
      }
    }

    const changed = newDivider !== this.hoveredDivider || newMarginHandle !== this.hoveredMarginHandle;
    this.hoveredDivider = newDivider;
    this.hoveredMarginHandle = newMarginHandle;
    return changed;
  }

  /**
   * Compute canvas-space positions of the 4 margin handles.
   * Handles sit on the edges of the *inner* (content) rect so dragging them
   * inward increases the margin on that side.
   */
  _handlePositions(handles, spreadRect) {
    const { inner } = handles;
    const ix = spreadRect.x + inner.x;
    const iy = spreadRect.y + inner.y;
    return [
      { side: 'top',    cx: ix + inner.w / 2, cy: iy },
      { side: 'bottom', cx: ix + inner.w / 2, cy: iy + inner.h },
      { side: 'left',   cx: ix,               cy: iy + inner.h / 2 },
      { side: 'right',  cx: ix + inner.w,     cy: iy + inner.h / 2 },
    ];
  }

  /** Draw the transform box (content-area boundary + 4 drag handles) for the selected node. */
  _drawTransformBox(ctx, editor, spreadRect) {
    const handlesJson = editor.get_selected_transform_handles(spreadRect.w, spreadRect.h);
    const handles = JSON.parse(handlesJson);
    if (!handles) return;

    const { outer, inner } = handles;
    const ox = spreadRect.x + outer.x;
    const oy = spreadRect.y + outer.y;
    const ix = spreadRect.x + inner.x;
    const iy = spreadRect.y + inner.y;

    ctx.save();

    // Margin shading bands between outer boundary and inner content area
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

    // Dashed outline around the inner (content) rect
    ctx.strokeStyle = TRANSFORM_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(ix, iy, inner.w, inner.h);
    ctx.setLineDash([]);

    // Handles at the midpoints of the inner rect edges
    const positions = this._handlePositions(handles, spreadRect);
    for (const h of positions) {
      const isHovered = this.hoveredMarginHandle === h.side;
      const r = isHovered ? 6 : 4.5;
      ctx.beginPath();
      ctx.arc(h.cx, h.cy, r, 0, Math.PI * 2);
      ctx.fillStyle = TRANSFORM_COLOR;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.restore();
  }

  /** Convert canvas-element-relative coords to spread-relative coords. */
  toSpreadCoords(clientX, clientY, spreadRect) {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = (clientX - rect.left);
    const cssY = (clientY - rect.top);
    return { x: cssX - spreadRect.x, y: cssY - spreadRect.y };
  }
}
