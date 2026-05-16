// main.ts — App bootstrap: initialises Wasm and wires all UI modules together.

import init, { PhotobookEditor, init_panic_hook } from './pkg/photobook_core.js';
import { CanvasRenderer } from './canvas.js';
import { ImageSidebar } from './sidebar-left.js';
import { BoxModelEditor, ProjectSettingsPanel, TextElementEditor, SidebarPhotoInfoPanel } from './sidebar-right.js';
import type { ProjectSettingsData } from './sidebar-right.js';
import { Footer } from './footer.js';
import { NULL_ID, ZOOM_MIN, ZOOM_MAX } from './constants.js';
import { idleMode, splitPreviewMode, cutToolMode, textPlaceMode } from './interaction.js';
import type { InteractionMode, ModeState, InteractionContext } from './interaction.js';
import { getSpreadInfo, getTextElements, deleteTextElement, updateTextElement, getAllSelected, getPageSizeMm, getDefaultSpreadMargin, getUsedImageIds, splitFaceForMultiDrop, getRenderList } from './wasm-bridge.js';
import type { Overlays } from './types.js';
import { loadLocalFonts, localFontsSupported } from './fonts.js';
import { UndoManager } from './undo.js';
import { InlineEditor } from './inline-editor.js';
import { exportPdf } from './export.js';
import { DocsPanel } from './docs-panel.js';

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

await init();
init_panic_hook();

const editor = new PhotobookEditor(210, 297, 3);

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const canvasEl = document.getElementById('main-canvas') as HTMLCanvasElement;
const renderer = new CanvasRenderer(canvasEl, () => redraw());

const overlays: Overlays = { marqueeRect: null, splitPreview: null, swapOverlay: null, edgeDragPreview: null };

function fitCanvas(): void {
  const area = document.getElementById('canvas-area')!;
  renderer.resize(area.clientWidth, area.clientHeight);
  redraw();
}

function redraw(): void {
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

const sidebar = new ImageSidebar(
  document.getElementById('image-grid')!,
  // onPhotoSelect: cache proxies for all selected images and show photo panel.
  (ids) => {
    for (const id of ids) {
      const proxy = sidebar.getProxy(id);
      if (proxy) renderer.cacheImage(id, proxy);
    }
    if (ids.size > 0) {
      editor.select_face(NULL_ID);
      renderer.selectedTextIds.clear();
      redraw();
    }
    refreshBoxModel();
  },
  // onProxyReady: cache newly decoded proxies and redraw; also refresh the
  // photo panel if this image is currently selected.
  (id) => {
    const proxy = sidebar.getProxy(id);
    if (proxy) renderer.cacheImage(id, proxy);
    if (sidebar.getSelectedIds().has(id)) refreshBoxModel();
    redraw();
  },
);

document.getElementById('btn-open-folder')!.addEventListener('click', () => {
  sidebar.openFolder();
});

// ---------------------------------------------------------------------------
// Right sidebar panels
// ---------------------------------------------------------------------------

const sidebarRightHeader = document.getElementById('sidebar-right-header')!;
const boxModelContainer  = document.getElementById('box-model-editor')!;
const panelFace          = document.getElementById('panel-face')!;
const panelText          = document.getElementById('panel-text')!;
const panelDivider       = document.getElementById('panel-divider')!;
const panelPhoto         = document.getElementById('panel-photo')!;
const panelProject       = document.getElementById('panel-project')!;

/** Wrap an editor mutation so it always calls redraw() afterward. */
function editorCallback<T>(action: (data: T) => void): (data: T) => void {
  return (data) => { action(data); redraw(); };
}

const boxEditor = new BoxModelEditor(
  panelFace,
  editorCallback((json: string) => editor.set_face_box_model(json)),
  (direction) => {
    const sel = editor.get_selected();
    if (sel === NULL_ID) return;
    undoManager.snapshot();
    editor.move_face_z_order(sel, direction);
    redraw();
  },
  (field: 'rotation') => {
    showRandomizeDialog(field);
  },
);

const projectPanel = new ProjectSettingsPanel(
  panelProject,
  (data: ProjectSettingsData) => {
    undoManager.snapshot();
    editor.set_page_settings(
      data.page_width_mm,
      data.page_height_mm,
      data.bleed_mm,
      data.safe_zone_mm,
      data.spine_mm_per_page,
      data.spine_min_mm,
      data.margin_step_mm,
      data.print_dpi,
    );
    editor.set_default_spread_margin(
      data.default_margin_top,
      data.default_margin_right,
      data.default_margin_bottom,
      data.default_margin_left,
    );
    redraw();
  },
);

projectPanel.setBleedToggleHandler(editorCallback((show: boolean) => { renderer.showBleed = show; }));
projectPanel.setSafeZoneToggleHandler(editorCallback((show: boolean) => { renderer.showSafeZone = show; }));

const photoPanel = new SidebarPhotoInfoPanel(panelPhoto, sidebar);

const textEditor = new TextElementEditor(
  panelText,
  editorCallback((updatedEl) => {
    const textElements = getTextElements(editor);
    // Apply the full update to the representative (first-selected) element.
    updateTextElement(editor, updatedEl);
    // Propagate style properties to every other selected text element.
    if (renderer.selectedTextIds.size > 1) {
      for (const id of renderer.selectedTextIds) {
        if (id === updatedEl.id) continue;
        const existing = textElements.find(t => t.id === id);
        if (!existing) continue;
        updateTextElement(editor, {
          ...existing,
          font_family:  updatedEl.font_family,
          font_size_pt: updatedEl.font_size_pt,
          bold:         updatedEl.bold,
          italic:       updatedEl.italic,
          color:        updatedEl.color,
          align:        updatedEl.align,
        });
      }
    }
  }),
);

boxModelContainer.addEventListener('focusin', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') undoManager.snapshot();
});

function currentProjectSettings(): ProjectSettingsData {
  const pageSize  = getPageSizeMm(editor);
  const defMargin = getDefaultSpreadMargin(editor);
  return {
    page_width_mm:        pageSize.width_mm,
    page_height_mm:       pageSize.height_mm,
    bleed_mm:             editor.get_bleed_mm(),
    safe_zone_mm:         editor.get_safe_zone_mm(),
    spine_mm_per_page:    editor.get_spine_mm_per_page(),
    spine_min_mm:         editor.get_spine_min_mm(),
    margin_step_mm:       editor.get_margin_step_mm(),
    print_dpi:            editor.get_print_dpi(),
    default_margin_top:    defMargin.top,
    default_margin_right:  defMargin.right,
    default_margin_bottom: defMargin.bottom,
    default_margin_left:   defMargin.left,
  };
}

// ---------------------------------------------------------------------------
// Sidebar — shows all applicable panels for the current selection
// ---------------------------------------------------------------------------

function refreshBoxModel(): void {
  const hasFaces   = editor.get_selection_count() > 0;
  const hasTexts   = renderer.selectedTextIds.size > 0;
  const hasDivider = editor.get_selected_segment_count() > 0;
  if (hasFaces || hasTexts || hasDivider) sidebar.clearSelection();
  const sidebarIds = sidebar.getSelectedIds();
  const hasPhotos  = sidebarIds.size > 0;
  const showPhoto  = hasPhotos;
  const hasNothing = !hasFaces && !hasTexts && !hasDivider && !showPhoto;

  panelFace.hidden    = !hasFaces;
  panelText.hidden    = !hasTexts;
  panelDivider.hidden = !hasDivider;
  panelPhoto.hidden   = !showPhoto;
  panelProject.hidden = !hasNothing;

  const parts: string[] = [];
  if (hasFaces)   parts.push('Frame');
  if (hasTexts)   parts.push('Text');
  if (hasDivider) parts.push('Divider');
  if (showPhoto)  parts.push(sidebarIds.size === 1 ? 'Photo' : 'Photos');
  if (hasNothing) parts.push('Project Settings');
  sidebarRightHeader.textContent = parts.join(' · ');

  if (hasFaces) {
    const selectionCount = editor.get_selection_count();
    const bmJson = editor.get_face_box_model();
    const sel    = editor.get_selected();
    const zIndex = (selectionCount === 1 && sel !== NULL_ID)
      ? editor.get_face_z_index(sel) : undefined;
    boxEditor.update(bmJson, zIndex, selectionCount);
  }

  if (hasTexts) {
    const textElements = getTextElements(editor);
    const firstId = renderer.selectedTextIds.values().next().value as number;
    const el = textElements.find(t => t.id === firstId);
    if (el) textEditor.show(el);
    else renderer.selectedTextIds.clear();
  }

  if (hasDivider) showDividerPanel();
  if (showPhoto)  photoPanel.show(sidebarIds);
  if (hasNothing) projectPanel.show(currentProjectSettings());

  // Keep the green tick badges in sync with placed images.
  sidebar.updateUsedBadges(getUsedImageIds(editor));
}

// ---------------------------------------------------------------------------
// Divider properties panel (shown when a divider is selected)
// ---------------------------------------------------------------------------

function showDividerPanel(): void {
  if (panelDivider.dataset.panel !== 'divider') {
    panelDivider.dataset.panel = 'divider';
    panelDivider.innerHTML = `
      <div class="bm-section">
        <h4>Gap (mm)</h4>
        <div class="bm-grid">
          <div class="bm-field">
            <label>Gap</label>
            <input id="divider-gap-input" type="number" min="0" max="50" step="0.5" value="0" />
          </div>
        </div>
      </div>`;
    panelDivider.querySelector('#divider-gap-input')!.addEventListener('change', () => {
      const input = panelDivider.querySelector('#divider-gap-input') as HTMLInputElement;
      const gap = parseFloat(input.value);
      if (!isNaN(gap)) {
        undoManager.snapshot();
        editor.set_selected_segment_gap(Math.max(0, gap));
        redraw();
      }
    });
    panelDivider.querySelector('#divider-gap-input')!.addEventListener('focusin', () => {
      undoManager.snapshot();
    });
  }
  const gap = editor.get_selected_segment_gap();
  (panelDivider.querySelector('#divider-gap-input') as HTMLInputElement).value = gap.toFixed(2);
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

const footer = new Footer(
  document.getElementById('spread-thumbnails')!,
  document.getElementById('btn-prev-spread') as HTMLButtonElement,
  document.getElementById('btn-next-spread') as HTMLButtonElement,
  (idx) => {
    if (idx < 0 || idx >= editor.get_spread_count()) return;
    inlineEditor.stop();
    editor.set_current_spread(idx);
    refreshBoxModel();
    redraw();
  },
);

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

const undoManager = new UndoManager(
  editor,
  document.getElementById('btn-undo') as HTMLButtonElement,
  document.getElementById('btn-redo') as HTMLButtonElement,
);

// Wire undo/redo into keyboard shortcuts.
document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT'
    || (e.target as HTMLElement).tagName === 'TEXTAREA') return;

  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    undoManager.undo(); refreshBoxModel(); redraw(); e.preventDefault(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
    undoManager.redo(); refreshBoxModel(); redraw(); e.preventDefault(); return;
  }
});

// ---------------------------------------------------------------------------
// Inline text editor
// ---------------------------------------------------------------------------

const inlineEditor = new InlineEditor(
  document.getElementById('canvas-area')!,
  editor,
  renderer,
  {
    snapshot:       () => undoManager.snapshot(),
    redraw,
    refreshBoxModel,
    spreadRect,
    showTextEditor: (el) => textEditor.show(el),
  },
);

// ---------------------------------------------------------------------------
// Canvas mouse events — interaction state machine
// ---------------------------------------------------------------------------

let currentMode: InteractionMode = idleMode;
let modeState: ModeState = {};

function setMode(mode: InteractionMode, state: ModeState): void {
  if (currentMode === cutToolMode && mode !== cutToolMode) {
    updateCutToolButton(false);
  }
  currentMode = mode;
  modeState = state;
}

function toSpread(e: MouseEvent) {
  const sr = spreadRect();
  const rect = canvasEl.getBoundingClientRect();
  const relX = (e.clientX - rect.left) - sr.x;
  const relY = (e.clientY - rect.top)  - sr.y;
  return { sr, relX, relY, canvasX: sr.x + relX, canvasY: sr.y + relY };
}

const interactionCtx = (): Omit<InteractionContext, 'modeState'> => ({
  editor, renderer, overlays, canvasEl, spreadRect, toSpread,
  snapshot: () => undoManager.snapshot(), refreshBoxModel, redraw,
  setMode,
  onTextSelected: (id: number) => {
    renderer.selectedTextIds = new Set([id]);
    refreshBoxModel();
    redraw();
  },
  onTextChanged: () => {
    const firstId = renderer.selectedTextIds.values().next().value as number | undefined;
    if (firstId !== undefined) {
      const textElements = getTextElements(editor);
      const el = textElements.find(t => t.id === firstId);
      if (el) textEditor.show(el);
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
    dpiTooltip.style.top  = (e.clientY - 10) + 'px';
  } else {
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
  e.dataTransfer!.dropEffect = 'copy';
});

canvasEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const raw = e.dataTransfer!.getData('text/plain');
  if (!raw) return;

  // Payload is always a JSON array of image IDs (one or more).
  let imageIds: string[];
  try {
    const parsed: unknown = JSON.parse(raw);
    imageIds = Array.isArray(parsed) ? (parsed as string[]) : [raw];
  } catch {
    imageIds = [raw];
  }

  const sr = spreadRect();
  const canvasRect = canvasEl.getBoundingClientRect();
  const relX = (e.clientX - canvasRect.left) - sr.x;
  const relY = (e.clientY - canvasRect.top)  - sr.y;

  const hitId = editor.hit_test(relX, relY, sr.w, sr.h);
  if (hitId === NULL_ID) return;

  undoManager.snapshot();

  if (imageIds.length === 1) {
    // Single image — assign directly without splitting.
    const id = imageIds[0];
    const proxy = sidebar.getProxy(id);
    if (proxy) renderer.cacheImage(id, proxy);
    editor.assign_image(hitId, id);
    editor.select_face(hitId);
    refreshBoxModel();
    redraw();
    sidebar.ensureDimensions(id).then(dims => {
      if (dims) { editor.register_image_size(id, dims[0], dims[1]); redraw(); }
    });
  } else {
    // Multiple images — split the target frame, then assign one image per leaf.
    // First cut direction follows the frame's aspect ratio.
    const frames = getRenderList(editor, sr.w, sr.h);
    const target = frames.find(f => f.id === hitId);
    const preferVertical = target ? target.rect.w >= target.rect.h : true;

    const leafIds = splitFaceForMultiDrop(editor, hitId, imageIds.length, preferVertical);

    for (let i = 0; i < leafIds.length && i < imageIds.length; i++) {
      const imgId  = imageIds[i];
      const faceId = leafIds[i];
      const proxy  = sidebar.getProxy(imgId);
      if (proxy) renderer.cacheImage(imgId, proxy);
      editor.assign_image(faceId, imgId);
      sidebar.ensureDimensions(imgId).then(dims => {
        if (dims) { editor.register_image_size(imgId, dims[0], dims[1]); redraw(); }
      });
    }

    if (leafIds.length > 0) editor.select_face(leafIds[0]);
    refreshBoxModel();
    redraw();
  }
});

canvasEl.addEventListener('dblclick', (e) => {
  const rect = canvasEl.getBoundingClientRect();
  const textHit = renderer.hitTestText(e.clientX - rect.left, e.clientY - rect.top);
  if (textHit && textHit.part === 'body') {
    renderer.selectedTextIds = new Set([textHit.id]);
    editor.select_face(NULL_ID);
    refreshBoxModel();
    inlineEditor.start(textHit.id);
  }
});

canvasEl.addEventListener('mouseleave', (e) => {
  currentMode.onMouseLeave(e, { ...interactionCtx(), modeState });
  // Keep cutToolMode active when leaving the canvas so the tool stays selected
  if (currentMode !== cutToolMode) setMode(idleMode, {});
  dpiTooltip.hidden = true;
});

// ---------------------------------------------------------------------------
// Cut tool state helper
// ---------------------------------------------------------------------------

function updateCutToolButton(active: boolean): void {
  document.getElementById('btn-cut-tool')!.classList.toggle('active', active);
}

// ---------------------------------------------------------------------------
// Keyboard events
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT'
    || (e.target as HTMLElement).tagName === 'TEXTAREA') return;

  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    editor.select_all();
    renderer.selectedTextIds = new Set(getTextElements(editor).map(t => t.id));
    refreshBoxModel(); redraw(); e.preventDefault(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { setZoom(renderer.zoom * 1.25); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === '-') { setZoom(renderer.zoom / 1.25); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === '0') { setZoom(1.0); e.preventDefault(); return; }

  let handled = true;

  switch (e.key) {
    case 'k':
    case 'K': {
      if (currentMode === cutToolMode) {
        overlays.splitPreview = null;
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
        updateCutToolButton(false);
      } else {
        setMode(cutToolMode, { numCuts: 1, nodeId: NULL_ID, axis: null, ratio: null });
        canvasEl.style.cursor = 'crosshair';
        updateCutToolButton(true);
      }
      redraw();
      break;
    }
    case 't':
    case 'T': {
      canvasEl.style.cursor = 'crosshair';
      setMode(textPlaceMode, {});
      break;
    }
    case 'Escape': {
      if (currentMode === cutToolMode || currentMode === splitPreviewMode) {
        overlays.splitPreview = null;
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
        updateCutToolButton(false);
        redraw();
      } else if (currentMode === textPlaceMode) {
        canvasEl.style.cursor = 'default';
        setMode(idleMode, {});
      } else if (renderer.selectedTextIds.size > 0) {
        renderer.selectedTextIds.clear();
        refreshBoxModel();
        redraw();
      } else if (editor.get_selected_segment_count() > 0) {
        editor.select_segment(NULL_ID);
        refreshBoxModel();
        redraw();
      } else {
        editor.select_face(NULL_ID);
        refreshBoxModel();
        redraw();
      }
      break;
    }
    case 'Delete':
    case 'Backspace': {
      if (renderer.selectedTextIds.size > 0) {
        undoManager.snapshot();
        for (const id of renderer.selectedTextIds) deleteTextElement(editor, id);
        renderer.selectedTextIds.clear();
        refreshBoxModel();
        redraw();
      } else if (editor.get_selected_segment_count() > 0) {
        undoManager.snapshot();
        editor.delete_selected_segment();
        refreshBoxModel();
        redraw();
      } else {
        undoManager.snapshot();
        editor.delete_selected();
        refreshBoxModel();
        redraw();
      }
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

document.getElementById('btn-add-spread')!.addEventListener('click', () => {
  undoManager.snapshot();
  editor.add_page();
  redraw();
});

document.getElementById('btn-add-text')!.addEventListener('click', () => {
  canvasEl.style.cursor = 'crosshair';
  setMode(textPlaceMode, {});
});

document.getElementById('btn-cut-tool')!.addEventListener('click', () => {
  if (currentMode === cutToolMode) {
    overlays.splitPreview = null;
    canvasEl.style.cursor = 'default';
    setMode(idleMode, {});
    updateCutToolButton(false);
  } else {
    setMode(cutToolMode, { numCuts: 1, nodeId: NULL_ID, axis: null, ratio: null });
    canvasEl.style.cursor = 'crosshair';
    updateCutToolButton(true);
  }
  redraw();
});

document.getElementById('btn-export-pdf')!.addEventListener('click', () => {
  exportPdf(editor, () => sidebar.buffersForExport());
});

document.getElementById('btn-debug-dump')!.addEventListener('click', () => {
  const dump = editor.get_debug_layout_dump();
  const blob = new Blob([dump], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'grid-debug.txt' });
  a.click();
  URL.revokeObjectURL(url);
});

const docsPanel = new DocsPanel();
document.getElementById('btn-docs')!.addEventListener('click', () => docsPanel.open());

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

function setZoom(z: number): void {
  inlineEditor.stop();
  renderer.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  document.getElementById('zoom-label')!.textContent = Math.round(renderer.zoom * 100) + '%';
  redraw();
}

document.getElementById('btn-zoom-in')!.addEventListener('click',  () => setZoom(renderer.zoom * 1.25));
document.getElementById('btn-zoom-out')!.addEventListener('click', () => setZoom(renderer.zoom / 1.25));
document.getElementById('btn-zoom-fit')!.addEventListener('click', () => setZoom(1.0));

canvasEl.addEventListener('wheel', (e) => {
  if (currentMode.onWheel) {
    currentMode.onWheel(e, { ...interactionCtx(), modeState });
    if (e.defaultPrevented) return;
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
  if (hitId === NULL_ID) return;

  e.preventDefault();

  const t = JSON.parse(editor.get_frame_transform(hitId)) as { pan_x: number; pan_y: number; scale: number; rotation_deg: number };
  if (!t) return;

  if (e.shiftKey) {
    const delta = e.deltaY > 0 ? 0.5 : -0.5;
    undoManager.snapshot();
    editor.set_image_transform(hitId, t.pan_x, t.pan_y, t.scale, t.rotation_deg + delta);
  } else {
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
document.getElementById('canvas-area')!.appendChild(randomizeDialog);

let _rdField: 'rotation' = 'rotation';

const RD_DEFAULTS: Record<string, { title: string; min: string; max: string; step: string }> = {
  'rotation': { title: 'Randomize Rotation', min: '-15',  max: '15',  step: '0.5'  },
};

function showRandomizeDialog(field: 'rotation'): void {
  _rdField = field;
  const d = RD_DEFAULTS[field];
  randomizeDialog.querySelector<HTMLElement>('#rd-title')!.textContent = d.title;
  const minEl = randomizeDialog.querySelector<HTMLInputElement>('#rd-min')!;
  const maxEl = randomizeDialog.querySelector<HTMLInputElement>('#rd-max')!;
  minEl.value = d.min; minEl.step = d.step;
  maxEl.value = d.max; maxEl.step = d.step;
  randomizeDialog.hidden = false;
}

randomizeDialog.querySelector('#rd-cancel')!.addEventListener('click', () => {
  randomizeDialog.hidden = true;
});

randomizeDialog.querySelector('#rd-apply')!.addEventListener('click', () => {
  randomizeDialog.hidden = true;
  const minVal = parseFloat((randomizeDialog.querySelector<HTMLInputElement>('#rd-min')!).value);
  const maxVal = parseFloat((randomizeDialog.querySelector<HTMLInputElement>('#rd-max')!).value);
  if (isNaN(minVal) || isNaN(maxVal) || minVal > maxVal) return;

  const selected = getAllSelected(editor);
  if (selected.length < 2) return;

  undoManager.snapshot();
  for (const nodeId of selected) {
    const randVal = minVal + Math.random() * (maxVal - minVal);
    editor.set_face_frame_rotation(nodeId, randVal);
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
    if (families.length > 0) textEditor.setFontFamilies(families);
  });
}
