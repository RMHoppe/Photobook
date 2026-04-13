// main.js — App bootstrap: initialises Wasm and wires all UI modules together.

import init, { PhotobookEditor, init_panic_hook } from './pkg/photobook_core.js';
import { CanvasRenderer } from './canvas.js';
import { ImageSidebar } from './sidebar-left.js';
import { BoxModelEditor } from './sidebar-right.js';
import { Footer } from './footer.js';
import { NULL_ID, ZOOM_MIN, ZOOM_MAX, UNDO_MAX } from './constants.js';
import { idleMode, dividerDragMode, imagePanMode, marginDragMode, splitPreviewMode, imageSwapMode } from './interaction.js';

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

await init();
init_panic_hook();

// A4 landscape spread: each page is A4 portrait (210×297mm), 3mm bleed
const editor = new PhotobookEditor(210, 297, 3);

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const canvasEl = document.getElementById('main-canvas');
const renderer = new CanvasRenderer(canvasEl);

// Compute the CSS size of the canvas-area and size the canvas accordingly
function fitCanvas() {
  const area = document.getElementById('canvas-area');
  const W = area.clientWidth;
  const H = area.clientHeight;
  renderer.resize(W, H);
  redraw();
}

function redraw() {
  renderer.draw(editor);
  footer.update(editor, renderer);
}

window.addEventListener('resize', fitCanvas);

/** Compute spread rect — delegates to the single canonical implementation in CanvasRenderer. */
function spreadRect() {
  return renderer.spreadRect(JSON.parse(editor.get_current_spread_info()));
}

// ---------------------------------------------------------------------------
// Image sidebar
// ---------------------------------------------------------------------------

const sidebar = new ImageSidebar(
  document.getElementById('image-grid'),
  (id) => {
    const proxy = sidebar.getProxy(id);
    if (proxy) renderer.cacheImage(id, proxy);
    selectedImageId = id;
  }
);

let selectedImageId = null;

document.getElementById('btn-open-folder').addEventListener('click', () => {
  sidebar.openFolder();
});

// ---------------------------------------------------------------------------
// Box model editor
// ---------------------------------------------------------------------------

const boxEditor = new BoxModelEditor(
  document.getElementById('box-model-editor'),
  (json) => {
    editor.set_box_model(json);
    redraw();
  },
  (field) => {
    const sel = editor.get_selected();
    if (sel === NULL_ID) return;
    snapshot();
    if (field === 'gap') editor.apply_gap_to_subtree(sel);
    else if (field === 'bg') editor.apply_bg_to_subtree(sel);
    redraw();
  }
);

// Snapshot before the user starts editing any box model field
document.getElementById('box-model-editor').addEventListener('focusin', (e) => {
  if (e.target.tagName === 'INPUT') snapshot();
});

function refreshBoxModel() {
  const sel = editor.get_selected();
  if (sel === NULL_ID) {
    boxEditor.clear();
  } else {
    boxEditor.update(editor.get_box_model());
  }
}


// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

const footer = new Footer(
  document.getElementById('spread-thumbnails'),
  document.getElementById('btn-prev-spread'),
  document.getElementById('btn-next-spread'),
  (idx) => {
    if (idx < 0 || idx >= editor.get_spread_count()) return;
    editor.set_current_spread(idx);
    refreshBoxModel();
    redraw();
  }
);

// ---------------------------------------------------------------------------
// Canvas mouse events — interaction state machine
// ---------------------------------------------------------------------------

/** Shared context passed to every interaction mode handler. */
let currentMode = idleMode;
let modeState = {};

function setMode(mode, state) {
  currentMode = mode;
  modeState = state;
}

const interactionCtx = () => ({
  editor, renderer, sidebar, canvasEl, spreadRect, snapshot, refreshBoxModel, redraw,
  setMode, dividerDragMode, imagePanMode, marginDragMode, splitPreviewMode, imageSwapMode,
  modeState,
  get_render_list: (w, h) => editor.get_render_list(w, h),
});

canvasEl.addEventListener('mousemove', (e) => {
  currentMode.onMouseMove(e, { ...interactionCtx(), modeState });
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
  if (!imageId) return;

  const sr = spreadRect();
  const rect = canvasEl.getBoundingClientRect();
  const relX = (e.clientX - rect.left) - sr.x;
  const relY = (e.clientY - rect.top) - sr.y;

  const hitId = editor.hit_test(relX, relY, sr.w, sr.h);
  if (hitId !== NULL_ID) {
    snapshot();
    const proxy = sidebar.getProxy(imageId);
    if (proxy) renderer.cacheImage(imageId, proxy);
    editor.assign_image(hitId, imageId);
    editor.select_node(hitId);
    refreshBoxModel();
    redraw();
  }
});

canvasEl.addEventListener('mouseleave', (e) => {
  currentMode.onMouseLeave(e, { ...interactionCtx(), modeState });
  setMode(idleMode, {});
});

// ---------------------------------------------------------------------------
// Keyboard events
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  // Don't intercept if typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  const sr = spreadRect();
  let handled = true;

  switch (e.key) {
    case 'x':
    case 'X': {
      if (editor.get_selected() === NULL_ID) break;
      setMode(splitPreviewMode, { nodeId: editor.get_selected(), axis: null, ratio: null });
      redraw();
      break;
    }
    case 'Escape': {
      if (currentMode === splitPreviewMode) {
        renderer.splitPreview = null;
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
        redraw();
      }
      break;
    }
    case 'Delete':
    case 'Backspace': {
      snapshot();
      editor.delete_selected();
      refreshBoxModel();
      redraw();
      break;
    }
    case 'ArrowUp':    editor.navigate('up');    refreshBoxModel(); redraw(); break;
    case 'ArrowDown':  editor.navigate('down');  refreshBoxModel(); redraw(); break;
    case 'ArrowLeft':  editor.navigate('left');  refreshBoxModel(); redraw(); break;
    case 'ArrowRight': editor.navigate('right'); refreshBoxModel(); redraw(); break;
    default: handled = false;
  }

  if (handled) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

document.getElementById('btn-add-spread').addEventListener('click', () => {
  snapshot();
  editor.add_page();
  redraw();
});

document.getElementById('btn-export-pdf').addEventListener('click', async () => {
  const btn = document.getElementById('btn-export-pdf');
  btn.disabled = true;
  btn.textContent = 'Exporting…';

  try {
    // Collect image buffers as base64
    const images = [];
    for (const entry of sidebar.getAllBuffers()) {
      const base64 = bufferToBase64(entry.buffer);
      images.push({
        id: entry.id,
        data_base64: base64,
        width_px: entry.width_px,
        height_px: entry.height_px,
      });
    }

    const pdfBytes = editor.export_pdf(JSON.stringify(images));
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'photobook.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    console.error('PDF export failed:', err);
    alert('PDF export failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Export PDF';
  }
});

// ---------------------------------------------------------------------------
// Undo / redo (snapshot stack)
// ---------------------------------------------------------------------------

const undoStack = [];
const redoStack = [];

const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');

function updateUndoRedoButtons() {
  btnUndo.disabled = undoStack.length === 0;
  btnRedo.disabled = redoStack.length === 0;
}

function snapshot() {
  undoStack.push(editor.save_state());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
  updateUndoRedoButtons();
}

function performUndo() {
  if (undoStack.length === 0) return;
  redoStack.push(editor.save_state());
  editor.load_state(undoStack.pop());
  refreshBoxModel();
  redraw();
  updateUndoRedoButtons();
}

function performRedo() {
  if (redoStack.length === 0) return;
  undoStack.push(editor.save_state());
  editor.load_state(redoStack.pop());
  refreshBoxModel();
  redraw();
  updateUndoRedoButtons();
}

btnUndo.addEventListener('click', performUndo);
btnRedo.addEventListener('click', performRedo);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    performUndo();
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
    performRedo();
    e.preventDefault();
  }
});

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------

const settingsModal = document.getElementById('settings-modal');
const btnSettings   = document.getElementById('btn-settings');

btnSettings.addEventListener('click', () => {
  const ps = JSON.parse(editor.get_page_size_mm());
  document.getElementById('set-page-w').value      = ps.width_mm;
  document.getElementById('set-page-h').value      = ps.height_mm;
  document.getElementById('set-bleed').value       = editor.get_bleed_mm();
  document.getElementById('set-safe').value        = editor.get_safe_zone_mm();
  document.getElementById('set-spine').value       = editor.get_spine_mm_per_page();
  document.getElementById('set-spine-min').value   = editor.get_spine_min_mm();
  document.getElementById('set-margin-step').value = editor.get_margin_step_mm();
  settingsModal.showModal();
});

document.getElementById('btn-settings-cancel').addEventListener('click', () => {
  settingsModal.close();
});

document.getElementById('btn-settings-apply').addEventListener('click', () => {
  const w   = parseFloat(document.getElementById('set-page-w').value);
  const h   = parseFloat(document.getElementById('set-page-h').value);
  const b   = parseFloat(document.getElementById('set-bleed').value);
  const sz  = parseFloat(document.getElementById('set-safe').value);
  const sp  = parseFloat(document.getElementById('set-spine').value);
  const spm = parseFloat(document.getElementById('set-spine-min').value);
  const ms  = parseFloat(document.getElementById('set-margin-step').value);
  if (isNaN(w) || isNaN(h) || isNaN(b) || isNaN(sz) || isNaN(sp) || isNaN(spm) || isNaN(ms)) return;
  snapshot();
  editor.set_page_settings(w, h, b, sz, sp, spm, ms);
  settingsModal.close();
  redraw();
});

// Close on backdrop click
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.close();
});

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

function setZoom(z) {
  renderer.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  document.getElementById('zoom-label').textContent = Math.round(renderer.zoom * 100) + '%';
  redraw();
}

document.getElementById('btn-zoom-in').addEventListener('click', () => setZoom(renderer.zoom * 1.25));
document.getElementById('btn-zoom-out').addEventListener('click', () => setZoom(renderer.zoom / 1.25));
document.getElementById('btn-zoom-fit').addEventListener('click', () => setZoom(1.0));

canvasEl.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    // Ctrl/Cmd + scroll → canvas zoom
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom(renderer.zoom * factor);
    return;
  }

  // Plain scroll or Shift+scroll → image scale / rotate
  const sr = spreadRect();
  const rect = canvasEl.getBoundingClientRect();
  const relX = (e.clientX - rect.left) - sr.x;
  const relY = (e.clientY - rect.top) - sr.y;
  const hitId = editor.hit_test(relX, relY, sr.w, sr.h);
  if (hitId === NULL_ID) return;

  e.preventDefault();

  const t = JSON.parse(editor.get_leaf_transform(hitId));

  if (e.shiftKey) {
    // Shift + scroll → rotate image (0.5 degrees per notch)
    const delta = e.deltaY > 0 ? 0.5 : -0.5;
    snapshot();
    editor.set_image_transform(hitId, t.pan_x, t.pan_y, t.scale, t.rotation_deg + delta);
  } else {
    // Plain scroll → scale image (1% per notch, minimum 1.0)
    const factor = e.deltaY < 0 ? 1.01 : 1 / 1.01;
    snapshot();
    editor.set_image_transform(hitId, t.pan_x, t.pan_y, Math.max(1.0, t.scale * factor), t.rotation_deg);
  }
  redraw();
}, { passive: false });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

fitCanvas();
