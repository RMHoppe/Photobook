// canvas-draw-rulers.ts — Ruler drawing helpers, extracted from CanvasRenderer.
// These functions are stateless and depend only on their parameters.

import type { SpreadRect, SpreadInfo } from './types.js';

const RULER_BG   = '#252525';
const RULER_TEXT = '#777';

export function drawRulers(
  ctx: CanvasRenderingContext2D,
  cssW: number, cssH: number,
  spreadRect: SpreadRect,
  spreadInfo: SpreadInfo,
  mmToPx: number,
  rulerOffset: number,
): void {
  const ox = spreadRect.x;
  const oy = spreadRect.y;

  ctx.fillStyle = RULER_BG;
  ctx.fillRect(0, 0, cssW, rulerOffset);
  ctx.fillRect(0, 0, rulerOffset, cssH);

  ctx.fillStyle = RULER_TEXT;
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'center';

  const stepMm = rulerStep(spreadInfo.width_mm, spreadRect.w / 100);
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
  const stepHMm = rulerStep(spreadInfo.height_mm, spreadRect.h / 100);
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

export function rulerStep(totalMm: number, desiredSteps: number): number {
  const raw = totalMm / desiredSteps;
  const nice = [1, 2, 5, 10, 20, 50, 100];
  return nice.find(s => s >= raw) ?? 100;
}
