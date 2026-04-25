// main.ts — App bootstrap: initialises Wasm and wires all UI modules together.
import init, { PhotobookEditor, init_panic_hook } from './pkg/photobook_core.js';
import { CanvasRenderer } from './canvas.js';
import { ImageSidebar } from './sidebar-left.js';
import { BoxModelEditor, SplitterEditor, ProjectSettingsPanel, TextElementEditor } from './sidebar-right.js';
import { Footer } from './footer.js';
import { NULL_ID, ZOOM_MIN, ZOOM_MAX } from './constants.js';
import { idleMode, splitPreviewMode, textPlaceMode } from './interaction.js';
import { getSpreadInfo, getTextElements, deleteTextElement, updateTextElement, getAllSelected, getPageSizeMm, getDefaultSpreadMargin } from './wasm-bridge.js';
import { loadLocalFonts, localFontsSupported } from './fonts.js';
import { UndoManager } from './undo.js';
import { InlineEditor } from './inline-editor.js';
import { exportPdf } from './export.js';
// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
await init();
init_panic_hook();
const editor = new PhotobookEditor(210, 297, 3);
// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------
const canvasEl = document.getElementById('main-canvas');
const renderer = new CanvasRenderer(canvasEl, () => redraw());
const overlays = { marqueeRect: null, splitPreview: null, swapOverlay: null, edgeDragPreview: null, crossHandleDragPreview: null };
function fitCanvas() {
    const area = document.getElementById('canvas-area');
    renderer.resize(area.clientWidth, area.clientHeight);
    redraw();
}
function redraw() {
    renderer.draw(editor, overlays);
    footer.update(editor, renderer);
}
window.addEventListener('resize', fitCanvas);
function spreadRect() {
    return renderer.spreadRect(getSpreadInfo(editor));
}
// ---------------------------------------------------------------------------
// Image sidebar
// ---------------------------------------------------------------------------
const sidebar = new ImageSidebar(document.getElementById('image-grid'), 
// onSelect: cache the proxy immediately so canvas can render it on drop.
(id) => {
    const proxy = sidebar.getProxy(id);
    if (proxy)
        renderer.cacheImage(id, proxy);
}, 
// onProxyReady: also cache newly decoded proxies, and redraw in case the
// image was already assigned to a frame (e.g. after load_state).
(id) => {
    const proxy = sidebar.getProxy(id);
    if (proxy)
        renderer.cacheImage(id, proxy);
    redraw();
});
document.getElementById('btn-open-folder').addEventListener('click', () => {
    sidebar.openFolder();
});
// ---------------------------------------------------------------------------
// Right sidebar panels
// ---------------------------------------------------------------------------
const sidebarRightHeader = document.getElementById('sidebar-right-header');
const boxModelContainer = document.getElementById('box-model-editor');
const boxEditor = new BoxModelEditor(boxModelContainer, (json) => {
    editor.set_leaf_box_model(json);
    redraw();
}, (field) => {
    const sel = editor.get_selected();
    if (sel === NULL_ID)
        return;
    undoManager.snapshot();
    if (field === 'gap')
        editor.apply_gap_to_subtree(sel);
    else if (field === 'bg')
        editor.apply_bg_to_subtree(sel);
    redraw();
}, (direction) => {
    const sel = editor.get_selected();
    if (sel === NULL_ID)
        return;
    undoManager.snapshot();
    editor.move_node_z_order(sel, direction);
    redraw();
}, (field) => {
    showRandomizeDialog(field);
});
const splitterEditor = new SplitterEditor(boxModelContainer, (json) => {
    editor.set_split_box_model(json);
    redraw();
}, (ratio) => {
    editor.set_split_ratios(ratio);
    redraw();
});
const projectPanel = new ProjectSettingsPanel(boxModelContainer, (data) => {
    undoManager.snapshot();
    editor.set_page_settings(data.page_width_mm, data.page_height_mm, data.bleed_mm, data.safe_zone_mm, data.spine_mm_per_page, data.spine_min_mm, data.margin_step_mm, data.print_dpi);
    editor.set_default_spread_margin(data.default_margin_top, data.default_margin_right, data.default_margin_bottom, data.default_margin_left);
    redraw();
});
projectPanel.setBleedToggleHandler((show) => {
    renderer.showBleed = show;
    redraw();
});
const textEditor = new TextElementEditor(boxModelContainer, (el) => {
    updateTextElement(editor, el);
    redraw();
});
boxModelContainer.addEventListener('focusin', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA')
        undoManager.snapshot();
});
function currentProjectSettings() {
    const pageSize = getPageSizeMm(editor);
    const defMargin = getDefaultSpreadMargin(editor);
    return {
        page_width_mm: pageSize.width_mm,
        page_height_mm: pageSize.height_mm,
        bleed_mm: editor.get_bleed_mm(),
        safe_zone_mm: editor.get_safe_zone_mm(),
        spine_mm_per_page: editor.get_spine_mm_per_page(),
        spine_min_mm: editor.get_spine_min_mm(),
        margin_step_mm: editor.get_margin_step_mm(),
        print_dpi: editor.get_print_dpi(),
        default_margin_top: defMargin.top,
        default_margin_right: defMargin.right,
        default_margin_bottom: defMargin.bottom,
        default_margin_left: defMargin.left,
    };
}
// ---------------------------------------------------------------------------
// Right-sidebar tab state
// ---------------------------------------------------------------------------
let _sidebarTab = 'frame';
function updateSidebarHeader(hasLeaves, hasSplits) {
    if (hasLeaves && hasSplits) {
        if (sidebarRightHeader.dataset.mode !== 'tabs') {
            sidebarRightHeader.dataset.mode = 'tabs';
            sidebarRightHeader.innerHTML =
                '<button class="sidebar-tab" data-tab="frame">Frame</button>' +
                    '<button class="sidebar-tab" data-tab="splitter">Splitter</button>';
            sidebarRightHeader.querySelectorAll('[data-tab]').forEach(btn => {
                btn.addEventListener('click', () => {
                    _sidebarTab = btn.dataset.tab;
                    refreshBoxModel();
                });
            });
        }
        sidebarRightHeader.querySelectorAll('[data-tab]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === _sidebarTab);
        });
    }
    else {
        sidebarRightHeader.dataset.mode = 'text';
        sidebarRightHeader.textContent = hasLeaves ? 'Frame' : 'Splitter';
    }
}
function refreshBoxModel() {
    if (editor.get_selection_count() > 0) {
        renderer.selectedTextId = null;
    }
    if (renderer.selectedTextId !== null) {
        const textElements = getTextElements(editor);
        const el = textElements.find(t => t.id === renderer.selectedTextId);
        if (el) {
            sidebarRightHeader.dataset.mode = 'text';
            sidebarRightHeader.textContent = 'Text';
            textEditor.show(el);
            return;
        }
        renderer.selectedTextId = null;
    }
    if (editor.get_selection_count() === 0) {
        sidebarRightHeader.dataset.mode = 'text';
        sidebarRightHeader.textContent = 'Project Settings';
        projectPanel.show(currentProjectSettings());
        return;
    }
    const leafCount = editor.get_selection_leaf_count();
    const splitCount = editor.get_selection_split_count();
    const hasLeaves = leafCount > 0;
    const hasSplits = splitCount > 0;
    // Clamp active tab to whatever types are present in this selection.
    if (!hasLeaves)
        _sidebarTab = 'splitter';
    if (!hasSplits)
        _sidebarTab = 'frame';
    updateSidebarHeader(hasLeaves, hasSplits);
    if (_sidebarTab === 'frame') {
        const bmJson = editor.get_leaf_box_model();
        const sel = editor.get_selected();
        const zIndex = (leafCount === 1 && splitCount === 0 && sel !== NULL_ID)
            ? editor.get_node_z_index(sel) : undefined;
        boxEditor.update(bmJson, zIndex, leafCount);
    }
    else {
        const bm = JSON.parse(editor.get_split_box_model());
        const ratio = editor.get_split_merged_ratio();
        const axis = editor.get_split_merged_axis();
        splitterEditor.update(bm, ratio, axis);
    }
}
// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------
const footer = new Footer(document.getElementById('spread-thumbnails'), document.getElementById('btn-prev-spread'), document.getElementById('btn-next-spread'), (idx) => {
    if (idx < 0 || idx >= editor.get_spread_count())
        return;
    inlineEditor.stop();
    editor.set_current_spread(idx);
    refreshBoxModel();
    redraw();
});
// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------
const undoManager = new UndoManager(editor, document.getElementById('btn-undo'), document.getElementById('btn-redo'));
// Wire undo/redo into keyboard shortcuts.
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT'
        || e.target.tagName === 'TEXTAREA')
        return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        undoManager.undo();
        refreshBoxModel();
        redraw();
        e.preventDefault();
        return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
        undoManager.redo();
        refreshBoxModel();
        redraw();
        e.preventDefault();
        return;
    }
});
// ---------------------------------------------------------------------------
// Inline text editor
// ---------------------------------------------------------------------------
const inlineEditor = new InlineEditor(document.getElementById('canvas-area'), editor, renderer, {
    snapshot: () => undoManager.snapshot(),
    redraw,
    refreshBoxModel,
    spreadRect,
    showTextEditor: (el) => textEditor.show(el),
});
// ---------------------------------------------------------------------------
// Canvas mouse events — interaction state machine
// ---------------------------------------------------------------------------
let currentMode = idleMode;
let modeState = {};
function setMode(mode, state) {
    currentMode = mode;
    modeState = state;
}
function toSpread(e) {
    const sr = spreadRect();
    const rect = canvasEl.getBoundingClientRect();
    return { sr, relX: (e.clientX - rect.left) - sr.x, relY: (e.clientY - rect.top) - sr.y };
}
const interactionCtx = () => ({
    editor, renderer, overlays, canvasEl, spreadRect, toSpread,
    snapshot: () => undoManager.snapshot(), refreshBoxModel, redraw,
    setMode,
    onTextSelected: (id) => {
        renderer.selectedTextId = id;
        refreshBoxModel();
        redraw();
    },
    onTextChanged: () => {
        if (renderer.selectedTextId !== null) {
            const textElements = getTextElements(editor);
            const el = textElements.find(t => t.id === renderer.selectedTextId);
            if (el)
                textEditor.show(el);
        }
    },
});
// ---------------------------------------------------------------------------
// DPI warning tooltip
// ---------------------------------------------------------------------------
const dpiTooltip = document.createElement('div');
dpiTooltip.id = 'dpi-tooltip';
dpiTooltip.hidden = true;
document.body.appendChild(dpiTooltip);
canvasEl.addEventListener('mousemove', (e) => {
    currentMode.onMouseMove(e, { ...interactionCtx(), modeState });
    const rect = canvasEl.getBoundingClientRect();
    const badge = renderer.dpiBadgeAt(e.clientX - rect.left, e.clientY - rect.top);
    if (badge) {
        dpiTooltip.textContent = `Low resolution: ~${badge.effectiveDpi} DPI (target: ${badge.printDpi} DPI)`;
        dpiTooltip.hidden = false;
        dpiTooltip.style.left = (e.clientX + 12) + 'px';
        dpiTooltip.style.top = (e.clientY - 10) + 'px';
    }
    else {
        dpiTooltip.hidden = true;
    }
});
canvasEl.addEventListener('mousedown', (e) => {
    currentMode.onMouseDown(e, { ...interactionCtx(), modeState });
});
canvasEl.addEventListener('mouseup', (e) => {
    currentMode.onMouseUp(e, { ...interactionCtx(), modeState });
});
canvasEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
});
canvasEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const imageId = e.dataTransfer.getData('text/plain');
    if (!imageId)
        return;
    const sr = spreadRect();
    const rect = canvasEl.getBoundingClientRect();
    const relX = (e.clientX - rect.left) - sr.x;
    const relY = (e.clientY - rect.top) - sr.y;
    const hitId = editor.hit_test(relX, relY, sr.w, sr.h);
    if (hitId !== NULL_ID) {
        undoManager.snapshot();
        const proxy = sidebar.getProxy(imageId);
        if (proxy)
            renderer.cacheImage(imageId, proxy);
        editor.assign_image(hitId, imageId);
        editor.select_node(hitId);
        refreshBoxModel();
        redraw();
        // Lazily read natural dimensions for DPI checking (off critical path).
        sidebar.ensureDimensions(imageId).then(dims => {
            if (dims) {
                editor.register_image_size(imageId, dims[0], dims[1]);
                redraw();
            }
        });
    }
});
canvasEl.addEventListener('dblclick', (e) => {
    const rect = canvasEl.getBoundingClientRect();
    const textHit = renderer.hitTestText(e.clientX - rect.left, e.clientY - rect.top);
    if (textHit && textHit.part === 'body') {
        renderer.selectedTextId = textHit.id;
        editor.select_node(NULL_ID);
        refreshBoxModel();
        inlineEditor.start(textHit.id);
    }
});
canvasEl.addEventListener('mouseleave', (e) => {
    currentMode.onMouseLeave(e, { ...interactionCtx(), modeState });
    setMode(idleMode, {});
    dpiTooltip.hidden = true;
});
// ---------------------------------------------------------------------------
// Keyboard events
// ---------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT'
        || e.target.tagName === 'TEXTAREA')
        return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        editor.select_all();
        refreshBoxModel();
        redraw();
        e.preventDefault();
        return;
    }
    let handled = true;
    switch (e.key) {
        case 'x':
        case 'X': {
            const targetId = renderer.hoveredLeaf !== NULL_ID ? renderer.hoveredLeaf : editor.get_selected();
            if (targetId === NULL_ID)
                break;
            setMode(splitPreviewMode, { nodeId: targetId, axis: null, ratio: null, numCuts: 1 });
            redraw();
            break;
        }
        case 'Escape': {
            if (currentMode === splitPreviewMode) {
                overlays.splitPreview = null;
                canvasEl.style.cursor = 'default';
                setMode(idleMode, {});
                redraw();
            }
            else if (currentMode === textPlaceMode) {
                canvasEl.style.cursor = 'default';
                setMode(idleMode, {});
            }
            else if (renderer.selectedTextId !== null) {
                renderer.selectedTextId = null;
                refreshBoxModel();
                redraw();
            }
            break;
        }
        case 'Delete':
        case 'Backspace': {
            if (renderer.selectedTextId !== null) {
                undoManager.snapshot();
                deleteTextElement(editor, renderer.selectedTextId);
                renderer.selectedTextId = null;
                refreshBoxModel();
                redraw();
            }
            else {
                undoManager.snapshot();
                editor.delete_selected();
                refreshBoxModel();
                redraw();
            }
            break;
        }
        case 'ArrowUp':
            editor.navigate('up');
            refreshBoxModel();
            redraw();
            break;
        case 'ArrowDown':
            editor.navigate('down');
            refreshBoxModel();
            redraw();
            break;
        case 'ArrowLeft':
            editor.navigate('left');
            refreshBoxModel();
            redraw();
            break;
        case 'ArrowRight':
            editor.navigate('right');
            refreshBoxModel();
            redraw();
            break;
        default: handled = false;
    }
    if (handled)
        e.preventDefault();
});
// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
document.getElementById('btn-add-spread').addEventListener('click', () => {
    undoManager.snapshot();
    editor.add_page();
    redraw();
});
document.getElementById('btn-add-text').addEventListener('click', () => {
    canvasEl.style.cursor = 'crosshair';
    setMode(textPlaceMode, {});
});
document.getElementById('btn-export-pdf').addEventListener('click', () => {
    exportPdf(editor, () => sidebar.buffersForExport());
});
// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------
function setZoom(z) {
    inlineEditor.stop();
    renderer.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    document.getElementById('zoom-label').textContent = Math.round(renderer.zoom * 100) + '%';
    redraw();
}
document.getElementById('btn-zoom-in').addEventListener('click', () => setZoom(renderer.zoom * 1.25));
document.getElementById('btn-zoom-out').addEventListener('click', () => setZoom(renderer.zoom / 1.25));
document.getElementById('btn-zoom-fit').addEventListener('click', () => setZoom(1.0));
canvasEl.addEventListener('wheel', (e) => {
    if (currentMode.onWheel) {
        currentMode.onWheel(e, { ...interactionCtx(), modeState });
        if (e.defaultPrevented)
            return;
    }
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom(renderer.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        return;
    }
    const sr = spreadRect();
    const rect = canvasEl.getBoundingClientRect();
    const relX = (e.clientX - rect.left) - sr.x;
    const relY = (e.clientY - rect.top) - sr.y;
    const hitId = editor.hit_test(relX, relY, sr.w, sr.h);
    if (hitId === NULL_ID)
        return;
    e.preventDefault();
    const t = JSON.parse(editor.get_leaf_transform(hitId));
    if (!t)
        return;
    if (e.shiftKey) {
        const delta = e.deltaY > 0 ? 0.5 : -0.5;
        undoManager.snapshot();
        editor.set_image_transform(hitId, t.pan_x, t.pan_y, t.scale, t.rotation_deg + delta);
    }
    else {
        const factor = e.deltaY < 0 ? 1.01 : 1 / 1.01;
        undoManager.snapshot();
        editor.set_image_transform(hitId, t.pan_x, t.pan_y, Math.max(1.0, t.scale * factor), t.rotation_deg);
    }
    redraw();
}, { passive: false });
// ---------------------------------------------------------------------------
// Randomize dialog
// ---------------------------------------------------------------------------
const randomizeDialog = document.createElement('div');
randomizeDialog.id = 'randomize-dialog';
randomizeDialog.hidden = true;
randomizeDialog.innerHTML = `
  <h5 id="rd-title">Randomize</h5>
  <div class="rd-row">
    <label>Min</label>
    <input id="rd-min" type="number" step="0.01" value="0" />
  </div>
  <div class="rd-row">
    <label>Max</label>
    <input id="rd-max" type="number" step="0.01" value="1" />
  </div>
  <div class="rd-actions">
    <button id="rd-cancel">Cancel</button>
    <button id="rd-apply">Apply</button>
  </div>
`;
document.getElementById('canvas-area').appendChild(randomizeDialog);
let _rdField = 'rotation';
const RD_DEFAULTS = {
    'rotation': { title: 'Randomize Rotation', min: '-15', max: '15', step: '0.5' },
};
function showRandomizeDialog(field) {
    _rdField = field;
    const d = RD_DEFAULTS[field];
    randomizeDialog.querySelector('#rd-title').textContent = d.title;
    const minEl = randomizeDialog.querySelector('#rd-min');
    const maxEl = randomizeDialog.querySelector('#rd-max');
    minEl.value = d.min;
    minEl.step = d.step;
    maxEl.value = d.max;
    maxEl.step = d.step;
    randomizeDialog.hidden = false;
}
randomizeDialog.querySelector('#rd-cancel').addEventListener('click', () => {
    randomizeDialog.hidden = true;
});
randomizeDialog.querySelector('#rd-apply').addEventListener('click', () => {
    randomizeDialog.hidden = true;
    const minVal = parseFloat((randomizeDialog.querySelector('#rd-min')).value);
    const maxVal = parseFloat((randomizeDialog.querySelector('#rd-max')).value);
    if (isNaN(minVal) || isNaN(maxVal) || minVal > maxVal)
        return;
    const selected = getAllSelected(editor);
    if (selected.length < 2)
        return;
    undoManager.snapshot();
    for (const nodeId of selected) {
        const randVal = minVal + Math.random() * (maxVal - minVal);
        editor.set_node_frame_rotation(nodeId, randVal);
    }
    refreshBoxModel();
    redraw();
});
// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
fitCanvas();
refreshBoxModel();
if (localFontsSupported()) {
    textEditor.setLoadFontsHandler(async () => {
        const families = await loadLocalFonts();
        if (families.length > 0)
            textEditor.setFontFamilies(families);
    });
}
