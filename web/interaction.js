// interaction.js — Explicit interaction mode state machine for canvas mouse events.
//
// Each mode object implements:
//   onMouseDown(e, ctx) → void
//   onMouseMove(e, ctx) → void
//   onMouseUp(e, ctx)   → void
//   onMouseLeave(e, ctx)→ void
//   cursor(ctx)         → CSS cursor string (called during idle mousemove for hover feedback)
//
// `ctx` is the shared interaction context assembled in main.js and passed to every handler.
// Adding a new tool = adding a new mode object; existing modes are untouched.

import { NULL_ID } from './constants.js';

const MARGIN_HANDLE_CURSORS = {
  top: 'ns-resize', bottom: 'ns-resize',
  left: 'ew-resize', right: 'ew-resize',
};

// ---------------------------------------------------------------------------
// Idle mode — default; handles hover, selection, and transitions to other modes
// ---------------------------------------------------------------------------

export const idleMode = {
  onMouseDown(e, ctx) {
    const { editor, renderer, spreadRect, snapshot, refreshBoxModel, redraw,
            setMode, dividerDragMode, imagePanMode, marginDragMode, imageSwapMode } = ctx;
    const sr = spreadRect();
    const rect = ctx.canvasEl.getBoundingClientRect();
    const relX = (e.clientX - rect.left) - sr.x;
    const relY = (e.clientY - rect.top)  - sr.y;

    // Margin handle takes top priority (selected-node transform)
    if (renderer.hoveredMarginHandle !== null) {
      const side = renderer.hoveredMarginHandle;
      const bm = JSON.parse(editor.get_box_model());
      const startMarginMm = bm.margin[side];
      const spreadInfo = JSON.parse(editor.get_current_spread_info());
      const mmToPx = sr.w / spreadInfo.width_mm;
      const marginStepMm = editor.get_margin_step_mm();
      snapshot();
      setMode(marginDragMode, {
        side,
        startMouseX: relX, startMouseY: relY,
        startMarginMm, mmToPx, marginStepMm,
      });
      e.preventDefault();
      return;
    }

    // Divider drag (second priority)
    if (renderer.hoveredDivider !== null) {
      snapshot();
      editor.begin_divider_drag(renderer.hoveredDivider, sr.w, sr.h);
      setMode(dividerDragMode, { nodeId: renderer.hoveredDivider });
      e.preventDefault();
      return;
    }

    // Cmd/Ctrl + drag → image swap mode
    if (e.metaKey || e.ctrlKey) {
      editor.set_mouse_pos(relX, relY);
      const hitId = editor.hit_test(relX, relY, sr.w, sr.h);
      if (hitId !== NULL_ID) {
        renderer.swapOverlay = { sourceId: hitId, targetId: null };
        setMode(imageSwapMode, { sourceId: hitId, targetId: null });
        e.preventDefault();
        return;
      }
    }

    // Click outside the spread — deselect everything
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    if (cssX < sr.x || cssX > sr.x + sr.w || cssY < sr.y || cssY > sr.y + sr.h) {
      editor.select_node(NULL_ID);
      refreshBoxModel();
      redraw();
      return;
    }

    // Frame hit-test
    editor.set_mouse_pos(relX, relY);
    const hitId = editor.hit_test(relX, relY, sr.w, sr.h);
    if (hitId !== NULL_ID) {
      editor.select_node(hitId);
      refreshBoxModel();
      redraw();

      // Try to enter image-pan mode if the frame has a cached image
      const t = JSON.parse(editor.get_leaf_transform(hitId));
      if (t) {
        const renderList = JSON.parse(editor.get_render_list(sr.w, sr.h));
        const frame = renderList.find(f => f.id === hitId);
        if (frame && frame.image_id && renderer.imageCache.has(frame.image_id)) {
          const img = renderer.imageCache.get(frame.image_id);
          if (img && img.naturalWidth) {
            const iw = img.naturalWidth, ih = img.naturalHeight;
            const { w: rw, h: rh } = frame.rect;
            const frameRatio = rw / rh, imgRatio = iw / ih;
            const coverScale = imgRatio > frameRatio ? rh / ih : rw / iw;
            const rad = ((t.rotation_deg || 0) * Math.PI) / 180;
            const cosA = Math.abs(Math.cos(rad)), sinA = Math.abs(Math.sin(rad));
            const sw0 = iw * coverScale, sh0 = ih * coverScale;
            const rotFactor = Math.max((rw*cosA+rh*sinA)/sw0, (rw*sinA+rh*cosA)/sh0, 1.0);
            const totalFactor = rotFactor * Math.max(t.scale || 1.0, 1.0);
            const sw = iw * coverScale * totalFactor;
            const sh = ih * coverScale * totalFactor;
            snapshot();
            setMode(imagePanMode, {
              nodeId: hitId,
              startX: relX, startY: relY,
              startPanX: t.pan_x, startPanY: t.pan_y,
              overflowX: sw - rw, overflowY: sh - rh,
            });
            e.preventDefault();
          }
        }
      }
    }
  },

  onMouseMove(e, ctx) {
    const { editor, renderer, spreadRect, redraw, canvasEl } = ctx;
    const sr = spreadRect();
    const rect = canvasEl.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    editor.set_mouse_pos(cx - sr.x, cy - sr.y);

    const changed = renderer.updateHover(editor, cx, cy, sr);
    if (renderer.hoveredDivider !== null) {
      const divs = JSON.parse(editor.get_dividers(sr.w, sr.h));
      const div = divs.find(d => d.node_id === renderer.hoveredDivider);
      canvasEl.style.cursor = div ? (div.axis === 'v' ? 'col-resize' : 'row-resize') : 'default';
    } else if (renderer.hoveredMarginHandle !== null) {
      canvasEl.style.cursor = MARGIN_HANDLE_CURSORS[renderer.hoveredMarginHandle] || 'default';
    } else {
      canvasEl.style.cursor = 'default';
    }
    if (changed) redraw();
  },

  onMouseUp(_e, _ctx) {},

  onMouseLeave(_e, ctx) {
    const { renderer, redraw, canvasEl } = ctx;
    renderer.hoveredDivider = null;
    canvasEl.style.cursor = 'default';
    redraw();
  },
};

// ---------------------------------------------------------------------------
// Divider drag mode — resize a BSP split by dragging its divider line
// ---------------------------------------------------------------------------

export const dividerDragMode = {
  onMouseDown(_e, _ctx) {},

  onMouseMove(e, ctx) {
    const { editor, spreadRect, redraw, canvasEl } = ctx;
    const sr = spreadRect();
    const rect = canvasEl.getBoundingClientRect();
    const relX = (e.clientX - rect.left) - sr.x;
    const relY = (e.clientY - rect.top)  - sr.y;
    editor.update_divider_drag(relX, relY, sr.w, sr.h);
    redraw();
  },

  onMouseUp(_e, ctx) {
    const { editor, redraw, setMode, canvasEl } = ctx;
    editor.end_divider_drag();
    canvasEl.style.cursor = 'default';
    setMode(idleMode, {});
    redraw();
  },

  onMouseLeave(e, ctx) {
    this.onMouseUp(e, ctx);
  },
};

// ---------------------------------------------------------------------------
// Margin drag mode — drag a transform handle to adjust the margin on one side
// ---------------------------------------------------------------------------

export const marginDragMode = {
  onMouseDown(_e, _ctx) {},

  onMouseMove(e, ctx) {
    const { editor, spreadRect, refreshBoxModel, redraw, canvasEl, modeState } = ctx;
    const sr = spreadRect();
    const rect = canvasEl.getBoundingClientRect();
    const relX = (e.clientX - rect.left) - sr.x;
    const relY = (e.clientY - rect.top)  - sr.y;

    const { side, startMouseX, startMouseY, startMarginMm, mmToPx, marginStepMm } = modeState;

    // Delta in pixels → mm; direction depends on which side is being dragged
    let deltaPx;
    if (side === 'top')    deltaPx =  (relY - startMouseY);
    else if (side === 'bottom') deltaPx = -(relY - startMouseY);
    else if (side === 'left')  deltaPx =  (relX - startMouseX);
    else                       deltaPx = -(relX - startMouseX);

    let deltaMm = deltaPx / mmToPx;

    // Snap delta to step (relative, not on a grid)
    if (marginStepMm > 0) {
      deltaMm = Math.round(deltaMm / marginStepMm) * marginStepMm;
    }

    const newMarginMm = Math.max(0, startMarginMm + deltaMm);

    // Read current box model, update the one side, write back
    const bm = JSON.parse(editor.get_box_model());
    bm.margin[side] = newMarginMm;
    editor.set_node_margin(bm.margin.top, bm.margin.right, bm.margin.bottom, bm.margin.left);
    refreshBoxModel();
    redraw();
  },

  onMouseUp(_e, ctx) {
    const { setMode, canvasEl } = ctx;
    canvasEl.style.cursor = 'default';
    setMode(idleMode, {});
  },

  onMouseLeave(_e, ctx) {
    this.onMouseUp(_e, ctx);
  },
};

// ---------------------------------------------------------------------------
// Image swap mode — Cmd/Ctrl-drag to swap images between two frames
// ---------------------------------------------------------------------------

export const imageSwapMode = {
  onMouseDown(_e, _ctx) {},

  onMouseMove(e, ctx) {
    const { editor, renderer, spreadRect, redraw, canvasEl, modeState } = ctx;
    const sr = spreadRect();
    const rect = canvasEl.getBoundingClientRect();
    const relX = (e.clientX - rect.left) - sr.x;
    const relY = (e.clientY - rect.top)  - sr.y;

    editor.set_mouse_pos(relX, relY);
    const hitId = editor.hit_test(relX, relY, sr.w, sr.h);
    const targetId = (hitId !== NULL_ID && hitId !== modeState.sourceId) ? hitId : null;

    modeState.targetId = targetId;
    renderer.swapOverlay = { sourceId: modeState.sourceId, targetId };
    canvasEl.style.cursor = 'grabbing';
    redraw();
  },

  onMouseUp(_e, ctx) {
    const { editor, renderer, canvasEl, snapshot, refreshBoxModel, redraw, setMode } = ctx;
    const { sourceId, targetId } = ctx.modeState;
    if (targetId !== null) {
      snapshot();
      editor.swap_images(sourceId, targetId);
      refreshBoxModel();
    }
    renderer.swapOverlay = null;
    canvasEl.style.cursor = 'default';
    setMode(idleMode, {});
    redraw();
  },

  onMouseLeave(_e, ctx) {
    const { renderer, canvasEl, redraw, setMode } = ctx;
    renderer.swapOverlay = null;
    canvasEl.style.cursor = 'default';
    setMode(idleMode, {});
    redraw();
  },
};

// ---------------------------------------------------------------------------
// Split preview mode — shows a cut line before committing; click to confirm, Esc to cancel
// ---------------------------------------------------------------------------

export const splitPreviewMode = {
  onMouseDown(e, ctx) {
    if (e.button !== 0) return;
    const { editor, renderer, canvasEl, snapshot, refreshBoxModel, redraw, setMode } = ctx;
    const { axis, ratio } = ctx.modeState;
    if (axis !== null) {
      snapshot();
      editor.split_selected_at(axis, ratio);
      refreshBoxModel();
    }
    renderer.splitPreview = null;
    canvasEl.style.cursor = 'default';
    setMode(idleMode, {});
    redraw();
  },

  onMouseMove(e, ctx) {
    const { editor, renderer, spreadRect, redraw, canvasEl, modeState } = ctx;
    const sr = spreadRect();
    const rect = canvasEl.getBoundingClientRect();
    const relX = (e.clientX - rect.left) - sr.x;
    const relY = (e.clientY - rect.top)  - sr.y;

    editor.set_mouse_pos(relX, relY);

    const renderList = JSON.parse(editor.get_render_list(sr.w, sr.h));
    const frame = renderList.find(f => f.id === modeState.nodeId);
    if (!frame) return;

    const axis = editor.split_axis_hint(sr.w, sr.h);
    const { x: fx, y: fy, w: fw, h: fh } = frame.rect;
    const ratio = axis === 'v'
      ? Math.max(0.05, Math.min(0.95, (relX - fx) / fw))
      : Math.max(0.05, Math.min(0.95, (relY - fy) / fh));

    modeState.axis  = axis;
    modeState.ratio = ratio;
    renderer.splitPreview = { frameRect: frame.rect, axis, ratio };
    canvasEl.style.cursor = axis === 'v' ? 'col-resize' : 'row-resize';
    redraw();
  },

  onMouseUp(_e, _ctx) {},

  onMouseLeave(_e, ctx) {
    const { renderer, redraw, setMode, canvasEl } = ctx;
    renderer.splitPreview = null;
    canvasEl.style.cursor = 'default';
    setMode(idleMode, {});
    redraw();
  },
};

// ---------------------------------------------------------------------------
// Image pan mode — drag to reposition an image within its frame
// ---------------------------------------------------------------------------

export const imagePanMode = {
  onMouseDown(_e, _ctx) {},

  onMouseMove(e, ctx) {
    const { editor, spreadRect, redraw, canvasEl, modeState } = ctx;
    const sr = spreadRect();
    const rect = canvasEl.getBoundingClientRect();
    const relX = (e.clientX - rect.left) - sr.x;
    const relY = (e.clientY - rect.top)  - sr.y;

    const dx = relX - modeState.startX;
    const dy = relY - modeState.startY;
    const newPanX = modeState.overflowX > 0
      ? Math.max(0, Math.min(1, modeState.startPanX - dx / modeState.overflowX))
      : 0.5;
    const newPanY = modeState.overflowY > 0
      ? Math.max(0, Math.min(1, modeState.startPanY - dy / modeState.overflowY))
      : 0.5;

    const t = JSON.parse(editor.get_leaf_transform(modeState.nodeId));
    editor.set_image_transform(modeState.nodeId, newPanX, newPanY, t.scale, t.rotation_deg);
    canvasEl.style.cursor = 'grabbing';
    redraw();
  },

  onMouseUp(_e, ctx) {
    const { setMode, canvasEl } = ctx;
    canvasEl.style.cursor = 'default';
    setMode(idleMode, {});
  },

  onMouseLeave(e, ctx) {
    this.onMouseUp(e, ctx);
  },
};
