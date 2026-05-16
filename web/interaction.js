// interaction.ts — Explicit interaction mode state machine for canvas mouse events.
//
// Each mode object implements InteractionMode:
//   onMouseDown(e, ctx) → void
//   onMouseMove(e, ctx) → void
//   onMouseUp(e, ctx)   → void
//   onMouseLeave(e, ctx)→ void
//
// `ctx` is the shared interaction context assembled in main.ts. Key fields:
//   editor, renderer, overlays, canvasEl, toSpread, spreadRect,
//   snapshot, refreshBoxModel, redraw, setMode, <mode references>
//
// `toSpread(e)` converts a mouse event to spread-relative coords plus the sr rect:
//   { sr, relX, relY }
import { NULL_ID } from './constants.js';
import { computeImageCover, getRenderList, getDividers, getFrameTransform, getTransformBoxModel, getSpreadInfo, getSelectedTransformHandles, addTextElement, moveTextElement, updateTextElement, getTextElements } from './wasm-bridge.js';
const CORNER_DEFS = {
    tl: { m1: 'top', s1: +1, m2: 'left', s2: +1, o1: 'bottom', o2: 'right' },
    tr: { m1: 'top', s1: +1, m2: 'right', s2: -1, o1: 'bottom', o2: 'left' },
    bl: { m1: 'bottom', s1: -1, m2: 'left', s2: +1, o1: 'top', o2: 'right' },
    br: { m1: 'bottom', s1: -1, m2: 'right', s2: -1, o1: 'top', o2: 'left' },
};
// Tracks the currently hovered spread edge (for the new-split-at-root drag gesture).
let _hoveredEdge = null;
// When a twin handle is selected: chain rep ID and specific edge ID of the selected twin.
let _selectedTwinChainId = null;
let _selectedTwinEdgeId = null;
// ---------------------------------------------------------------------------
// Marquee selection mode
// ---------------------------------------------------------------------------
export const marqueeMode = {
    onMouseDown(_e, _ctx) { },
    onMouseMove(e, ctx) {
        const { overlays, redraw, modeState, toSpread } = ctx;
        const state = modeState;
        const { relX, relY } = toSpread(e);
        const x = Math.min(state.startX, relX);
        const y = Math.min(state.startY, relY);
        const w = Math.abs(relX - state.startX);
        const h = Math.abs(relY - state.startY);
        overlays.marqueeRect = { x, y, w, h };
        redraw();
    },
    onMouseUp(_e, ctx) {
        const { editor, overlays, spreadRect, refreshBoxModel, redraw, setMode, canvasEl, modeState } = ctx;
        const state = modeState;
        const sr = spreadRect();
        const rect = overlays.marqueeRect;
        const dragged = rect && (rect.w > 4 || rect.h > 4);
        if (dragged) {
            if (state.shiftKey) {
                editor.toggle_faces_in_rect(rect.x, rect.y, rect.w, rect.h, sr.w, sr.h);
            }
            else {
                editor.select_faces_in_rect(rect.x, rect.y, rect.w, rect.h, sr.w, sr.h);
            }
            refreshBoxModel();
        }
        else if (state.shiftKey) {
            const hitId = editor.hit_test(state.startX, state.startY, sr.w, sr.h);
            if (hitId !== 0xFFFFFFFF) {
                editor.toggle_selection(hitId);
                refreshBoxModel();
            }
        }
        overlays.marqueeRect = null;
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
        redraw();
    },
    onMouseLeave(_e, ctx) {
        const { overlays, redraw, setMode, canvasEl } = ctx;
        overlays.marqueeRect = null;
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
        redraw();
    },
};
const MARGIN_HANDLE_CURSORS = {
    tl: 'nwse-resize', tr: 'nesw-resize',
    bl: 'nesw-resize', br: 'nwse-resize',
};
// ---------------------------------------------------------------------------
// Idle mode
// ---------------------------------------------------------------------------
export const idleMode = {
    onMouseDown(e, ctx) {
        const { editor, renderer, overlays, toSpread, snapshot, refreshBoxModel, redraw, setMode } = ctx;
        const { sr, relX, relY, canvasX, canvasY } = toSpread(e);
        function handleRotationHandle() {
            const handles = getSelectedTransformHandles(editor, sr.w, sr.h);
            if (!handles)
                return;
            const { outer } = handles;
            const cx = sr.x + outer.x + outer.w / 2;
            const cy = sr.y + outer.y + outer.h / 2;
            const startAngle = Math.atan2(canvasY - cy, canvasX - cx);
            const bm = getTransformBoxModel(editor);
            snapshot();
            setMode(nodeRotateDragMode, {
                cx, cy, startAngle,
                startRotDeg: bm.face_rotation_deg ?? 0,
                hasMoved: false,
            });
            e.preventDefault();
        }
        function handleMarginHandle() {
            const corner = renderer.hoveredMarginHandle;
            const bm = getTransformBoxModel(editor);
            const startMargins = {
                top: bm.margin.top, right: bm.margin.right,
                bottom: bm.margin.bottom, left: bm.margin.left,
            };
            const spreadInfo = getSpreadInfo(editor);
            const mmToPx = sr.w / spreadInfo.width_mm;
            const marginStepMm = editor.get_margin_step_mm();
            snapshot();
            setMode(marginDragMode, {
                corner, startMouseX: relX, startMouseY: relY,
                startMargins, mmToPx, marginStepMm,
            });
            e.preventDefault();
        }
        function handleDividerHit() {
            const divId = renderer.hoveredDivider;
            if (renderer.twinSegmentSelected && divId === _selectedTwinChainId && _selectedTwinEdgeId !== null) {
                const selTh = renderer._twinHandles.find(h => h.edge_id === _selectedTwinEdgeId);
                if (selTh) {
                    const HIT_R = 8;
                    const onSegment = selTh.axis === 'v'
                        ? Math.abs(relX - selTh.x) < HIT_R && relY >= selTh.y - selTh.length / 2 && relY <= selTh.y + selTh.length / 2
                        : Math.abs(relY - selTh.y) < HIT_R && relX >= selTh.x - selTh.length / 2 && relX <= selTh.x + selTh.length / 2;
                    if (onSegment) {
                        // Clicking on the highlighted twin segment → drag it as a twin pair.
                        snapshot();
                        editor.begin_divider_drag(_selectedTwinEdgeId, false, sr.w, sr.h);
                        setMode(dividerDragMode, { nodeId: _selectedTwinEdgeId });
                        e.preventDefault();
                        return;
                    }
                }
                // Clicking elsewhere on the same chain → fall through to select the full chain.
            }
            _selectedTwinChainId = null;
            _selectedTwinEdgeId = null;
            renderer.twinSegmentSelected = false;
            if (e.metaKey || e.ctrlKey) {
                // cmd/ctrl+click — toggle this segment without clearing faces or texts.
                editor.toggle_segment(divId);
                refreshBoxModel();
                redraw();
                e.preventDefault();
                return;
            }
            // Plain click — select only this segment, clear faces and texts.
            renderer.selectedTextIds.clear();
            editor.select_segment(divId);
            refreshBoxModel();
            snapshot();
            editor.begin_divider_drag(divId, true, sr.w, sr.h);
            setMode(dividerDragMode, { nodeId: divId });
            e.preventDefault();
        }
        function handleImageSwapHit() {
            editor.set_mouse_pos(relX, relY);
            const hitId = editor.hit_test(relX, relY, sr.w, sr.h);
            if (hitId === NULL_ID)
                return false;
            overlays.swapOverlay = { sourceId: hitId, targetId: null };
            setMode(imageSwapMode, { sourceId: hitId, targetId: null });
            e.preventDefault();
            return true;
        }
        function handleTextHit() {
            const textHit = renderer.hitTestText(canvasX, canvasY);
            if (!textHit)
                return false;
            const el = getTextElements(editor).find(t => t.id === textHit.id);
            if (!el)
                return false;
            if (e.metaKey || e.ctrlKey) {
                // cmd/ctrl+click — toggle this text without clearing faces or segments.
                if (renderer.selectedTextIds.has(textHit.id)) {
                    renderer.selectedTextIds.delete(textHit.id);
                }
                else {
                    renderer.selectedTextIds.add(textHit.id);
                }
                refreshBoxModel();
                redraw();
                e.preventDefault();
                return true;
            }
            // Plain click — select only this text, clear faces and segments.
            editor.select_face(NULL_ID); // clears faces + segments
            renderer.selectedTextIds = new Set([textHit.id]);
            ctx.onTextSelected?.(textHit.id);
            const mmToPx = sr.w / getSpreadInfo(editor).width_mm;
            if (textHit.part === 'rotate') {
                const hit = renderer._textHits.find(h => h.id === textHit.id);
                const angle = Math.atan2(canvasY - hit.cy, canvasX - hit.cx);
                setMode(textRotateMode, {
                    el, cx: hit.cx, cy: hit.cy,
                    startAngle: angle, startRot: el.rotation_deg, hasMoved: false,
                });
            }
            else if (textHit.part === 'corner') {
                const hit2 = renderer._textHits.find(h => h.id === textHit.id);
                const ci = textHit.cornerIndex;
                // Corner local-space signs: 0=TL(-,-), 1=TR(+,-), 2=BR(+,+), 3=BL(-,+)
                const cornerSigns = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
                const [sdx, sdy] = cornerSigns[ci]; // dragged corner signs
                const sfx = -sdx, sfy = -sdy; // fixed (opposite) corner signs
                const θ = el.rotation_deg * Math.PI / 180;
                const cos_t = Math.cos(θ), sin_t = Math.sin(θ);
                const hw = hit2.hw, hh = hit2.hh;
                // Fixed corner in canvas px (canvas rotation: x'=x·cos-y·sin, y'=x·sin+y·cos)
                const fx = hit2.cx + sfx * hw * cos_t - sfy * hh * sin_t;
                const fy = hit2.cy + sfx * hw * sin_t + sfy * hh * cos_t;
                // Direction vector from fixed corner to dragged corner at scale=1
                const ddx = -2 * sfx * hw * cos_t + 2 * sfy * hh * sin_t;
                const ddy = -2 * sfx * hw * sin_t - 2 * sfy * hh * cos_t;
                setMode(textResizeMode, {
                    el, cornerIndex: ci, fx, fy, ddx, ddy, d2: ddx * ddx + ddy * ddy,
                    hw0: hw, hh0: hh, sign_fx: sfx, sign_fy: sfy, cos_t, sin_t,
                    startFontSize: el.font_size_pt, mmToPx, srX: sr.x, srY: sr.y, hasMoved: false,
                });
            }
            else {
                setMode(textDragMode, {
                    el, startMouseX: relX, startMouseY: relY,
                    startX: el.x_mm, startY: el.y_mm, mmToPx, hasMoved: false,
                });
            }
            redraw();
            e.preventDefault();
            return true;
        }
        function handleLeafHit() {
            editor.set_mouse_pos(relX, relY);
            const insideSpread = relX >= 0 && relX <= sr.w && relY >= 0 && relY <= sr.h;
            const hitId = insideSpread ? editor.hit_test(relX, relY, sr.w, sr.h) : NULL_ID;
            if (hitId !== NULL_ID) {
                if (e.metaKey || e.ctrlKey) {
                    // cmd/ctrl+click — toggle this face without clearing segments or texts.
                    editor.toggle_selection(hitId);
                    refreshBoxModel();
                    redraw();
                    e.preventDefault();
                    return;
                }
                // Plain click — clear texts and segments, select only this face.
                renderer.selectedTextIds.clear();
                if (!editor.is_selected(hitId) || editor.get_selection_count() > 1 || editor.get_selected_segment() !== NULL_ID) {
                    editor.select_face(hitId);
                    refreshBoxModel();
                    redraw();
                }
                const t = getFrameTransform(editor, hitId);
                if (t) {
                    const frame = getRenderList(editor, sr.w, sr.h).find(f => f.id === hitId);
                    if (frame && frame.image_id && renderer.imageCache.has(frame.image_id)) {
                        const img = renderer.imageCache.get(frame.image_id);
                        const iw = img instanceof ImageBitmap ? img.width : img.naturalWidth;
                        const ih = img instanceof ImageBitmap ? img.height : img.naturalHeight;
                        if (img && iw) {
                            const { w: rw, h: rh } = frame.rect;
                            const cov = computeImageCover(rw, rh, iw, ih, t.pan_x, t.pan_y, t.scale ?? 1.0, t.rotation_deg ?? 0);
                            if (!cov)
                                return;
                            setMode(imagePanMode, {
                                nodeId: hitId, startX: relX, startY: relY,
                                startPanX: t.pan_x, startPanY: t.pan_y,
                                overflowX: cov.overflow_x, overflowY: cov.overflow_y, hasMoved: false,
                            });
                            e.preventDefault();
                        }
                    }
                }
            }
            else {
                editor.select_face(NULL_ID); // clears faces + segments
                renderer.selectedTextIds.clear();
                refreshBoxModel();
                redraw();
                setMode(marqueeMode, { startX: relX, startY: relY, shiftKey: false });
                ctx.canvasEl.style.cursor = 'crosshair';
                e.preventDefault();
            }
        }
        function handleEdgeHit() {
            const edge = _hoveredEdge;
            const axis = (edge === 'top' || edge === 'bottom') ? 'h' : 'v';
            const newIsFirst = edge === 'top' || edge === 'left';
            snapshot();
            setMode(edgeLiveDragMode, { edge, axis, newIsFirst, spawned: false, segmentId: NULL_ID });
            e.preventDefault();
        }
        if (_hoveredEdge !== null) {
            handleEdgeHit();
            return;
        }
        // X-junction handle → begin pinwheel spawn drag.
        if (renderer.hoveredXJunction !== null) {
            const jx = renderer.hoveredXJunction;
            snapshot();
            editor.begin_pinwheel_spawn(jx.tl_id, jx.tr_id, jx.bl_id, jx.br_id, jx.nx, jx.ny);
            setMode(pinwheelSpawnMode, { junction: jx, spreadRect: sr });
            e.preventDefault();
            return;
        }
        if (renderer.hoveredTwinHandle !== null) {
            const th = renderer.hoveredTwinHandle;
            editor.select_segment(th.edge_id);
            renderer.twinSegmentSelected = true;
            _selectedTwinChainId = renderer.hoveredDivider;
            _selectedTwinEdgeId = th.edge_id;
            refreshBoxModel();
            snapshot();
            editor.begin_divider_drag(th.edge_id, false, sr.w, sr.h);
            setMode(dividerDragMode, { nodeId: th.edge_id });
            e.preventDefault();
            return;
        }
        if (renderer.hoveredRotationHandle) {
            handleRotationHandle();
            return;
        }
        if (renderer.hoveredMarginHandle !== null) {
            handleMarginHandle();
            return;
        }
        if (renderer.hoveredDivider !== null) {
            handleDividerHit();
            return;
        }
        if (e.altKey && handleImageSwapHit())
            return;
        if (handleTextHit())
            return;
        if (e.shiftKey) {
            setMode(marqueeMode, { startX: relX, startY: relY, shiftKey: true });
            ctx.canvasEl.style.cursor = 'crosshair';
            e.preventDefault();
            return;
        }
        handleLeafHit();
    },
    onMouseMove(e, ctx) {
        const { editor, renderer, spreadRect, redraw, canvasEl } = ctx;
        const sr = spreadRect();
        const rect = canvasEl.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        editor.set_mouse_pos(cx - sr.x, cy - sr.y);
        const changed = renderer.updateHover(editor, cx, cy, sr);
        // Twin handle hit test (uses cached handles from last draw).
        const TWIN_HIT_R = 11;
        let newTwinHover = null;
        for (const th of renderer._twinHandles) {
            const dx = cx - (sr.x + th.x);
            const dy = cy - (sr.y + th.y);
            if (dx * dx + dy * dy <= TWIN_HIT_R * TWIN_HIT_R) {
                newTwinHover = th;
                break;
            }
        }
        const twinChanged = (newTwinHover !== null) !== (renderer.hoveredTwinHandle !== null) ||
            (newTwinHover !== null && renderer.hoveredTwinHandle !== null &&
                newTwinHover.edge_id !== renderer.hoveredTwinHandle.edge_id);
        renderer.hoveredTwinHandle = newTwinHover;
        // X-junction handle hit test.
        const newXJunction = renderer.xJunctionAt(cx, cy, sr);
        const xjChanged = (newXJunction !== null) !== (renderer.hoveredXJunction !== null) ||
            (newXJunction !== null && renderer.hoveredXJunction !== null &&
                newXJunction.tl_id !== renderer.hoveredXJunction.tl_id);
        renderer.hoveredXJunction = newXJunction;
        // Detect hover within EDGE_THRESHOLD px outside each spread edge.
        const EDGE_THRESHOLD = 20;
        const rawX = cx - sr.x;
        const rawY = cy - sr.y;
        let edgeHit = null;
        if (rawX >= 0 && rawX <= sr.w && rawY >= -EDGE_THRESHOLD && rawY < 0)
            edgeHit = 'top';
        else if (rawX >= 0 && rawX <= sr.w && rawY > sr.h && rawY <= sr.h + EDGE_THRESHOLD)
            edgeHit = 'bottom';
        else if (rawY >= 0 && rawY <= sr.h && rawX >= -EDGE_THRESHOLD && rawX < 0)
            edgeHit = 'left';
        else if (rawY >= 0 && rawY <= sr.h && rawX > sr.w && rawX <= sr.w + EDGE_THRESHOLD)
            edgeHit = 'right';
        const edgeChanged = edgeHit !== _hoveredEdge;
        _hoveredEdge = edgeHit;
        renderer.hoveredEdge = edgeHit;
        if (renderer.hoveredTwinHandle !== null) {
            canvasEl.style.cursor = 'pointer';
        }
        else if (renderer.hoveredXJunction !== null) {
            canvasEl.style.cursor = 'crosshair';
        }
        else if (renderer.hoveredRotationHandle) {
            canvasEl.style.cursor = 'grab';
        }
        else if (renderer.hoveredMarginHandle !== null) {
            canvasEl.style.cursor = MARGIN_HANDLE_CURSORS[renderer.hoveredMarginHandle] ?? 'default';
        }
        else if (renderer.hoveredDivider !== null) {
            const divs = getDividers(editor, sr.w, sr.h);
            const div = divs.find(d => d.segment_id === renderer.hoveredDivider);
            canvasEl.style.cursor = div ? (div.axis === 'v' ? 'col-resize' : 'row-resize') : 'default';
        }
        else if (edgeHit) {
            canvasEl.style.cursor = (edgeHit === 'top' || edgeHit === 'bottom') ? 'n-resize' : 'ew-resize';
        }
        else {
            // Show I-beam cursor over text elements to hint they are double-click editable.
            const textHit = renderer.hitTestText(cx, cy);
            canvasEl.style.cursor = textHit ? 'text' : 'default';
        }
        if (changed || edgeChanged || twinChanged || xjChanged)
            redraw();
    },
    onMouseUp(_e, _ctx) { },
    onMouseLeave(_e, ctx) {
        const { renderer, redraw, canvasEl } = ctx;
        renderer.hoveredDivider = null;
        renderer.hoveredEdge = null;
        renderer.hoveredTwinHandle = null;
        renderer.hoveredXJunction = null;
        _hoveredEdge = null;
        canvasEl.style.cursor = 'default';
        redraw();
    },
};
// ---------------------------------------------------------------------------
// Divider drag mode
// ---------------------------------------------------------------------------
export const dividerDragMode = {
    onMouseDown(_e, _ctx) { },
    onMouseMove(e, ctx) {
        const { editor, toSpread, refreshBoxModel, redraw } = ctx;
        const { sr, relX, relY } = toSpread(e);
        editor.set_snap_disabled(e.altKey);
        editor.update_divider_drag(relX, relY, sr.w, sr.h);
        refreshBoxModel();
        redraw();
    },
    onMouseUp(_e, ctx) {
        const { editor, spreadRect, refreshBoxModel, redraw, setMode, canvasEl } = ctx;
        const sr = spreadRect();
        editor.set_snap_disabled(false);
        editor.end_divider_drag(sr.w, sr.h);
        refreshBoxModel();
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
        redraw();
    },
    onMouseLeave(e, ctx) {
        dividerDragMode.onMouseUp(e, ctx);
    },
};
// ---------------------------------------------------------------------------
// Margin drag mode
// ---------------------------------------------------------------------------
export const marginDragMode = {
    onMouseDown(_e, _ctx) { },
    onMouseMove(e, ctx) {
        const { editor, toSpread, refreshBoxModel, redraw, modeState } = ctx;
        const { relX, relY } = toSpread(e);
        const state = modeState;
        const { corner, startMouseX, startMouseY, startMargins, mmToPx, marginStepMm } = state;
        const def = CORNER_DEFS[corner];
        // Raw pixel displacement converted to mm deltas for each primary margin.
        let d1 = (relY - startMouseY) * def.s1 / mmToPx;
        let d2 = (relX - startMouseX) * def.s2 / mmToPx;
        if (marginStepMm > 0) {
            d1 = Math.round(d1 / marginStepMm) * marginStepMm;
            d2 = Math.round(d2 / marginStepMm) * marginStepMm;
        }
        const margins = { ...startMargins };
        const clamp = (v) => Math.max(0, v);
        if (e.shiftKey && e.altKey) {
            // Largest displacement only, plus its opposite.
            if (Math.abs(d1) >= Math.abs(d2)) {
                margins[def.m1] = clamp(startMargins[def.m1] + d1);
                margins[def.o1] = clamp(startMargins[def.o1] + d1);
            }
            else {
                margins[def.m2] = clamp(startMargins[def.m2] + d2);
                margins[def.o2] = clamp(startMargins[def.o2] + d2);
            }
        }
        else if (e.shiftKey) {
            // Largest displacement only.
            if (Math.abs(d1) >= Math.abs(d2)) {
                margins[def.m1] = clamp(startMargins[def.m1] + d1);
            }
            else {
                margins[def.m2] = clamp(startMargins[def.m2] + d2);
            }
        }
        else if (e.altKey) {
            // Both primary margins and their opposites.
            margins[def.m1] = clamp(startMargins[def.m1] + d1);
            margins[def.m2] = clamp(startMargins[def.m2] + d2);
            margins[def.o1] = clamp(startMargins[def.o1] + d1);
            margins[def.o2] = clamp(startMargins[def.o2] + d2);
        }
        else {
            // Default: both primary margins.
            margins[def.m1] = clamp(startMargins[def.m1] + d1);
            margins[def.m2] = clamp(startMargins[def.m2] + d2);
        }
        editor.set_node_margin(margins.top, margins.right, margins.bottom, margins.left);
        refreshBoxModel();
        redraw();
    },
    onMouseUp(_e, ctx) {
        const { setMode, canvasEl } = ctx;
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
    },
    onMouseLeave(e, ctx) {
        marginDragMode.onMouseUp(e, ctx);
    },
};
// ---------------------------------------------------------------------------
// Node rotation drag mode — horizontal drag rotates the transform-target node.
// Drag right = clockwise (face_rotation_deg is CCW positive, so right drag subtracts).
// ---------------------------------------------------------------------------
export const nodeRotateDragMode = {
    onMouseDown(_e, _ctx) { },
    onMouseMove(e, ctx) {
        const { editor, toSpread, refreshBoxModel, redraw, canvasEl, modeState } = ctx;
        const { canvasX, canvasY } = toSpread(e);
        const state = modeState;
        const angle = Math.atan2(canvasY - state.cy, canvasX - state.cx);
        const delta = -(angle - state.startAngle) * (180 / Math.PI);
        if (!state.hasMoved) {
            if (Math.abs(delta) < 1)
                return;
            state.hasMoved = true;
        }
        editor.set_face_rotation_deg(state.startRotDeg + delta);
        canvasEl.style.cursor = 'crosshair';
        refreshBoxModel();
        redraw();
    },
    onMouseUp(_e, ctx) {
        ctx.canvasEl.style.cursor = 'default';
        ctx.setMode(idleMode, {});
    },
    onMouseLeave(e, ctx) { nodeRotateDragMode.onMouseUp(e, ctx); },
};
// ---------------------------------------------------------------------------
// Image swap mode
// ---------------------------------------------------------------------------
export const imageSwapMode = {
    onMouseDown(_e, _ctx) { },
    onMouseMove(e, ctx) {
        const { editor, overlays, toSpread, redraw, canvasEl, modeState } = ctx;
        const state = modeState;
        const { sr, relX, relY } = toSpread(e);
        editor.set_mouse_pos(relX, relY);
        const hitId = editor.hit_test(relX, relY, sr.w, sr.h);
        const targetId = (hitId !== NULL_ID && hitId !== state.sourceId) ? hitId : null;
        state.targetId = targetId;
        overlays.swapOverlay = { sourceId: state.sourceId, targetId };
        canvasEl.style.cursor = 'grabbing';
        redraw();
    },
    onMouseUp(_e, ctx) {
        const { editor, overlays, canvasEl, snapshot, refreshBoxModel, redraw, setMode } = ctx;
        const state = ctx.modeState;
        if (state.targetId !== null) {
            snapshot();
            editor.swap_images(state.sourceId, state.targetId);
            refreshBoxModel();
        }
        overlays.swapOverlay = null;
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
        redraw();
    },
    onMouseLeave(_e, ctx) {
        const { overlays, canvasEl, redraw, setMode } = ctx;
        overlays.swapOverlay = null;
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
        redraw();
    },
};
// ---------------------------------------------------------------------------
// Edge drag mode — drag inward from a spread edge to insert a new split at root
// ---------------------------------------------------------------------------
export const edgeLiveDragMode = {
    onMouseDown(_e, _ctx) { },
    onMouseMove(e, ctx) {
        const { editor, overlays, toSpread, redraw, canvasEl, modeState } = ctx;
        const state = modeState;
        const { relX, relY, sr } = toSpread(e);
        const MIN_SPAWN_PX = 8;
        const newIsFirst = state.edge === 'top' || state.edge === 'left';
        const distFromEdge = state.edge === 'top' ? relY :
            state.edge === 'bottom' ? sr.h - relY :
                state.edge === 'left' ? relX :
                    sr.w - relX;
        if (!state.spawned) {
            if (distFromEdge >= MIN_SPAWN_PX) {
                const segmentId = editor.begin_edge_panel_drag(state.axis, state.newIsFirst, relX, relY, sr.w, sr.h);
                if (segmentId !== NULL_ID) {
                    state.spawned = true;
                    state.segmentId = segmentId;
                    overlays.edgeDragPreview = null;
                }
            }
            else {
                // Ghost preview before threshold — show where the panel edge will appear.
                const ratio = state.axis === 'h'
                    ? Math.max(0.01, Math.min(0.99, relY / sr.h))
                    : Math.max(0.01, Math.min(0.99, relX / sr.w));
                overlays.edgeDragPreview = { axis: state.axis, ratio, newIsFirst };
                canvasEl.style.cursor = state.axis === 'h' ? 'row-resize' : 'col-resize';
                redraw();
                return;
            }
        }
        editor.set_snap_disabled(e.altKey);
        editor.update_edge_panel_drag(relX, relY, sr.w, sr.h);
        canvasEl.style.cursor = state.axis === 'h' ? 'row-resize' : 'col-resize';
        redraw();
    },
    onMouseUp(_e, ctx) {
        const { editor, overlays, refreshBoxModel, redraw, setMode, canvasEl } = ctx;
        const state = ctx.modeState;
        editor.set_snap_disabled(false);
        if (state.spawned) {
            editor.end_edge_panel_drag();
            refreshBoxModel();
        }
        overlays.edgeDragPreview = null;
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
        redraw();
    },
    onMouseLeave(_e, ctx) {
        const { editor, overlays, redraw, setMode, canvasEl } = ctx;
        const state = ctx.modeState;
        editor.set_snap_disabled(false);
        if (state.spawned) {
            editor.end_edge_panel_drag();
        }
        overlays.edgeDragPreview = null;
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
        redraw();
    },
};
// ---------------------------------------------------------------------------
// Split preview mode
// ---------------------------------------------------------------------------
export const splitPreviewMode = {
    onMouseDown(e, ctx) {
        if (e.button !== 0)
            return;
        const { editor, overlays, canvasEl, snapshot, refreshBoxModel, redraw, setMode } = ctx;
        const state = ctx.modeState;
        if (state.axis === 'quadrant') {
            snapshot();
            editor.split_face_into_quadrant_n(state.nodeId, state.numCuts + 1);
            refreshBoxModel();
        }
        else if (state.axis !== null && state.numCuts > 1) {
            snapshot();
            editor.split_face_into_n(state.nodeId, state.axis, state.numCuts + 1);
            refreshBoxModel();
        }
        else if (state.axis !== null && state.ratio !== null) {
            snapshot();
            editor.split_face_at(state.nodeId, state.axis, state.ratio);
            refreshBoxModel();
        }
        overlays.splitPreview = null;
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
        redraw();
    },
    onMouseMove(e, ctx) {
        const { editor, overlays, toSpread, redraw, canvasEl, modeState } = ctx;
        const state = modeState;
        const { sr, relX, relY } = toSpread(e);
        editor.set_mouse_pos(relX, relY);
        const renderList = getRenderList(editor, sr.w, sr.h);
        const frame = renderList.find(f => f.id === state.nodeId);
        if (!frame)
            return;
        const { x: fx, y: fy, w: fw, h: fh } = frame.rect;
        const relXInFrame = (relX - fx) / fw;
        const relYInFrame = (relY - fy) / fh;
        const QUADRANT_ZONE = 0.10;
        const nearCenterX = Math.abs(relXInFrame - 0.5) < QUADRANT_ZONE;
        const nearCenterY = Math.abs(relYInFrame - 0.5) < QUADRANT_ZONE;
        if (nearCenterX && nearCenterY) {
            state.axis = 'quadrant';
            state.ratio = 0.5;
            overlays.splitPreview = { frameRect: frame.rect, axis: 'quadrant', ratio: 0.5, numCuts: state.numCuts };
            canvasEl.style.cursor = 'crosshair';
        }
        else {
            const axis = editor.split_axis_hint_for(state.nodeId, sr.w, sr.h);
            const SNAP_PX = 8;
            let ratio = axis === 'v'
                ? Math.max(0.05, Math.min(0.95, relXInFrame))
                : Math.max(0.05, Math.min(0.95, relYInFrame));
            const snapThreshold = SNAP_PX / (axis === 'v' ? fw : fh);
            if (!e.altKey && Math.abs(ratio - 0.5) < snapThreshold)
                ratio = 0.5;
            state.axis = axis;
            state.ratio = ratio;
            overlays.splitPreview = { frameRect: frame.rect, axis, ratio, numCuts: state.numCuts };
            canvasEl.style.cursor = axis === 'v' ? 'col-resize' : 'row-resize';
        }
        redraw();
    },
    onMouseUp(_e, _ctx) { },
    onMouseLeave(_e, ctx) {
        const { overlays, redraw, setMode, canvasEl } = ctx;
        overlays.splitPreview = null;
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
        redraw();
    },
    onWheel(e, ctx) {
        e.preventDefault();
        const state = ctx.modeState;
        if (e.deltaY < 0) {
            state.numCuts = Math.min(state.numCuts + 1, 12);
        }
        else {
            state.numCuts = Math.max(1, state.numCuts - 1);
        }
        if (ctx.overlays.splitPreview) {
            ctx.overlays.splitPreview = { ...ctx.overlays.splitPreview, numCuts: state.numCuts };
        }
        ctx.redraw();
    },
};
// ---------------------------------------------------------------------------
// Image pan mode
// ---------------------------------------------------------------------------
export const imagePanMode = {
    onMouseDown(_e, _ctx) { },
    onMouseMove(e, ctx) {
        const { editor, toSpread, redraw, canvasEl, modeState, snapshot } = ctx;
        const state = modeState;
        const { relX, relY } = toSpread(e);
        const dx = relX - state.startX;
        const dy = relY - state.startY;
        if (!state.hasMoved) {
            if (Math.abs(dx) < 3 && Math.abs(dy) < 3)
                return;
            snapshot();
            state.hasMoved = true;
        }
        const newPanX = state.overflowX > 0
            ? Math.max(0, Math.min(1, state.startPanX - dx / state.overflowX))
            : 0.5;
        const newPanY = state.overflowY > 0
            ? Math.max(0, Math.min(1, state.startPanY - dy / state.overflowY))
            : 0.5;
        const t = getFrameTransform(editor, state.nodeId);
        if (!t)
            return;
        editor.set_image_transform(state.nodeId, newPanX, newPanY, t.scale, t.rotation_deg);
        canvasEl.style.cursor = 'grabbing';
        redraw();
    },
    onMouseUp(_e, ctx) {
        const { setMode, canvasEl } = ctx;
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
    },
    onMouseLeave(e, ctx) {
        imagePanMode.onMouseUp(e, ctx);
    },
};
// ---------------------------------------------------------------------------
// Text element placement mode — click anywhere to create a text element
// ---------------------------------------------------------------------------
export const textPlaceMode = {
    onMouseDown(e, ctx) {
        if (e.button !== 0)
            return;
        const { editor, renderer, toSpread, snapshot, redraw, setMode, canvasEl } = ctx;
        const { sr, relX, relY } = toSpread(e);
        const spreadInfo = getSpreadInfo(editor);
        const mmToPx = sr.w / spreadInfo.width_mm;
        const x_mm = relX / mmToPx;
        const y_mm = relY / mmToPx;
        snapshot();
        const newId = addTextElement(editor, x_mm, y_mm);
        renderer.selectedTextIds = new Set([newId]);
        editor.select_face(0xFFFFFFFF);
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
        redraw();
        ctx.onTextSelected?.(newId);
    },
    onMouseMove(_e, ctx) { ctx.canvasEl.style.cursor = 'crosshair'; },
    onMouseUp(_e, _ctx) { },
    onMouseLeave(_e, ctx) {
        ctx.canvasEl.style.cursor = 'default';
        ctx.setMode(idleMode, {});
    },
};
// ---------------------------------------------------------------------------
// Text drag mode — move a text element
// ---------------------------------------------------------------------------
export const textDragMode = {
    onMouseDown(_e, _ctx) { },
    onMouseMove(e, ctx) {
        const { editor, toSpread, redraw, canvasEl, modeState, snapshot } = ctx;
        const state = modeState;
        const { relX, relY } = toSpread(e);
        const dx = relX - state.startMouseX;
        const dy = relY - state.startMouseY;
        if (!state.hasMoved) {
            if (Math.abs(dx) < 3 && Math.abs(dy) < 3)
                return;
            snapshot();
            state.hasMoved = true;
        }
        const newX = state.startX + dx / state.mmToPx;
        const newY = state.startY + dy / state.mmToPx;
        moveTextElement(editor, state.el.id, newX, newY);
        canvasEl.style.cursor = 'move';
        redraw();
        ctx.onTextChanged?.();
    },
    onMouseUp(_e, ctx) {
        ctx.canvasEl.style.cursor = 'default';
        ctx.setMode(idleMode, {});
    },
    onMouseLeave(e, ctx) { textDragMode.onMouseUp(e, ctx); },
};
// ---------------------------------------------------------------------------
// Text resize mode — drag a corner handle to scale font size
// Corners: 0=TL, 1=TR (top edge moves → y_mm changes), 2=BR, 3=BL (bottom edge moves).
// The measured text height drives the proportional font-size change.
// ---------------------------------------------------------------------------
export const textResizeMode = {
    onMouseDown(_e, _ctx) { },
    onMouseMove(e, ctx) {
        const { editor, toSpread, redraw, canvasEl, modeState, snapshot } = ctx;
        const state = modeState;
        const { canvasX, canvasY } = toSpread(e);
        // Project mouse-to-fixed-corner vector onto the diagonal to get scale factor.
        const vx = canvasX - state.fx;
        const vy = canvasY - state.fy;
        const s = state.d2 > 0 ? (vx * state.ddx + vy * state.ddy) / state.d2 : 1;
        if (!state.hasMoved) {
            if (Math.abs(s - 1) * Math.sqrt(state.d2) < 2)
                return;
            snapshot();
            state.hasMoved = true;
        }
        const minS = 1 / state.startFontSize; // keeps font_size_pt >= 1
        const sActual = Math.max(minS, s);
        const hw_new = state.hw0 * sActual;
        const hh_new = state.hh0 * sActual;
        // New centre: fixed corner stays at (fx, fy).
        const cx_new = state.fx - state.sign_fx * hw_new * state.cos_t + state.sign_fy * hh_new * state.sin_t;
        const cy_new = state.fy - state.sign_fx * hw_new * state.sin_t - state.sign_fy * hh_new * state.cos_t;
        // New bounding-box top-left → mm coords.
        const x_mm_new = (cx_new - hw_new - state.srX) / state.mmToPx;
        const y_mm_new = (cy_new - hh_new - state.srY) / state.mmToPx;
        const newFontSize = Math.max(1, state.startFontSize * sActual);
        const updated = { ...state.el, font_size_pt: newFontSize, x_mm: x_mm_new, y_mm: y_mm_new };
        updateTextElement(editor, updated);
        canvasEl.style.cursor = state.cornerIndex === 0 || state.cornerIndex === 2 ? 'nwse-resize' : 'nesw-resize';
        redraw();
        ctx.onTextChanged?.();
    },
    onMouseUp(_e, ctx) {
        ctx.canvasEl.style.cursor = 'default';
        ctx.setMode(idleMode, {});
    },
    onMouseLeave(e, ctx) { textResizeMode.onMouseUp(e, ctx); },
};
// ---------------------------------------------------------------------------
// Text rotate mode — drag the rotation handle to rotate a text element
// ---------------------------------------------------------------------------
export const textRotateMode = {
    onMouseDown(_e, _ctx) { },
    onMouseMove(e, ctx) {
        const { editor, toSpread, redraw, canvasEl, modeState, snapshot } = ctx;
        const state = modeState;
        const { canvasX, canvasY } = toSpread(e);
        // Angle from element centre to current mouse position (in canvas space).
        const angle = Math.atan2(canvasY - state.cy, canvasX - state.cx);
        const delta = -(angle - state.startAngle) * (180 / Math.PI);
        if (!state.hasMoved) {
            if (Math.abs(delta) < 1)
                return;
            snapshot();
            state.hasMoved = true;
        }
        const newRot = state.startRot + delta;
        const updated = { ...state.el, rotation_deg: newRot };
        updateTextElement(editor, updated);
        canvasEl.style.cursor = 'crosshair';
        redraw();
        ctx.onTextChanged?.();
    },
    onMouseUp(_e, ctx) {
        ctx.canvasEl.style.cursor = 'default';
        ctx.setMode(idleMode, {});
    },
    onMouseLeave(e, ctx) { textRotateMode.onMouseUp(e, ctx); },
};
export const cutToolMode = {
    onMouseDown(e, ctx) {
        if (e.button !== 0)
            return;
        const { editor, overlays, snapshot, refreshBoxModel, redraw } = ctx;
        const state = ctx.modeState;
        if (state.nodeId === NULL_ID || state.axis === null)
            return;
        snapshot();
        if (state.axis === 'quadrant') {
            editor.split_face_into_quadrant_n(state.nodeId, state.numCuts + 1);
        }
        else if (state.numCuts > 1) {
            editor.split_face_into_n(state.nodeId, state.axis, state.numCuts + 1);
        }
        else if (state.ratio !== null) {
            editor.split_face_at(state.nodeId, state.axis, state.ratio);
        }
        overlays.splitPreview = null;
        refreshBoxModel();
        ctx.setMode(idleMode, {});
        redraw();
    },
    onMouseMove(e, ctx) {
        const { editor, overlays, toSpread, redraw, canvasEl } = ctx;
        const state = ctx.modeState;
        const { sr, relX, relY } = toSpread(e);
        editor.set_mouse_pos(relX, relY);
        const nodeId = editor.hit_test(relX, relY, sr.w, sr.h);
        state.nodeId = nodeId;
        if (nodeId === NULL_ID) {
            overlays.splitPreview = null;
            state.axis = null;
            canvasEl.style.cursor = 'crosshair';
            redraw();
            return;
        }
        const renderList = getRenderList(editor, sr.w, sr.h);
        const frame = renderList.find(f => f.id === nodeId);
        if (!frame)
            return;
        const { x: fx, y: fy, w: fw, h: fh } = frame.rect;
        const relXInFrame = (relX - fx) / fw;
        const relYInFrame = (relY - fy) / fh;
        const QUADRANT_ZONE = 0.10;
        const nearCenterX = Math.abs(relXInFrame - 0.5) < QUADRANT_ZONE;
        const nearCenterY = Math.abs(relYInFrame - 0.5) < QUADRANT_ZONE;
        if (nearCenterX && nearCenterY) {
            state.axis = 'quadrant';
            state.ratio = 0.5;
            overlays.splitPreview = { frameRect: frame.rect, axis: 'quadrant', ratio: 0.5, numCuts: state.numCuts };
            canvasEl.style.cursor = 'crosshair';
        }
        else {
            const axis = editor.split_axis_hint_for(nodeId, sr.w, sr.h);
            const SNAP_PX = 8;
            const rawRatio = axis === 'v'
                ? Math.max(0.05, Math.min(0.95, relXInFrame))
                : Math.max(0.05, Math.min(0.95, relYInFrame));
            const frameStart = axis === 'v' ? fx : fy;
            const frameSize = axis === 'v' ? fw : fh;
            const snapThresh = SNAP_PX / frameSize;
            // Collect snap candidates: frame midpoint + all parallel dividers inside this frame.
            const snapCandidates = [0.5];
            for (const d of getDividers(editor, sr.w, sr.h)) {
                if (d.axis !== axis)
                    continue;
                const dpos = axis === 'v' ? d.x : d.y;
                if (dpos > frameStart && dpos < frameStart + frameSize) {
                    snapCandidates.push((dpos - frameStart) / frameSize);
                }
            }
            let ratio = rawRatio;
            if (!e.altKey) {
                let bestDist = snapThresh;
                for (const c of snapCandidates) {
                    const dist = Math.abs(rawRatio - c);
                    if (dist < bestDist) {
                        bestDist = dist;
                        ratio = c;
                    }
                }
            }
            ratio = Math.max(0.05, Math.min(0.95, ratio));
            state.axis = axis;
            state.ratio = ratio;
            overlays.splitPreview = { frameRect: frame.rect, axis, ratio, numCuts: state.numCuts };
            canvasEl.style.cursor = axis === 'v' ? 'col-resize' : 'row-resize';
        }
        redraw();
    },
    onMouseUp(_e, _ctx) { },
    onMouseLeave(_e, ctx) {
        // Don't exit the tool when leaving the canvas; just clear the preview
        ctx.overlays.splitPreview = null;
        ctx.redraw();
    },
    onWheel(e, ctx) {
        e.preventDefault();
        const state = ctx.modeState;
        if (e.deltaY < 0)
            state.numCuts = Math.min(state.numCuts + 1, 12);
        else
            state.numCuts = Math.max(1, state.numCuts - 1);
        if (ctx.overlays.splitPreview) {
            ctx.overlays.splitPreview = { ...ctx.overlays.splitPreview, numCuts: state.numCuts };
        }
        ctx.redraw();
    },
};
export const pinwheelSpawnMode = {
    onMouseDown(_e, _ctx) { },
    onMouseMove(e, ctx) {
        const { editor, refreshBoxModel, redraw, modeState, canvasEl } = ctx;
        const state = modeState;
        const sr = state.spreadRect;
        const rect = canvasEl.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const nx = (cx - sr.x) / sr.w;
        const ny = (cy - sr.y) / sr.h;
        editor.update_pinwheel_spawn(nx, ny);
        refreshBoxModel();
        redraw();
    },
    onMouseUp(_e, ctx) {
        const { editor, refreshBoxModel, redraw, setMode } = ctx;
        editor.end_pinwheel_spawn();
        refreshBoxModel();
        setMode(idleMode, {});
        redraw();
    },
    onMouseLeave(_e, ctx) {
        const { editor, refreshBoxModel, redraw, setMode } = ctx;
        editor.cancel_pinwheel_spawn();
        refreshBoxModel();
        setMode(idleMode, {});
        redraw();
    },
};
