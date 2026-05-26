// main.ts — App bootstrap: initialises Wasm and wires all UI modules together.

import init, { PhotobookEditor, init_panic_hook } from './pkg/photobook_core.js';
import { CanvasRenderer } from './canvas.js';
import { ImageSidebar } from './sidebar-left.js';
import { BoxModelEditor, DividerPanel, ProjectSettingsPanel, SpreadSettingsPanel, TextElementEditor, SidebarPhotoInfoPanel } from './sidebar-right.js';
import type { ProjectSettingsData, SpreadSettingsData } from './sidebar-right.js';
import { Footer } from './footer.js';
import { NULL_ID, ZOOM_MIN, ZOOM_MAX } from './constants.js';
import { idleMode, splitPreviewMode, cutToolMode, textPlaceMode } from './interaction.js';
import type { InteractionMode, ModeState, InteractionContext } from './interaction.js';
import { getSpreadInfo, getTextElements, addTextElement, deleteTextElement, updateTextElement, getAllSelected, getPageSizeMm, getSpreadMargin, getUsedImageIds, splitFaceForMultiDrop, getRenderList } from './wasm-bridge.js';
import type { Overlays, DropZone, Rect } from './types.js';
import { loadLocalFonts, localFontsSupported, tryLoadLocalFonts } from './fonts.js';
import { UndoManager } from './undo.js';
import { InlineEditor } from './inline-editor.js';
import { exportPdf } from './export.js';
import { DocsPanel } from './docs-panel.js';
import { saveProject, openProject } from './project-io.js';
import { ImageLoaderModal } from './image-loader-modal.js';
import { RandomizeDialog } from './randomize-dialog.js';

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

const overlays: Overlays = { marqueeRect: null, splitPreview: null, swapOverlay: null, edgeDragPreview: null, imageDropPreview: null };



function fitCanvas(): void {
  const area = document.getElementById('canvas-center')!;
  renderer.resize(area.clientWidth, area.clientHeight);
  redraw();
}

function redraw(): void {
  renderer.draw(editor, overlays);
  footer.update(editor, renderer);
}

window.addEventListener('resize', fitCanvas);

function spreadRect() {
  const info = getSpreadInfo(editor);
  const sr = renderer.spreadRect(info);
  if (!info.endpaper_side) return sr;
  const offsetX = info.endpaper_side === 'left' ? sr.w / 2 : 0;
  return { x: sr.x + offsetX, y: sr.y, w: sr.w / 2, h: sr.h };
}

function computeDropZone(mx: number, my: number, faceRect: Rect): DropZone {
  const rx = (mx - faceRect.x) / faceRect.w;
  const ry = (my - faceRect.y) / faceRect.h;
  const dl = rx, dr = 1 - rx, dt = ry, db = 1 - ry;
  const minEdge = Math.min(dl, dr, dt, db);
  if (minEdge > 0.25) return 'center';
  if (minEdge === dl) return 'left';
  if (minEdge === dr) return 'right';
  if (minEdge === dt) return 'top';
  return 'bottom';
}

// ---------------------------------------------------------------------------
// Image sidebar
// ---------------------------------------------------------------------------

const sidebar = new ImageSidebar(
  document.getElementById('image-grid')!,
  document.getElementById('folder-breadcrumb')!,
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

// ---------------------------------------------------------------------------
// Image-loader modal
// ---------------------------------------------------------------------------

const imageLoaderModal = new ImageLoaderModal(
  async (id, buf) => {
    await sidebar.loadImageFromBuffer(id, buf);
  },
  () => {
    checkMissingImages();
    redraw();
  },
  async (handle) => {
    await sidebar.openFolderHandle(handle);
  },
  async (files) => {
    await sidebar.openFolderFallback(files);
  },
);

// ---------------------------------------------------------------------------
// Missing-images banner
// ---------------------------------------------------------------------------

const missingBanner     = document.getElementById('missing-images-banner')!;
const missingBannerText = document.getElementById('missing-images-text')!;

function showMissingImagesBanner(missingIds: string[]): void {
  const count = missingIds.length;
  missingBannerText.textContent = `${count} image${count === 1 ? '' : 's'} used in this project could not be found. Open the image folder to restore them.`;
  missingBanner.hidden = false;
}

function hideMissingImagesBanner(): void {
  missingBanner.hidden = true;
}

function checkMissingImages(): void {
  const usedIds: string[] = JSON.parse(editor.get_used_image_ids());
  const loadedIds = new Set(sidebar.loadedImageIds());
  const missing = usedIds.filter(id => !loadedIds.has(id));
  if (missing.length > 0) showMissingImagesBanner(missing);
  else hideMissingImagesBanner();
}

document.getElementById('btn-open-folder-banner')!.addEventListener('click', async () => {
  await sidebar.openFolder();
  checkMissingImages();
  redraw();
});

document.getElementById('btn-dismiss-banner')!.addEventListener('click', () => {
  hideMissingImagesBanner();
});

document.getElementById('btn-open-folder')!.addEventListener('click', async () => {
  await sidebar.openFolder();
  checkMissingImages();
  redraw();
});

// ---------------------------------------------------------------------------
// Missing-font toast
// ---------------------------------------------------------------------------

const fontToast     = document.getElementById('font-toast')!;
const fontToastText = document.getElementById('font-toast-text')!;

document.getElementById('btn-dismiss-font-toast')!.addEventListener('click', () => {
  fontToast.hidden = true;
});

async function checkMissingFonts(): Promise<void> {
  fontToast.hidden = true;
  if (!localFontsSupported()) return;
  const textElements = getTextElements(editor);
  if (textElements.length === 0) return;
  const usedFamilies = [...new Set(textElements.map(el => el.font_family))];
  const availableFamilies = await loadLocalFonts();
  if (availableFamilies.length === 0) return; // permission denied or API unavailable
  const missing = usedFamilies.filter(f => !availableFamilies.includes(f));
  if (missing.length === 0) return;
  fontToastText.textContent = `Font${missing.length === 1 ? '' : 's'} not installed: ${missing.join(', ')}. PDF export will use a fallback font.`;
  fontToast.hidden = false;
}

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

const randomizeDialog = new RandomizeDialog(
  document.getElementById('canvas-center')!,
  editor,
  (nodeIds, min, max, field) => {
    undoManager.snapshot();
    for (const nodeId of nodeIds) {
      const value = min + Math.random() * (max - min);
      if (field === 'rotation') {
        editor.set_face_frame_rotation(nodeId, value);
      } else {
        editor.set_face_box_model_field(nodeId, field, value);
      }
    }
    refreshBoxModel();
    redraw();
  },
);

function currentProjectSettings(): ProjectSettingsData {
  const pageSize = getPageSizeMm(editor);
  return {
    page_width_mm:     pageSize.width_mm,
    page_height_mm:    pageSize.height_mm,
    bleed_mm:          editor.get_bleed_mm(),
    safe_zone_mm:      editor.get_safe_zone_mm(),
    spine_mm_per_page: editor.get_spine_mm_per_page(),
    spine_min_mm:      editor.get_spine_min_mm(),
    margin_step_mm:    editor.get_margin_step_mm(),
    print_dpi:         editor.get_print_dpi(),
    endpapers:         editor.get_endpapers(),
  };
}

function currentSpreadSettings(): SpreadSettingsData {
  const margin = getSpreadMargin(editor);
  return {
    margin_top:    margin.top,
    margin_right:  margin.right,
    margin_bottom: margin.bottom,
    margin_left:   margin.left,
    left_bg:  editor.get_spread_left_bg(),
    right_bg: editor.get_spread_right_bg(),
  };
}

function wireRightSidebar() {
  function editorCallback<T>(action: (data: T) => void): (data: T) => void {
    return (data) => { action(data); redraw(); };
  }

  const boxEditor = new BoxModelEditor(
    panelFace,
    editorCallback((json: string) => {
      undoManager.snapshot();
      editor.set_face_box_model(json);
    }),
    (direction) => {
      const sel = editor.get_selected();
      if (sel === NULL_ID) return;
      undoManager.snapshot();
      editor.move_face_z_order(sel, direction);
      refreshBoxModel();
      redraw();
    },
    (field) => { randomizeDialog.show(field); },
    (transform) => {
      undoManager.snapshot();
      switch (transform) {
        case 'flip-h':     editor.flip_selection_h();   break;
        case 'flip-v':     editor.flip_selection_v();   break;
        case 'rotate-cw':  editor.rotate_selection_cw();  break;
        case 'rotate-ccw': editor.rotate_selection_ccw(); break;
      }
      redraw();
    },
  );

  const dividerPanel = new DividerPanel(
    panelDivider,
    (gap) => { undoManager.snapshot(); editor.set_selected_segment_gap(gap); redraw(); },
  );

  const spreadPanel = new SpreadSettingsPanel(
    panelProject,
    (data: SpreadSettingsData) => {
      undoManager.snapshot();
      editor.set_spread_margin(data.margin_top, data.margin_right, data.margin_bottom, data.margin_left);
      editor.set_spread_left_bg(data.left_bg);
      editor.set_spread_right_bg(data.right_bg);
      redraw();
    },
  );

  const psmContentEl = document.getElementById('psm-content')!;
  const projectPanel = new ProjectSettingsPanel(
    psmContentEl,
    (data: ProjectSettingsData) => {
      undoManager.snapshot();
      editor.set_page_settings(
        data.page_width_mm, data.page_height_mm,
        data.bleed_mm, data.safe_zone_mm,
        data.spine_mm_per_page, data.spine_min_mm,
        data.margin_step_mm, data.print_dpi,
      );
      redraw();
    },
  );
  projectPanel.setBleedToggleHandler(editorCallback((show: boolean) => { renderer.showBleed = show; }));
  projectPanel.setSafeZoneToggleHandler(editorCallback((show: boolean) => { renderer.showSafeZone = show; }));
  projectPanel.setEndpapersToggleHandler((enabled: boolean) => {
    undoManager.snapshot();
    editor.set_endpapers(enabled);
    redraw();
  });

  const projectSettingsModal = document.getElementById('project-settings-modal') as HTMLDialogElement;
  document.getElementById('btn-project-settings')!.addEventListener('click', () => {
    projectPanel.show(currentProjectSettings());
    projectSettingsModal.showModal();
  });
  document.getElementById('btn-psm-close')!.addEventListener('click', () => { projectSettingsModal.close(); });
  projectSettingsModal.addEventListener('click', (e) => {
    if (e.target === projectSettingsModal) projectSettingsModal.close();
  });

  const photoPanel = new SidebarPhotoInfoPanel(panelPhoto, sidebar);

  const textEditor = new TextElementEditor(
    panelText,
    editorCallback((updatedEl) => {
      undoManager.snapshot();
      const textElements = getTextElements(editor);
      updateTextElement(editor, updatedEl);
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

  return { boxEditor, dividerPanel, spreadPanel, projectPanel, photoPanel, textEditor };
}

const { boxEditor, dividerPanel, spreadPanel, projectPanel, photoPanel, textEditor } = wireRightSidebar();

// ---------------------------------------------------------------------------
// Sidebar — shows all applicable panels for the current selection
// ---------------------------------------------------------------------------

function refreshBoxModel(): void {
  const hasFaces   = editor.get_selection_count() > 0;
  const hasTexts   = renderer.selectedTextIds.size > 0;
  const hasDivider = editor.get_selected_segment_count() > 0;
  if (hasFaces || hasTexts || hasDivider) {
    sidebar.clearSelection();
    footerSpreadSelected = false;
  }
  const sidebarIds = sidebar.getSelectedIds();
  const hasPhotos  = sidebarIds.size > 0;
  if (hasPhotos) footerSpreadSelected = false;
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
  if (hasNothing) parts.push('Spread Settings');
  sidebarRightHeader.textContent = parts.join(' · ');

  if (hasFaces) {
    const selectionCount  = editor.get_selection_count();
    const bmJson          = editor.get_face_box_model();
    const sel             = editor.get_selected();
    const zIndex          = (selectionCount === 1 && sel !== NULL_ID)
      ? editor.get_face_z_index(sel) : undefined;
    const selectionIsRect = selectionCount > 1 && editor.selection_is_rectangular();
    boxEditor.update(bmJson, zIndex, selectionCount, selectionIsRect);
  }

  if (hasTexts) {
    const textElements = getTextElements(editor);
    const firstId = renderer.selectedTextIds.values().next().value as number;
    const el = textElements.find(t => t.id === firstId);
    if (el) textEditor.show(el);
    else renderer.selectedTextIds.clear();
  }

  if (hasDivider) dividerPanel.show(editor.get_selected_segment_gap());
  if (showPhoto)  photoPanel.show(sidebarIds);
  if (hasNothing) spreadPanel.show(currentSpreadSettings());

  // Keep the green tick badges in sync with placed images.
  sidebar.updateUsedBadges(getUsedImageIds(editor));
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

const footer = new Footer(
  document.getElementById('spread-thumbnails')!,
  document.getElementById('btn-prev-spread') as HTMLButtonElement,
  document.getElementById('btn-next-spread') as HTMLButtonElement,
  document.getElementById('btn-add-spread') as HTMLButtonElement,
  document.getElementById('btn-remove-spread') as HTMLButtonElement,
  document.getElementById('spread-count-label')!,
  (idx) => {
    if (idx < 0 || idx >= editor.get_spread_count()) return;
    inlineEditor.stop();
    editor.set_current_spread(idx);
    refreshBoxModel();
    redraw();
    footerSpreadSelected = true;
  },
  (from, to) => {
    undoManager.snapshot();
    editor.move_spread(from, to);
    redraw();
  },
);

// ---------------------------------------------------------------------------
// Delete-spread confirmation dialog
// ---------------------------------------------------------------------------

let footerSpreadSelected = false;

const deleteSpreadDialog = document.createElement('dialog');
deleteSpreadDialog.className = 'confirm-dialog';
deleteSpreadDialog.innerHTML = `
  <p>Delete this spread?</p>
  <div class="confirm-dialog-actions">
    <button id="btn-dsd-cancel">Cancel</button>
    <button id="btn-dsd-confirm" class="btn-danger">Delete</button>
  </div>
`;
document.body.appendChild(deleteSpreadDialog);

deleteSpreadDialog.querySelector('#btn-dsd-cancel')!.addEventListener('click', () => {
  deleteSpreadDialog.close();
});
deleteSpreadDialog.querySelector('#btn-dsd-confirm')!.addEventListener('click', () => {
  deleteSpreadDialog.close();
  const idx = footer.currentIdx;
  undoManager.snapshot();
  editor.remove_page(idx);
  footerSpreadSelected = false;
  refreshBoxModel();
  redraw();
});

const cannotDeleteDialog = document.createElement('dialog');
cannotDeleteDialog.className = 'confirm-dialog';
cannotDeleteDialog.innerHTML = `
  <p id="cannot-delete-msg"></p>
  <div class="confirm-dialog-actions">
    <button id="btn-cdd-ok">OK</button>
  </div>
`;
document.body.appendChild(cannotDeleteDialog);
cannotDeleteDialog.querySelector('#btn-cdd-ok')!.addEventListener('click', () => {
  cannotDeleteDialog.close();
});

const fontAccessWarningDialog = document.createElement('dialog');
fontAccessWarningDialog.className = 'confirm-dialog';
fontAccessWarningDialog.innerHTML = `
  <p id="font-warning-msg"></p>
  <div class="confirm-dialog-actions">
    <button id="btn-faw-ok">OK</button>
  </div>
`;
document.body.appendChild(fontAccessWarningDialog);
fontAccessWarningDialog.querySelector('#btn-faw-ok')!.addEventListener('click', () => {
  fontAccessWarningDialog.close();
});

function showFontAccessWarning(code: 'not_supported' | 'denied'): void {
  const msg = fontAccessWarningDialog.querySelector<HTMLElement>('#font-warning-msg')!;
  if (code === 'not_supported') {
    msg.textContent = 'Your browser does not support the Local Font Access API. This feature is currently available in Chrome and Edge.';
  } else {
    msg.textContent = 'Permission to access local fonts was denied. You can allow access in your browser\'s site settings.';
  }
  fontAccessWarningDialog.showModal();
}

function showCannotDeleteReason(): void {
  const min = editor.get_endpapers() ? 3 : 2;
  const msg = cannotDeleteDialog.querySelector<HTMLElement>('#cannot-delete-msg')!;
  if (footer.currentIdx === 0) {
    msg.textContent = 'The first spread cannot be deleted.';
  } else if (editor.get_spread_count() <= min) {
    msg.textContent = 'This spread cannot be deleted — the book must contain at least one content spread.';
  } else {
    return;
  }
  cannotDeleteDialog.showModal();
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

const undoManager = new UndoManager(
  editor,
  document.getElementById('btn-undo') as HTMLButtonElement,
  document.getElementById('btn-redo') as HTMLButtonElement,
);


// ---------------------------------------------------------------------------
// Inline text editor
// ---------------------------------------------------------------------------

const inlineEditor = new InlineEditor(
  document.getElementById('canvas-center')!,
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

  const layoutRect = renderer.lastLayoutRect;
  if (!layoutRect.w) return;
  const canvasRect = canvasEl.getBoundingClientRect();
  const relX = (e.clientX - canvasRect.left) - layoutRect.x;
  const relY = (e.clientY - canvasRect.top)  - layoutRect.y;
  const hitId = editor.hit_test(relX, relY, layoutRect.w, layoutRect.h);

  if (hitId === NULL_ID) {
    if (overlays.imageDropPreview !== null) { overlays.imageDropPreview = null; redraw(); }
    return;
  }

  const frame = renderer.getFrameById(hitId);
  if (!frame) { overlays.imageDropPreview = null; return; }

  const hasExistingImage = frame.image_id !== undefined;
  const zone = computeDropZone(relX, relY, frame.face_rect);

  const prev = overlays.imageDropPreview;
  if (!prev || prev.zone !== zone || prev.frameRect !== frame.face_rect) {
    overlays.imageDropPreview = { frameRect: frame.face_rect, zone, hasExistingImage };
    redraw();
  }
});

canvasEl.addEventListener('dragleave', () => {
  if (overlays.imageDropPreview !== null) { overlays.imageDropPreview = null; redraw(); }
});

canvasEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const raw = e.dataTransfer!.getData('text/plain');
  if (!raw) return;

  const dropPreview = overlays.imageDropPreview;
  overlays.imageDropPreview = null;

  // Payload is always a JSON array of image IDs (one or more).
  let imageIds: string[];
  try {
    const parsed: unknown = JSON.parse(raw);
    imageIds = Array.isArray(parsed) ? (parsed as string[]) : [raw];
  } catch {
    imageIds = [raw];
  }

  const layoutRect = renderer.lastLayoutRect;
  const canvasRect = canvasEl.getBoundingClientRect();
  const relX = (e.clientX - canvasRect.left) - layoutRect.x;
  const relY = (e.clientY - canvasRect.top)  - layoutRect.y;

  const hitId = editor.hit_test(relX, relY, layoutRect.w, layoutRect.h);
  if (hitId === NULL_ID) return;

  undoManager.snapshot();

  if (imageIds.length === 1) {
    const id = imageIds[0];
    const zone = dropPreview?.zone ?? 'center';
    const existingImageId = renderer.getFrameById(hitId)?.image_id;

    const proxy = sidebar.getProxy(id);
    if (proxy) renderer.cacheImage(id, proxy);

    if (zone !== 'center') {
      // Edge drop: split and place new image bordering the chosen edge.
      const preferVertical = zone === 'left' || zone === 'right';
      const faceIds = splitFaceForMultiDrop(editor, hitId, 2, preferVertical);
      // faceIds[0] = leading (left or top), retains the existing image.
      // faceIds[1] = trailing (right or bottom), starts empty.
      if (zone === 'left' || zone === 'top') {
        if (existingImageId) editor.assign_image(faceIds[1], existingImageId);
        editor.assign_image(faceIds[0], id);
        editor.select_face(faceIds[0]);
      } else {
        editor.assign_image(faceIds[1], id);
        editor.select_face(faceIds[1]);
      }
    } else {
      // Center drop or empty frame: replace.
      editor.assign_image(hitId, id);
      editor.select_face(hitId);
    }

    refreshBoxModel();
    redraw();
    sidebar.ensureDimensions(id).then(dims => {
      if (dims) { editor.register_image_size(id, dims[0], dims[1]); redraw(); }
    });
  } else {
    // Multiple images — split the target frame, then assign one image per leaf.
    // First cut direction follows the frame's aspect ratio.
    const frames = getRenderList(editor, layoutRect.w, layoutRect.h);
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

  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    undoManager.undo(); refreshBoxModel(); redraw(); e.preventDefault(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
    undoManager.redo(); refreshBoxModel(); redraw(); e.preventDefault(); return;
  }
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
    case 'n':
    case 'N': {
      undoManager.snapshot();
      editor.add_page();
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
      if (footerSpreadSelected && footer.currentIdx > 0 && editor.get_spread_count() > (editor.get_endpapers() ? 3 : 2)) {
        deleteSpreadDialog.showModal();
        break;
      }
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
    case 'ArrowLeft':
    case 'ArrowUp': {
      const idx = editor.get_current_spread_index();
      if (idx > 0) {
        inlineEditor.stop();
        editor.set_current_spread(idx - 1);
        footer.update(editor, renderer);
        refreshBoxModel(); redraw();
      }
      break;
    }
    case 'ArrowRight':
    case 'ArrowDown': {
      const idx = editor.get_current_spread_index();
      if (idx < editor.get_spread_count() - 1) {
        inlineEditor.stop();
        editor.set_current_spread(idx + 1);
        footer.update(editor, renderer);
        refreshBoxModel(); redraw();
      }
      break;
    }
    default: handled = false;
  }

  if (handled) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

let lastSaveName = 'project';

{
  const dlg    = document.getElementById('save-name-dialog') as HTMLDialogElement;
  const input  = document.getElementById('save-name-input')  as HTMLInputElement;
  const btnOk  = document.getElementById('btn-save-name-ok')     as HTMLButtonElement;
  const btnCan = document.getElementById('btn-save-name-cancel') as HTMLButtonElement;

  document.getElementById('btn-save-project')!.addEventListener('click', () => {
    input.value = lastSaveName;
    dlg.showModal();
    input.select();
  });

  const doSave = async () => {
    const name = input.value.trim() || 'project';
    lastSaveName = name;
    dlg.close();
    await saveProject(editor, name);
  };

  btnOk.addEventListener('click', doSave);
  btnCan.addEventListener('click', () => dlg.close());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
  });
}

document.getElementById('btn-open-project')!.addEventListener('click', async () => {
  const result = await openProject(editor);
  if (!result.ok) {
    if (result.reason === 'cancelled') return;
    if (result.reason === 'version_too_new') {
      alert('This file was saved by a newer version of Photobook and cannot be opened.');
    } else if (result.reason === 'wrong_format') {
      alert('Not a valid Photobook file.');
    } else {
      alert('Could not open the project file.');
    }
    return;
  }

  sidebar.clearLoadedImages(); // discard images from any previous project session
  undoManager.reset();
  refreshBoxModel();
  checkMissingFonts();
  footer.update(editor, renderer);
  redraw();

  // Show the image-loader modal for any images not already in the sidebar.
  const usedIds: string[] = JSON.parse(editor.get_used_image_ids());
  const loadedIds = new Set(sidebar.loadedImageIds());
  const missing = usedIds.filter(id => !loadedIds.has(id));
  if (missing.length > 0) {
    imageLoaderModal.open(missing);
    // checkMissingImages() and redraw() are called by the modal's onClose callback.
  } else {
    checkMissingImages();
  }
});

document.getElementById('btn-add-spread')!.addEventListener('click', () => {
  undoManager.snapshot();
  editor.add_page();
  editor.set_current_spread(editor.get_spread_count() - 1);
  redraw();
});

document.getElementById('btn-remove-spread')!.addEventListener('click', () => {
  if (footer.currentIdx > 0 && editor.get_spread_count() > (editor.get_endpapers() ? 3 : 2)) {
    deleteSpreadDialog.showModal();
  } else {
    showCannotDeleteReason();
  }
});

document.getElementById('btn-add-text')!.addEventListener('click', () => {
  const spreadInfo = getSpreadInfo(editor);
  const layoutMm = spreadInfo.endpaper_side ? spreadInfo.page_width_mm : spreadInfo.width_mm;
  const layoutOffsetMm = spreadInfo.endpaper_side === 'left' ? spreadInfo.page_width_mm : 0;
  let x_mm = layoutOffsetMm + layoutMm / 2;
  let y_mm = spreadInfo.height_mm / 2;
  const existing = getTextElements(editor);
  const OFFSET_MM = 5;
  while (existing.some(t => Math.abs(t.x_mm - x_mm) < 1 && Math.abs(t.y_mm - y_mm) < 1)) {
    x_mm += OFFSET_MM;
    y_mm += OFFSET_MM;
  }
  undoManager.snapshot();
  const newId = addTextElement(editor, x_mm, y_mm);
  renderer.selectedTextIds = new Set([newId]);
  editor.select_face(0xFFFFFFFF);
  refreshBoxModel();
  redraw();
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

  const layoutRect = renderer.lastLayoutRect;
  const rect = canvasEl.getBoundingClientRect();
  const relX = (e.clientX - rect.left) - layoutRect.x;
  const relY = (e.clientY - rect.top)  - layoutRect.y;
  const hitId = editor.hit_test(relX, relY, layoutRect.w, layoutRect.h);
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
// Boot
// ---------------------------------------------------------------------------

fitCanvas();
refreshBoxModel();

textEditor.setLoadFontsHandler(async () => {
  const result = await tryLoadLocalFonts();
  if (result.error !== null) {
    showFontAccessWarning(result.error);
    return;
  }
  if (result.families.length > 0) textEditor.setFontFamilies(result.families);
});
