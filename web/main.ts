// main.ts — App bootstrap: initialises Wasm and wires all UI modules together.

import init, { PhotobookEditor, init_panic_hook } from './pkg/photobook_core.js';
import './num-input.js';
import { CanvasRenderer } from './canvas.js';
import { ImageSidebar } from './sidebar-left.js';
import { BoxModelEditor, DividerPanel, ProjectSettingsPanel, SpreadSettingsPanel, TextElementEditor, SidebarPhotoInfoPanel, FrameImagePanel } from './sidebar-right.js';
import type { ProjectSettingsData, SpreadSettingsData } from './sidebar-right.js';
import { Footer } from './footer.js';
import { NULL_ID, ZOOM_MIN, ZOOM_MAX } from './constants.js';
import { idleMode, splitPreviewMode, cutToolMode, textPlaceMode, dividerDragMode, getSelectedTwinEdgeId, setSwapToolActive } from './interaction.js';
import type { InteractionMode, ModeState, InteractionContext } from './interaction.js';
import { getSpreadInfo, getSpreadsInfo, getTextElements, addTextElement, deleteTextElement, updateTextElement, getAllSelected, getPageSizeMm, getExportSettings, getPreflightReport, getUsedImageIds, splitFaceForMultiDrop, getRenderList, getFrameTransform, getSelectedSegmentHalfGaps, getEdgePairHalfGaps, setSelectedSegmentHalfGapAAxis, setSelectedSegmentHalfGapBAxis, setSelectionOuterMargins, setSelectionInnerGaps, clearSelectionGaps, selectionHasTransformations, getBoundaryChainGap, isSelectedSegmentBoundary, getInnerEdgeOffsets, setSelectionOuterMarginsAndAdjust, getSelectionOuterMargins, copySelectedLayout, getLayoutPasteError, pasteLayout, getFrameImageInfo} from './wasm-bridge.js';
import type { Overlays, DropZone, Rect, PreflightIssue, MarginInsets } from './types.js';
import { isSinglePageKind } from './types.js';
import { getPrintShopSpec, PRINT_SHOP_SPECS, DEFAULT_PREFLIGHT_RULES } from './print-shop-specs.js';
import { OuterMarginDialog } from './outer-margin-dialog.js';
import { InnerGapDialog } from './inner-gap-dialog.js';
import type { InnerGaps } from './types.js';
import type { Sides } from './margin-mode-controller.js';
import { loadLocalFonts, localFontsSupported, tryLoadLocalFonts } from './fonts.js';
import { UndoManager } from './undo.js';
import { InlineEditor } from './inline-editor.js';
import { exportPdf } from './export.js';
import { DocsPanel } from './docs-panel.js';
import { saveProject, openProject } from './project-io.js';
import { readAutosave, writeAutosave, clearAutosave, recentFolders, rememberFolder, folderPermission, readPrefs, writePrefs } from './persist.js';
import { OrderDialog } from './pod/order-dialog.js';
import { getOrderTarget } from './pod/registry.js';
import { PAGE_FORMAT_GROUPS } from './sidebar-project-settings.js';
import { ImageLoaderModal } from './image-loader-modal.js';
import { RandomizeDialog } from './randomize-dialog.js';
import { RandomizeLayoutDialog } from './randomize-layout-dialog.js';
import { showToast } from './toast.js';

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const _wasmLoadingOverlay = document.getElementById('wasm-loading') as HTMLElement;
const _wasmLoadingBar = document.getElementById('wasm-loading-bar') as HTMLElement;
const _wasmLoadingPct = document.getElementById('wasm-loading-pct') as HTMLElement;

function _setWasmProgress(pct: number): void {
  _wasmLoadingBar.style.width = pct + '%';
  _wasmLoadingPct.textContent = Math.round(pct) + '%';
}

{
  const wasmUrl = new URL('./pkg/photobook_core_bg.wasm', import.meta.url);
  const res = await fetch(wasmUrl);
  // content-length is the compressed size; if content-encoding is set the
  // decompressed chunks will exceed it, making percentage nonsensical.
  const compressed = res.headers.has('content-encoding');
  const total = compressed ? 0 : parseInt(res.headers.get('content-length') ?? '0', 10);
  if (compressed) {
    _wasmLoadingBar.classList.add('wasm-loading-bar--indeterminate');
    _wasmLoadingPct.style.visibility = 'hidden';
  }
  let loaded = 0;

  const tracked = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = res.body!.getReader();
      function pump(): void {
        reader.read().then(({ done, value }) => {
          if (done) { controller.close(); return; }
          loaded += value.byteLength;
          if (total > 0) _setWasmProgress((loaded / total) * 100);
          controller.enqueue(value);
          pump();
        }).catch((err: unknown) => controller.error(err));
      }
      pump();
    }
  });

  await init(new Response(tracked, { headers: res.headers }));
}

_wasmLoadingOverlay.remove();
init_panic_hook();

// Global error boundary — surface uncaught errors/rejections as a toast instead
// of failing silently. A Rust panic poisons the WASM instance (every later call
// throws "unreachable"); detect that case and prompt a reload-with-recovery.
let wasmPoisoned = false;
function reportUncaught(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const poisoned = /unreachable|recursive use of an object|null pointer passed to rust/i.test(msg);
  if (poisoned && !wasmPoisoned) {
    wasmPoisoned = true;
    showToast('The editor hit an internal error and must be reloaded. Save your project first if you can.', 'error');
  } else if (!poisoned) {
    showToast('Unexpected error: ' + msg, 'error');
  }
}
window.addEventListener('error', (e) => reportUncaught(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => reportUncaught(e.reason));

const editor = new PhotobookEditor(297, 210, 3);

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const canvasEl = document.getElementById('main-canvas') as HTMLCanvasElement;
const renderer = new CanvasRenderer(canvasEl, () => redraw());

const overlays: Overlays = { marqueeRect: null, splitPreview: null, swapOverlay: null, imageDropPreview: null };



function fitCanvas(): void {
  const area = document.getElementById('canvas-center')!;
  renderer.resize(area.clientWidth, area.clientHeight);
  redraw();
}

function redraw(): void {
  renderer.draw(editor, overlays);
  footer.update(editor, renderer);
  scheduleAutosave();
}

function commit(): void {
  refreshBoxModel();
  redraw();
}

// ---------------------------------------------------------------------------
// Autosave — crash/close recovery. Debounced off redraw(): every edit ends in
// a redraw, and the no-change guard makes navigation-only redraws free.
// ---------------------------------------------------------------------------

let _lastAutosaveJson = '';
let _autosaveTimer: number | undefined;

function scheduleAutosave(): void {
  clearTimeout(_autosaveTimer);
  _autosaveTimer = window.setTimeout(() => {
    const json = editor.save_state();
    if (json === _lastAutosaveJson) return;
    _lastAutosaveJson = json;
    void writeAutosave(json, lastSaveName);
  }, 2000);
}

// Coalesce high-frequency redraws (mousemove, resize) into one per animation
// frame so we never render more than once per repaint.
let _redrawScheduled = false;
function scheduleRedraw(): void {
  if (_redrawScheduled) return;
  _redrawScheduled = true;
  requestAnimationFrame(() => { _redrawScheduled = false; redraw(); });
}

let _resizeScheduled = false;
window.addEventListener('resize', () => {
  if (_resizeScheduled) return;
  _resizeScheduled = true;
  requestAnimationFrame(() => {
    _resizeScheduled = false;
    fitCanvas();
    if (previewActive) { resizePreviewCanvas(); renderPreview(); }
  });
});

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

// When the sidebar evicts a proxy bitmap, also evict from the canvas cache and
// close it immediately so GPU memory is released rather than waiting for GC.
sidebar.onBitmapEvicted = (id, bitmap) => {
  renderer.evictImage(id);
  bitmap.close();
};

// ---------------------------------------------------------------------------
// Recent image folders — remember opened folder handles (IndexedDB) and offer
// one-click re-opening in the sidebar empty state and the missing-images banner.
// ---------------------------------------------------------------------------

sidebar.onFolderOpened = (handle) => {
  void rememberFolder(handle).then(refreshReopenFolderButtons);
};

function refreshReopenFolderButtons(): void {
  void recentFolders().then(([latest]) => {
    for (const id of ['btn-reopen-folder', 'btn-reopen-folder-banner']) {
      const btn = document.getElementById(id) as HTMLButtonElement;
      btn.hidden = !latest;
      if (latest) btn.textContent = `Reopen “${latest.name}”`;
    }
  });
}

/** Re-open the most recent folder. `ask` allows a permission prompt (needs a
 *  user gesture). Returns false when there is no stored folder or permission
 *  was not granted. */
async function tryReopenRecentFolder(ask: boolean): Promise<boolean> {
  const [latest] = await recentFolders();
  if (!latest || !(await folderPermission(latest, ask))) return false;
  await sidebar.openFolderHandle(latest);
  checkMissingImages();
  redraw();
  return true;
}

for (const id of ['btn-reopen-folder', 'btn-reopen-folder-banner']) {
  document.getElementById(id)!.addEventListener('click', () => { void tryReopenRecentFolder(true); });
}
refreshReopenFolderButtons();

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
const panelFrameImage    = document.getElementById('panel-frame-image')!;
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
    commit();
  },
);

function currentProjectSettings(): ProjectSettingsData {
  const pageSize = getPageSizeMm(editor);
  const exportSettings = getExportSettings(editor);
  return {
    page_width_mm:     pageSize.width_mm,
    page_height_mm:    pageSize.height_mm,
    bleed_mm:          editor.get_bleed_mm(),
    safe_zone_mm:      editor.get_safe_zone_mm(),
    spine_mm_per_page: editor.get_spine_mm_per_page(),
    spine_min_mm:      editor.get_spine_min_mm(),
    print_dpi:         editor.get_print_dpi(),
    endpapers:         editor.get_endpapers(),
    export_crop_marks:  exportSettings.crop_marks,
    export_split_cover: exportSettings.split_cover,
    export_body_pages:  exportSettings.body_pages,
    export_cover_pages: exportSettings.cover_pages,
    cover_wrap_mm:      exportSettings.cover_wrap_mm,
    print_spec_id:      editor.get_print_spec_id(),
  };
}

function currentSpreadSettings(): SpreadSettingsData {
  return {
    left_bg:  editor.get_spread_left_bg(),
    right_bg: editor.get_spread_right_bg(),
  };
}

function wireRightSidebar() {
  function editorCallback<T>(action: (data: T) => void): (data: T) => void {
    return (data) => { action(data); commit(); };
  }

  const boxEditor = new BoxModelEditor(
    panelFace,
    editorCallback((json: string) => {
      undoManager.snapshot();
      editor.set_face_box_model(json);
    }),
    (direction) => {
      const ids = getAllSelected(editor);
      if (ids.length === 0) return;
      undoManager.snapshot();
      for (const id of ids) editor.move_face_z_order(id, direction);
      commit();
    },
    (field) => { randomizeDialog.show(field); },
    () => {
      // Randomize layering: shuffle the selection, then bring each to front in
      // turn so their relative stacking ends up random.
      const ids = getAllSelected(editor);
      if (ids.length < 2) return;
      undoManager.snapshot();
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      for (const id of ids) editor.move_face_z_order(id, 'front');
      commit();
    },
  );

  const dividerPanel = new DividerPanel(
    panelDivider,
    (halfV) => { undoManager.snapshot(); editor.set_selected_segment_half_gap_a(halfV); editor.set_selected_segment_half_gap_b(halfV); redraw(); },
    (axis, v) => { undoManager.snapshot(); setSelectedSegmentHalfGapAAxis(editor, axis, v); redraw(); },
    (axis, v) => { undoManager.snapshot(); setSelectedSegmentHalfGapBAxis(editor, axis, v); redraw(); },
    (v) => { undoManager.snapshot(); editor.set_boundary_chain_gap(editor.get_selected_segment(), v); redraw(); },
  );

  const spreadPanel = new SpreadSettingsPanel(
    panelProject,
    (data: SpreadSettingsData) => {
      undoManager.snapshot();
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
        data.print_dpi,
      );
      editor.set_export_settings(
        data.export_crop_marks, data.export_split_cover,
        data.export_body_pages, data.export_cover_pages,
        data.cover_wrap_mm,
      );
      editor.set_print_spec_id(data.print_spec_id);
      // Install the spec's page-count rules; this may append blank spreads
      // to satisfy the shop's minimum page count.
      const specRules = getPrintShopSpec(data.print_spec_id)?.rules;
      editor.set_page_count_rules(
        specRules?.min_interior_pages ?? 0,
        specRules?.max_interior_pages ?? 0,
        specRules?.page_count_multiple_of ?? 0,
      );
      refreshOrderButton();
      redraw();
    },
  );
  projectPanel.setBleedToggleHandler(editorCallback((show: boolean) => {
    renderer.showBleed = show;
    editor.set_bleed_visible(show);
    writePrefs({ showBleed: show });
  }));
  projectPanel.setSafeZoneToggleHandler(editorCallback((show: boolean) => {
    renderer.showSafeZone = show;
    writePrefs({ showSafeZone: show });
  }));
  projectPanel.setEndpapersToggleHandler((enabled: boolean) => {
    undoManager.snapshot();
    editor.set_endpapers(enabled);
    redraw();
  });

  const projectSettingsModal = document.getElementById('project-settings-modal') as HTMLDialogElement;
  document.getElementById('btn-project-settings')!.addEventListener('click', () => {
    projectPanel.show(currentProjectSettings());
    // View toggles aren't part of ProjectSettingsData — sync them with the
    // live renderer state (which includes restored preferences).
    projectPanel.setBleedVisible(renderer.showBleed);
    projectPanel.setSafeZoneVisible(renderer.showSafeZone);
    projectSettingsModal.showModal();
  });
  document.getElementById('btn-psm-close')!.addEventListener('click', () => { projectSettingsModal.close(); });
  projectSettingsModal.addEventListener('click', (e) => {
    if (e.target === projectSettingsModal) projectSettingsModal.close();
  });

  const photoPanel = new SidebarPhotoInfoPanel(panelPhoto, sidebar);
  const frameImagePanel = new FrameImagePanel(panelFrameImage, sidebar);

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

  return { boxEditor, dividerPanel, spreadPanel, projectPanel, photoPanel, frameImagePanel, textEditor };
}

const { boxEditor, dividerPanel, spreadPanel, projectPanel, photoPanel, frameImagePanel, textEditor } = wireRightSidebar();

// ---------------------------------------------------------------------------
// Sidebar — shows all applicable panels for the current selection
// ---------------------------------------------------------------------------

function refreshBoxModel(): void {
  const hasFaces   = editor.get_selection_count() > 0;
  const hasTexts   = renderer.selectedTextIds.size > 0;
  const hasDivider = editor.get_selected_segment_count() > 0;

  if (_outerMarginActive && !_outerMarginSelectionMatches()) _deactivateOuterMarginTool();
  if (_innerGapActive && !_innerGapSelectionMatches()) _deactivateInnerGapTool();
  updateOuterMarginButton(hasFaces);
  updateInnerGapButton(editor.get_selection_count() >= 2);
  (document.getElementById('btn-clear-gaps') as HTMLButtonElement).disabled = !hasFaces || !selectionHasTransformations(editor);
  (document.getElementById('btn-randomize-layout') as HTMLButtonElement).disabled = !hasFaces;
  if (!hasFaces && _randomizeLayoutActive) _deactivateRandomizeLayoutTool();
  if (hasFaces || hasTexts || hasDivider) {
    sidebar.clearSelection();
    footerSpreadSelected = false;
  }
  const sidebarIds = sidebar.getSelectedIds();
  const hasPhotos  = sidebarIds.size > 0;
  if (hasPhotos) footerSpreadSelected = false;
  const showPhoto  = hasPhotos;
  const hasNothing = !hasFaces && !hasTexts && !hasDivider && !showPhoto;

  const showDivider = hasDivider && !hasFaces;
  panelFace.hidden    = !hasFaces;
  panelText.hidden    = !hasTexts;
  panelDivider.hidden = !showDivider;
  panelPhoto.hidden   = !showPhoto;
  panelProject.hidden = !hasNothing;

  const parts: string[] = [];
  if (hasFaces)     parts.push('Frame');
  if (hasTexts)     parts.push('Text');
  if (showDivider)  parts.push('Divider');
  if (showPhoto)  parts.push(sidebarIds.size === 1 ? 'Photo' : 'Photos');
  if (hasNothing) parts.push('Spread Settings');
  sidebarRightHeader.textContent = parts.join(' · ');

  let selectionIsRect = false;
  let singleFrameWithImage = false;
  if (hasFaces) {
    const selectionCount  = editor.get_selection_count();
    const bmJson          = editor.get_face_box_model();
    const sel             = editor.get_selected();
    const zIndex          = (selectionCount === 1 && sel !== NULL_ID)
      ? editor.get_face_z_index(sel) : undefined;
    selectionIsRect = selectionCount > 1 && editor.selection_is_rectangular();
    if (selectionCount === 1 && sel !== NULL_ID) {
      const frame = getRenderList(editor, renderer.lastLayoutRect.w || 1, renderer.lastLayoutRect.h || 1).find(f => f.id === sel);
      singleFrameWithImage = !!(frame?.image_id);
    }
    boxEditor.update(bmJson, zIndex, selectionCount);
  }
  // Image metadata lives in its own panel pinned to the sidebar bottom; only
  // meaningful for exactly one selected frame that holds an image.
  const frameImageInfo = singleFrameWithImage
    ? getFrameImageInfo(editor, editor.get_selected(), renderer.lastLayoutRect.w || 1, renderer.lastLayoutRect.h || 1)
    : null;
  if (frameImageInfo) {
    frameImagePanel.show(frameImageInfo, (id, dims) => {
      editor.register_image_size(id, dims[0], dims[1]);
      redraw();
    });
  } else {
    frameImagePanel.hide();
  }
  updateLayoutTransformButtons(selectionIsRect || singleFrameWithImage);
  updateDistributeButtons(selectionIsRect);

  if (hasTexts) {
    const textElements = getTextElements(editor);
    const firstId = renderer.selectedTextIds.values().next().value as number;
    const el = textElements.find(t => t.id === firstId);
    if (el) textEditor.show(el);
    else renderer.selectedTextIds.clear();
  }

  if (showDivider) {
    if (isSelectedSegmentBoundary(editor)) {
      const boundaryGap = getBoundaryChainGap(editor, editor.get_selected_segment());
      dividerPanel.showBoundary(boundaryGap);
    } else {
      const twinEdgeId = renderer.twinSegmentSelected ? getSelectedTwinEdgeId() : null;
      if (twinEdgeId !== null) {
        const c = getEdgePairHalfGaps(editor, twinEdgeId);
        const multiGaps = c.axis === 'h' ? { h: { a: c.a, b: c.b }, v: null } : { h: null, v: { a: c.a, b: c.b } };
        dividerPanel.show(multiGaps);
      } else {
        dividerPanel.show(getSelectedSegmentHalfGaps(editor));
      }
    }
  }
  if (showPhoto)  photoPanel.show(sidebarIds);
  if (hasNothing) spreadPanel.show(currentSpreadSettings(), isSinglePageKind(getSpreadInfo(editor).kind));

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
    commit();
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
// Page-count rule feedback when adding/removing spreads is blocked.
function addPageChecked(): boolean {
  if (editor.add_page()) return true;
  showToast('Page limit reached for the selected print shop preset.', 'error');
  return false;
}

deleteSpreadDialog.querySelector('#btn-dsd-confirm')!.addEventListener('click', () => {
  deleteSpreadDialog.close();
  const idx = footer.currentIdx;
  undoManager.snapshot();
  if (!editor.remove_page(idx)) {
    showToast('Minimum page count reached for the selected print shop preset.', 'error');
  }
  footerSpreadSelected = false;
  commit();
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

// Preflight dialog — shown before export when the document violates the
// selected print-shop spec (or the default low-DPI rule).
const preflightDialog = document.createElement('dialog');
preflightDialog.className = 'confirm-dialog preflight-dialog';
preflightDialog.innerHTML = `
  <p id="pf-summary"></p>
  <ul id="pf-list"></ul>
  <div class="confirm-dialog-actions">
    <button id="btn-pf-cancel">Cancel</button>
    <button id="btn-pf-continue">Export anyway</button>
  </div>
`;
document.body.appendChild(preflightDialog);

interface PreflightDialogOptions {
  /** Label of the proceed button ("Export anyway" / "Order anyway"). */
  continueLabel: string;
  /** When false, error-severity issues hide the proceed button entirely —
   *  a paid print order of a rejectable file isn't recoverable. */
  allowContinueOnError: boolean;
}

function showPreflightDialog(
  issues: PreflightIssue[],
  opts: PreflightDialogOptions = { continueLabel: 'Export anyway', allowContinueOnError: true },
): Promise<boolean> {
  const summary = preflightDialog.querySelector<HTMLElement>('#pf-summary')!;
  const list    = preflightDialog.querySelector<HTMLUListElement>('#pf-list')!;
  const errors  = issues.filter(i => i.severity === 'error').length;
  const blocked = errors > 0 && !opts.allowContinueOnError;
  summary.textContent = blocked
    ? `Preflight found ${issues.length} issue${issues.length === 1 ? '' : 's'} — ${errors} must be fixed before ordering:`
    : errors > 0
      ? `Preflight found ${issues.length} issue${issues.length === 1 ? '' : 's'} — ${errors} would likely be rejected by the print shop:`
      : `Preflight found ${issues.length} warning${issues.length === 1 ? '' : 's'}:`;
  list.replaceChildren(...issues.map(i => {
    const li = document.createElement('li');
    li.className = i.severity === 'error' ? 'pf-error' : 'pf-warning';
    li.textContent = i.message;
    return li;
  }));
  const continueBtn = preflightDialog.querySelector<HTMLButtonElement>('#btn-pf-continue')!;
  continueBtn.textContent = opts.continueLabel;
  continueBtn.hidden = blocked;
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => { cleanup(); preflightDialog.close(); resolve(ok); };
    const onCancel   = () => done(false);
    const onContinue = () => done(true);
    const onClose    = () => done(false);
    const cleanup = () => {
      preflightDialog.querySelector('#btn-pf-cancel')!.removeEventListener('click', onCancel);
      preflightDialog.querySelector('#btn-pf-continue')!.removeEventListener('click', onContinue);
      preflightDialog.removeEventListener('cancel', onClose);
    };
    preflightDialog.querySelector('#btn-pf-cancel')!.addEventListener('click', onCancel);
    preflightDialog.querySelector('#btn-pf-continue')!.addEventListener('click', onContinue);
    preflightDialog.addEventListener('cancel', onClose);
    preflightDialog.showModal();
  });
}

function showFontAccessWarning(code: 'not_supported' | 'denied'): void {
  const msg = fontAccessWarningDialog.querySelector<HTMLElement>('#font-warning-msg')!;
  if (code === 'not_supported') {
    msg.textContent = 'Your browser does not support the Local Font Access API. This feature is currently available in Chrome and Edge.';
  } else {
    msg.textContent = 'Permission to access local fonts was denied. You can allow access in your browser\'s site settings.';
  }
  fontAccessWarningDialog.showModal();
}

/** Why the current spread can't be deleted, or null when deletion is allowed. */
function spreadDeleteBlockReason(): string | null {
  const spreads = getSpreadsInfo(editor);
  if (spreads[footer.currentIdx]?.kind !== 'content') {
    return 'Cover pages cannot be deleted.';
  }
  if (!editor.can_remove_page(footer.currentIdx)) {
    // Determine whether the print-shop spec or the structural minimum is binding.
    const spec = getPrintShopSpec(editor.get_print_spec_id());
    const specMinPages = spec?.rules.min_interior_pages ?? 0;
    const structuralMin = editor.get_endpapers() ? 2 : 1;
    if (specMinPages > 0 && specMinPages > structuralMin * 2) {
      return `This spread cannot be deleted — "${spec!.name}" requires at least ${specMinPages} interior pages.`;
    }
    return `This spread cannot be deleted — the book must have at least ${structuralMin} content spread${structuralMin === 1 ? '' : 's'}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

const undoManager = new UndoManager(
  editor,
  document.getElementById('btn-undo') as HTMLButtonElement,
  document.getElementById('btn-redo') as HTMLButtonElement,
  commit,
);

// Layout clipboard is deliberately app-local: image IDs refer to resources in
// the currently open project and are not portable browser clipboard data.
let layoutClipboard: string | null = null;


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
  if (currentMode === textPlaceMode && mode !== textPlaceMode) {
    updateTextToolButton(false);
  }
  currentMode = mode;
  modeState = state;
  // Modifier hint in the canvas corner: only divider dragging has hidden
  // modifier behaviour worth advertising.
  document.getElementById('canvas-hint')!.hidden = mode !== dividerDragMode;
}

/** Highlight a key in the canvas hint while it is physically held. */
function setModifierHeld(key: 'shift' | 'alt', held: boolean): void {
  document.querySelector<HTMLElement>(`#canvas-hint kbd[data-key="${key}"]`)?.classList.toggle('held', held);
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
  // Coalesce interaction-driven redraws (per-mousemove during a drag) into one
  // paint per animation frame.
  snapshot: () => undoManager.snapshot(), refreshBoxModel, redraw: scheduleRedraw,
  commit: () => { refreshBoxModel(); scheduleRedraw(); },
  setMode,

  onTextSelected: (id: number) => {
    renderer.selectedTextIds = new Set([id]);
    commit();
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

canvasEl.addEventListener('drop', async (e) => {
  e.preventDefault();

  const dropPreview = overlays.imageDropPreview;
  overlays.imageDropPreview = null;

  const layoutRect = renderer.lastLayoutRect;
  const canvasRect = canvasEl.getBoundingClientRect();
  const relX = (e.clientX - canvasRect.left) - layoutRect.x;
  const relY = (e.clientY - canvasRect.top)  - layoutRect.y;
  const hitId = editor.hit_test(relX, relY, layoutRect.w, layoutRect.h);
  if (hitId === NULL_ID) return;

  // Determine the image IDs from either a sidebar drag or an OS file drop.
  let imageIds: string[];
  const raw = e.dataTransfer!.getData('text/plain');
  if (raw) {
    // Sidebar drag: payload is a JSON array of image IDs.
    try {
      const parsed: unknown = JSON.parse(raw);
      imageIds = Array.isArray(parsed) ? (parsed as string[]) : [raw];
    } catch {
      imageIds = [raw];
    }
  } else {
    // External OS drag: register each dropped image file into the sidebar caches.
    const files = Array.from(e.dataTransfer!.files).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) return;
    imageIds = [];
    for (const file of files) {
      const id = `external/${file.name}`;
      await sidebar.registerExternalFile(id, file);
      const proxy = sidebar.getProxy(id);
      if (proxy) renderer.cacheImage(id, proxy);
      imageIds.push(id);
    }
  }

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

    commit();
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
    commit();
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
// Canvas tool button state helpers
// ---------------------------------------------------------------------------

function updateCutToolButton(active: boolean): void {
  document.getElementById('btn-cut-tool')!.classList.toggle('active', active);
}

function updateTextToolButton(active: boolean): void {
  document.getElementById('btn-add-text')!.classList.toggle('active', active);
}

let _swapToolActive = false;

function updateSwapToolButton(active: boolean): void {
  _swapToolActive = active;
  setSwapToolActive(active);
  document.getElementById('btn-swap-tool')!.classList.toggle('active', active);
}

const _layoutTransformBtnIds = ['btn-flip-h', 'btn-flip-v', 'btn-rotate-cw', 'btn-rotate-ccw'] as const;

function updateLayoutTransformButtons(enabled: boolean): void {
  for (const id of _layoutTransformBtnIds) {
    (document.getElementById(id) as HTMLButtonElement).disabled = !enabled;
  }
}

const _distributeBtnIds = ['btn-distribute-v', 'btn-distribute-h'] as const;

function updateDistributeButtons(enabled: boolean): void {
  for (const id of _distributeBtnIds) {
    (document.getElementById(id) as HTMLButtonElement).disabled = !enabled;
  }
}

// ---------------------------------------------------------------------------
// Layout tool shared utilities
// ---------------------------------------------------------------------------

function _selectionSetMatches(activeIds: number[]): boolean {
  const cur = getAllSelected(editor);
  if (cur.length !== activeIds.length) return false;
  const set = new Set(activeIds);
  return cur.every(id => set.has(id));
}

function _deactivateAllLayoutDialogTools(): void {
  _deactivateOuterMarginTool();
  _deactivateInnerGapTool();
  _deactivateRandomizeLayoutTool();
}

// ---------------------------------------------------------------------------
// Outer margin tool
// ---------------------------------------------------------------------------

let _outerMarginActive = false;
let _outerMarginDefaults: Sides = { top: 0, right: 0, bottom: 0, left: 0 };
let _outerMarginDefaultsSet = false;
let _outerMarginActiveSelIds: number[] = [];
let _outerMarginOriginalOffsets = '{}';
let _outerMarginOriginalMargins: MarginInsets = { top: 0, right: 0, bottom: 0, left: 0 };

const _outerMarginDialog = new OuterMarginDialog(
  document.getElementById('outer-margin-dialog') as HTMLElement,
  (margins) => {
    setSelectionOuterMarginsAndAdjust(editor, margins, _outerMarginOriginalOffsets, _outerMarginOriginalMargins);
    if (margins.top    !== null) _outerMarginDefaults.top    = margins.top;
    if (margins.right  !== null) _outerMarginDefaults.right  = margins.right;
    if (margins.bottom !== null) _outerMarginDefaults.bottom = margins.bottom;
    if (margins.left   !== null) _outerMarginDefaults.left   = margins.left;
    commit();
  },
);

function _outerMarginSelectionMatches(): boolean {
  return _selectionSetMatches(_outerMarginActiveSelIds);
}

function _deactivateOuterMarginTool(): void {
  _outerMarginActive = false;
  _outerMarginActiveSelIds = [];
  _outerMarginOriginalOffsets = '{}';
  _outerMarginOriginalMargins = { top: 0, right: 0, bottom: 0, left: 0 };
  _outerMarginDialog.hide();
  document.getElementById('btn-outer-margin')!.classList.remove('active');
}

function updateOuterMarginButton(enabled: boolean): void {
  const btn = document.getElementById('btn-outer-margin') as HTMLButtonElement;
  btn.disabled = !enabled;
  if (!enabled && _outerMarginActive) _deactivateOuterMarginTool();
}

document.getElementById('btn-outer-margin')!.addEventListener('click', () => {
  if (_outerMarginActive) {
    _deactivateOuterMarginTool();
    return;
  }
  if (editor.get_selection_count() === 0) return;
  if (!_outerMarginDefaultsSet) {
    const v = editor.get_bleed_mm() + editor.get_safe_zone_mm();
    _outerMarginDefaults = { top: v, right: v, bottom: v, left: v };
    _outerMarginDefaultsSet = true;
  }
  _deactivateAllLayoutDialogTools();
  _outerMarginActive = true;
  _outerMarginActiveSelIds = getAllSelected(editor);
  undoManager.snapshot();
  _outerMarginOriginalOffsets = getInnerEdgeOffsets(editor);
  _outerMarginOriginalMargins = getSelectionOuterMargins(editor);
  setSelectionOuterMarginsAndAdjust(editor, _outerMarginDefaults, _outerMarginOriginalOffsets, _outerMarginOriginalMargins);
  commit();
  _outerMarginDialog.show(_outerMarginDefaults);
  document.getElementById('btn-outer-margin')!.classList.add('active');
});

// ---------------------------------------------------------------------------
// Inner gap tool
// ---------------------------------------------------------------------------

let _innerGapActive = false;
let _innerGapDefaults: InnerGaps = { h: 5, v: 5 };
let _innerGapActiveSelIds: number[] = [];

const _innerGapDialog = new InnerGapDialog(
  document.getElementById('inner-gap-dialog') as HTMLElement,
  (gaps) => {
    setSelectionInnerGaps(editor, gaps);
    if (gaps.h !== null) _innerGapDefaults.h = gaps.h;
    if (gaps.v !== null) _innerGapDefaults.v = gaps.v;
    commit();
  },
);

function _innerGapSelectionMatches(): boolean {
  return _selectionSetMatches(_innerGapActiveSelIds);
}

function _deactivateInnerGapTool(): void {
  _innerGapActive = false;
  _innerGapActiveSelIds = [];
  _innerGapDialog.hide();
  document.getElementById('btn-inner-gap')!.classList.remove('active');
}

function updateInnerGapButton(enabled: boolean): void {
  const btn = document.getElementById('btn-inner-gap') as HTMLButtonElement;
  btn.disabled = !enabled;
  if (!enabled && _innerGapActive) _deactivateInnerGapTool();
}

document.getElementById('btn-inner-gap')!.addEventListener('click', () => {
  if (_innerGapActive) {
    _deactivateInnerGapTool();
    return;
  }
  if (editor.get_selection_count() < 2) return;
  _deactivateAllLayoutDialogTools();
  _innerGapActive = true;
  _innerGapActiveSelIds = getAllSelected(editor);
  undoManager.snapshot();
  setSelectionInnerGaps(editor, _innerGapDefaults);
  commit();
  _innerGapDialog.show(_innerGapDefaults);
  document.getElementById('btn-inner-gap')!.classList.add('active');
});

// ---------------------------------------------------------------------------
// Clear gaps tool
// ---------------------------------------------------------------------------

document.getElementById('btn-clear-gaps')!.addEventListener('click', () => {
  if (editor.get_selection_count() === 0) return;
  _deactivateAllLayoutDialogTools();
  undoManager.snapshot();
  const _clearOriginalOffsets = getInnerEdgeOffsets(editor);
  const _clearOriginalMargins = getSelectionOuterMargins(editor);
  clearSelectionGaps(editor);
  for (const id of getAllSelected(editor)) {
    editor.set_face_frame_rotation(id, 0);
  }
  // Shift inner edge offsets to preserve relative layout after outer half-gaps were zeroed.
  setSelectionOuterMarginsAndAdjust(
    editor,
    { top: 0, right: 0, bottom: 0, left: 0 },
    _clearOriginalOffsets,
    _clearOriginalMargins,
  );
  commit();
});

// ---------------------------------------------------------------------------
// Randomize layout tool
// ---------------------------------------------------------------------------

let _randomizeLayoutActive = false;

function _applyRandomizeLayout(values: { gapMin: number; gapMax: number; rotMin: number; rotMax: number }): void {
  undoManager.snapshot();

  // 1. Random symmetric half-gaps on all inner chains of the spread.
  //    Dialog shows total gap, so half each side.
  editor.randomize_inner_gaps(values.gapMin / 2, values.gapMax / 2);

  // 2. Random rotation on every selected frame.
  const selectedIds = getAllSelected(editor);
  for (const id of selectedIds) {
    const rot = values.rotMin + Math.random() * (values.rotMax - values.rotMin);
    editor.set_face_frame_rotation(id, rot);
  }

  // 3. Shuffle z-order within the selection.
  const ids = [...selectedIds];
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  for (const id of ids) editor.move_face_z_order(id, 'front');

  commit();
}

function _deactivateRandomizeLayoutTool(): void {
  _randomizeLayoutActive = false;
  _randomizeLayoutDialog.hide();
  document.getElementById('btn-randomize-layout')!.classList.remove('active');
}

const _randomizeLayoutDialog = new RandomizeLayoutDialog(
  document.getElementById('randomize-layout-dialog') as HTMLElement,
  (values) => _applyRandomizeLayout(values),
);

document.getElementById('btn-randomize-layout')!.addEventListener('click', () => {
  if (_randomizeLayoutActive) {
    _deactivateRandomizeLayoutTool();
    return;
  }
  _deactivateAllLayoutDialogTools();
  _randomizeLayoutActive = true;
  document.getElementById('btn-randomize-layout')!.classList.add('active');
  _applyRandomizeLayout(_randomizeLayoutDialog.getValues());
  _randomizeLayoutDialog.show();
});

// ---------------------------------------------------------------------------
// Keyboard events
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT'
    || (e.target as HTMLElement).tagName === 'TEXTAREA') return;

  if (previewActive) {
    if (e.key === 'Escape') { closePreview(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      const idx = editor.get_current_spread_index();
      if (idx > 0) { editor.set_current_spread(idx - 1); renderPreview(); }
      e.preventDefault();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      const idx = editor.get_current_spread_index();
      if (idx < editor.get_spread_count() - 1) { editor.set_current_spread(idx + 1); renderPreview(); }
      e.preventDefault();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    undoManager.undo(); commit(); e.preventDefault(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
    undoManager.redo(); commit(); e.preventDefault(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !e.shiftKey) {
    const result = copySelectedLayout(editor);
    if (result.ok && result.clipboard) {
      layoutClipboard = result.clipboard;
      showToast(`Copied ${editor.get_selection_count()} frame${editor.get_selection_count() === 1 ? '' : 's'}.`);
    } else {
      showToast(result.error ?? 'The selected frames cannot be copied.', 'error', 5000);
    }
    e.preventDefault(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !e.shiftKey) {
    if (!layoutClipboard) {
      showToast('Copy a rectangular frame selection first.', 'info');
      e.preventDefault(); return;
    }
    const error = getLayoutPasteError(editor, layoutClipboard);
    if (error) {
      showToast(`Cannot paste layout: ${error}`, 'error', 5000);
      e.preventDefault(); return;
    }
    undoManager.snapshot();
    if (pasteLayout(editor, layoutClipboard)) {
      renderer.selectedTextIds.clear();
      commit();
    } else {
      showToast('Cannot paste layout: the selected target is incompatible.', 'error');
    }
    e.preventDefault(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    editor.select_all();
    renderer.selectedTextIds = new Set(getTextElements(editor).map(t => t.id));
    commit(); e.preventDefault(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { setZoom(renderer.zoom * 1.25); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === '-') { setZoom(renderer.zoom / 1.25); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === '0') { renderer.panX = 0; renderer.panY = 0; setZoom(1.0); e.preventDefault(); return; }

  if (currentMode.onKeyDown) {
    currentMode.onKeyDown(e, { ...interactionCtx(), modeState });
    if (e.defaultPrevented) return;
  }

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
        if (_swapToolActive) updateSwapToolButton(false);
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
      addPageChecked();
      redraw();
      break;
    }
    case 't':
    case 'T': {
      canvasEl.style.cursor = 'crosshair';
      setMode(textPlaceMode, {});
      updateTextToolButton(true);
      break;
    }
    case 'Escape': {
      if (_swapToolActive) { updateSwapToolButton(false); canvasEl.style.cursor = 'default'; redraw(); }
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
        commit();
      } else if (editor.get_selected_segment_count() > 0) {
        editor.select_segment(NULL_ID);
        commit();
      } else {
        editor.select_face(NULL_ID);
        commit();
      }
      break;
    }
    case 'Delete':
    case 'Backspace': {
      if (footerSpreadSelected && editor.can_remove_page(footer.currentIdx)) {
        deleteSpreadDialog.showModal();
        break;
      }
      if (renderer.selectedTextIds.size > 0) {
        undoManager.snapshot();
        for (const id of renderer.selectedTextIds) deleteTextElement(editor, id);
        renderer.selectedTextIds.clear();
        commit();
      } else if (editor.get_selected_segment_count() > 0) {
        undoManager.snapshot();
        editor.delete_selected_segment();
        commit();
      } else {
        undoManager.snapshot();
        editor.delete_selected();
        commit();
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
        commit();
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
        commit();
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

/** Run the open-project picker + load flow. Returns true when a project was
 *  loaded, false on cancel or error (errors surface an alert). Shared by the
 *  toolbar Load button and the start screen. */
async function runOpenProject(): Promise<boolean> {
  const result = await openProject(editor);
  if (!result.ok) {
    if (result.reason === 'cancelled') return false;
    if (result.reason === 'version_too_new') {
      alert('This file was saved by a newer version of Photobook and cannot be opened.');
    } else if (result.reason === 'wrong_format') {
      alert('Not a valid Photobook file.');
    } else {
      alert('Could not open the project file.');
    }
    return false;
  }
  await afterProjectLoaded();
  return true;
}

document.getElementById('btn-open-project')!.addEventListener('click', () => { void runOpenProject(); });

/** Shared post-load flow for opened projects and restored autosave sessions.
 *  `reopenRecentFolder` re-attaches the last image folder (permission prompt
 *  allowed — call from a user gesture) and feeds it to the missing-image
 *  modal, so a project whose images are still in place re-links itself. */
async function afterProjectLoaded(reopenRecentFolder = false): Promise<void> {
  sidebar.clearLoadedImages(); // discard images from any previous project session
  layoutClipboard = null;      // copied image IDs belong to the previous project
  undoManager.reset();
  refreshBoxModel();
  checkMissingFonts();
  refreshOrderButton();
  footer.update(editor, renderer);
  redraw();

  let recentFolder: FileSystemDirectoryHandle | null = null;
  if (reopenRecentFolder) {
    const [latest] = await recentFolders();
    if (latest && await folderPermission(latest, true)) {
      recentFolder = latest;
      await sidebar.openFolderHandle(latest);
    }
  }

  // Show the image-loader modal for any images not already in the sidebar.
  const usedIds: string[] = JSON.parse(editor.get_used_image_ids());
  const loadedIds = new Set(sidebar.loadedImageIds());
  const missing = usedIds.filter(id => !loadedIds.has(id));
  if (missing.length > 0) {
    imageLoaderModal.open(missing);
    // A re-attached folder resolves what it can immediately; the modal closes
    // itself when nothing remains missing. onClose runs checkMissingImages().
    if (recentFolder) await imageLoaderModal.scanHandle(recentFolder);
  } else {
    checkMissingImages();
  }
}

document.getElementById('btn-add-spread')!.addEventListener('click', () => {
  undoManager.snapshot();
  if (!addPageChecked()) return;
  // add_page inserts after the current spread and makes it current; mirror that
  // in the UI instead of jumping to the last spread.
  editor.set_current_spread(editor.get_current_spread_index());
  redraw();
});

document.getElementById('btn-remove-spread')!.addEventListener('click', () => {
  const reason = spreadDeleteBlockReason();
  if (reason === null) {
    deleteSpreadDialog.showModal();
  } else {
    cannotDeleteDialog.querySelector<HTMLElement>('#cannot-delete-msg')!.textContent = reason;
    cannotDeleteDialog.showModal();
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
  commit();
});

document.getElementById('btn-cut-tool')!.addEventListener('click', () => {
  if (currentMode === cutToolMode) {
    overlays.splitPreview = null;
    canvasEl.style.cursor = 'default';
    setMode(idleMode, {});
    updateCutToolButton(false);
  } else {
    if (_swapToolActive) updateSwapToolButton(false);
    setMode(cutToolMode, { numCuts: 1, nodeId: NULL_ID, axis: null, ratio: null });
    canvasEl.style.cursor = 'crosshair';
    updateCutToolButton(true);
  }
  redraw();
});

document.getElementById('btn-swap-tool')!.addEventListener('click', () => {
  if (_swapToolActive) {
    updateSwapToolButton(false);
  } else {
    if (currentMode === cutToolMode) {
      overlays.splitPreview = null;
      canvasEl.style.cursor = 'default';
      setMode(idleMode, {});
      updateCutToolButton(false);
    }
    updateSwapToolButton(true);
  }
  redraw();
});

function applyLayoutTransform(action: 'flip-h' | 'flip-v' | 'rotate-cw' | 'rotate-ccw'): void {
  const sel = editor.get_selected();
  if (editor.get_selection_count() === 1 && sel !== NULL_ID) {
    const t = getFrameTransform(editor, sel);
    if (t) {
      undoManager.snapshot();
      if (action === 'flip-h') {
        editor.set_image_transform(sel, t.pan_x, t.pan_y, t.scale, t.rotation_deg, !t.flip_h, t.flip_v);
      } else if (action === 'flip-v') {
        editor.set_image_transform(sel, t.pan_x, t.pan_y, t.scale, t.rotation_deg, t.flip_h, !t.flip_v);
      } else if (action === 'rotate-cw') {
        editor.set_image_transform(sel, t.pan_x, t.pan_y, t.scale, t.rotation_deg - 90, t.flip_h, t.flip_v);
      } else {
        editor.set_image_transform(sel, t.pan_x, t.pan_y, t.scale, t.rotation_deg + 90, t.flip_h, t.flip_v);
      }
      commit();
      return;
    }
  }
  undoManager.snapshot();
  if (action === 'flip-h')     editor.flip_selection_h();
  else if (action === 'flip-v')     editor.flip_selection_v();
  else if (action === 'rotate-cw')  editor.rotate_selection_cw();
  else                              editor.rotate_selection_ccw();
  commit();
}

document.getElementById('btn-flip-h')!.addEventListener('click',     () => applyLayoutTransform('flip-h'));
document.getElementById('btn-flip-v')!.addEventListener('click',     () => applyLayoutTransform('flip-v'));
document.getElementById('btn-rotate-cw')!.addEventListener('click',  () => applyLayoutTransform('rotate-cw'));
document.getElementById('btn-rotate-ccw')!.addEventListener('click', () => applyLayoutTransform('rotate-ccw'));

document.getElementById('btn-distribute-v')!.addEventListener('click', () => {
  if (!editor.selection_is_rectangular()) return;
  undoManager.snapshot();
  editor.distribute_selection_v();
  commit();
});

document.getElementById('btn-distribute-h')!.addEventListener('click', () => {
  if (!editor.selection_is_rectangular()) return;
  undoManager.snapshot();
  editor.distribute_selection_h();
  commit();
});

document.getElementById('btn-export-pdf')!.addEventListener('click', async () => {
  const spec = getPrintShopSpec(editor.get_print_spec_id());
  const rules = spec?.rules ?? DEFAULT_PREFLIGHT_RULES;
  const issues = getPreflightReport(editor, rules);
  if (issues.length > 0 && !(await showPreflightDialog(issues))) return;
  // Export and ordering share the worker — one at a time.
  const orderBtn = document.getElementById('btn-order-book') as HTMLButtonElement;
  orderBtn.disabled = true;
  try {
    await exportPdf(editor, (usedIds) => sidebar.buffersForExport(usedIds));
  } finally {
    refreshOrderButton();
  }
});

// ---------------------------------------------------------------------------
// Print-on-demand ordering (web/pod/)
// ---------------------------------------------------------------------------

const orderDialog = new OrderDialog({
  editor,
  getBuffers: (usedIds) => sidebar.buffersForExport(usedIds),
  getSettings: currentProjectSettings,
  getProjectName: () => lastSaveName,
  // The export worker is shared — while an order is generating, block plain export.
  onBusyChange: (busy) => {
    (document.getElementById('btn-export-pdf') as HTMLButtonElement).disabled = busy;
  },
});

/** Apply a print-shop preset to the editor (size, export options, endpapers,
 *  page-count rules). Used by the landing page; mirrors selecting the preset
 *  in Project Settings but also applies the spec's endpaper setting. Pass ''
 *  to clear the preset. */
function applyShopPreset(specId: string): void {
  const spec = getPrintShopSpec(specId);
  if (!spec) { editor.set_print_spec_id(''); editor.set_page_count_rules(0, 0, 0); return; }
  const d = { ...currentProjectSettings(), ...spec.settings };
  editor.set_page_settings(d.page_width_mm, d.page_height_mm, d.bleed_mm, d.safe_zone_mm,
    d.spine_mm_per_page, d.spine_min_mm, d.print_dpi);
  editor.set_export_settings(d.export_crop_marks, d.export_split_cover,
    d.export_body_pages, d.export_cover_pages, d.cover_wrap_mm);
  if (typeof spec.settings.endpapers === 'boolean') editor.set_endpapers(spec.settings.endpapers);
  editor.set_print_spec_id(specId);
  editor.set_page_count_rules(spec.rules.min_interior_pages, spec.rules.max_interior_pages, spec.rules.page_count_multiple_of);
}

/** Keep the Order Book tooltip in sync with the selected preset. The button
 *  stays clickable even without a preset — clicking then explains how to set
 *  one (rather than silently doing nothing). */
function refreshOrderButton(): void {
  const btn = document.getElementById('btn-order-book') as HTMLButtonElement;
  const target = getOrderTarget(getPrintShopSpec(editor.get_print_spec_id()));
  btn.disabled = false;
  btn.title = target
    ? `Order a printed book (${target.provider.name})`
    : 'Order a printed book — choose a print shop in Project Settings first';
}

document.getElementById('btn-order-book')!.addEventListener('click', async () => {
  const spec = getPrintShopSpec(editor.get_print_spec_id());
  if (!spec || !getOrderTarget(spec)) {
    showToast('Choose a print shop under Project Settings → Print shop preset to order a printed book.', 'info');
    return;
  }
  const issues = getPreflightReport(editor, spec.rules);
  // Errors block ordering outright — a paid order of a rejectable file
  // isn't recoverable the way a downloaded PDF is.
  if (issues.length > 0 && !(await showPreflightDialog(issues, {
    continueLabel: 'Order anyway', allowContinueOnError: false,
  }))) return;
  orderDialog.open(spec);
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

function zoomToward(z: number, mouseX: number, mouseY: number): void {
  const oldZoom = renderer.zoom;
  renderer.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const ratio = renderer.zoom / oldZoom;
  const { cx, cy } = renderer.naturalCenter();
  renderer.panX = mouseX - cx - (mouseX - cx - renderer.panX) * ratio;
  renderer.panY = mouseY - cy - (mouseY - cy - renderer.panY) * ratio;
  document.getElementById('zoom-label')!.textContent = Math.round(renderer.zoom * 100) + '%';
  redraw();
}

document.getElementById('btn-zoom-in')!.addEventListener('click',  () => setZoom(renderer.zoom * 1.25));
document.getElementById('btn-zoom-out')!.addEventListener('click', () => setZoom(renderer.zoom / 1.25));
document.getElementById('btn-zoom-fit')!.addEventListener('click', () => {
  renderer.panX = 0;
  renderer.panY = 0;
  setZoom(1.0);
});

// ---------------------------------------------------------------------------
// Fullscreen preview
// ---------------------------------------------------------------------------

// Lazily initialised — canvas must be visible before calling getContext('2d').
// Safari throws when getContext is called on a canvas inside a hidden element,
// which would abort module execution before fitCanvas() is reached.
let previewRenderer: CanvasRenderer | null = null;
let previewActive = false;

function openPreview(): void {
  previewActive = true;
  document.getElementById('preview-overlay')!.removeAttribute('hidden');
  if (!previewRenderer) {
    const canvasEl = document.getElementById('preview-canvas') as HTMLCanvasElement;
    previewRenderer = new CanvasRenderer(canvasEl);
    previewRenderer.showBleed = false;
    previewRenderer.showSafeZone = false;
    previewRenderer.showRulers = false;
    previewRenderer.previewMode = true;
  }
  previewRenderer.imageCache = renderer.imageCache;
  resizePreviewCanvas();
  renderPreview();
}

function closePreview(): void {
  previewActive = false;
  document.getElementById('preview-overlay')!.setAttribute('hidden', '');
  redraw();
}

function resizePreviewCanvas(): void {
  const area = document.getElementById('preview-canvas-area')!;
  previewRenderer!.resize(area.clientWidth, area.clientHeight);
}

function renderPreview(): void {
  const idx = editor.get_current_spread_index();
  const total = editor.get_spread_count();
  previewRenderer!.draw(editor);
  document.getElementById('preview-counter')!.textContent = `${idx + 1} / ${total}`;
  (document.getElementById('preview-prev') as HTMLButtonElement).disabled = idx === 0;
  (document.getElementById('preview-next') as HTMLButtonElement).disabled = idx === total - 1;
}

document.getElementById('btn-preview')!.addEventListener('click', openPreview);
document.getElementById('preview-close')!.addEventListener('click', closePreview);
document.getElementById('preview-prev')!.addEventListener('click', () => {
  const idx = editor.get_current_spread_index();
  if (idx > 0) { editor.set_current_spread(idx - 1); renderPreview(); }
});
document.getElementById('preview-next')!.addEventListener('click', () => {
  const idx = editor.get_current_spread_index();
  if (idx < editor.get_spread_count() - 1) { editor.set_current_spread(idx + 1); renderPreview(); }
});

// ---------------------------------------------------------------------------
// Viewport pan — middle mouse drag or Space + left drag
// ---------------------------------------------------------------------------

let isPanning = false;
let spaceDown = false;
let panStartX = 0;
let panStartY = 0;
let panStartOffsetX = 0;
let panStartOffsetY = 0;

canvasEl.addEventListener('mousedown', (e) => {
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartOffsetX = renderer.panX;
    panStartOffsetY = renderer.panY;
    canvasEl.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }
}, true); // capture phase so it fires before interaction mode handlers

document.addEventListener('mousemove', (e) => {
  if (!isPanning) return;
  renderer.panX = panStartOffsetX + (e.clientX - panStartX);
  renderer.panY = panStartOffsetY + (e.clientY - panStartY);
  redraw();
});

document.addEventListener('mouseup', (e) => {
  if (!isPanning) return;
  if (e.button === 1 || e.button === 0) {
    isPanning = false;
    canvasEl.style.cursor = spaceDown ? 'grab' : '';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat
      && !(e.target as HTMLElement).closest('input, textarea, [contenteditable]')) {
    spaceDown = true;
    if (!isPanning) canvasEl.style.cursor = 'grab';
    e.preventDefault();
  }
  if (e.code === 'AltLeft' || e.code === 'AltRight') {
    // Alt only means "swap" in idle mode; elsewhere (divider drag, cut tool,
    // text drag) it disables snapping, so don't advertise the swap tool.
    if (currentMode === idleMode) document.getElementById('btn-swap-tool')!.classList.add('active');
    setModifierHeld('alt', true);
  }
  if (e.key === 'Shift') setModifierHeld('shift', true);
}, true);

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceDown = false;
    if (!isPanning) canvasEl.style.cursor = '';
  }
  if (e.code === 'AltLeft' || e.code === 'AltRight') {
    document.getElementById('btn-swap-tool')!.classList.toggle('active', _swapToolActive);
    setModifierHeld('alt', false);
  }
  if (e.key === 'Shift') setModifierHeld('shift', false);
});

canvasEl.addEventListener('wheel', (e) => {
  if (currentMode.onWheel) {
    currentMode.onWheel(e, { ...interactionCtx(), modeState });
    if (e.defaultPrevented) return;
  }

  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const rect = canvasEl.getBoundingClientRect();
    zoomToward(renderer.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - rect.left, e.clientY - rect.top);
    return;
  }

  const layoutRect = renderer.lastLayoutRect;
  const rect = canvasEl.getBoundingClientRect();
  const relX = (e.clientX - rect.left) - layoutRect.x;
  const relY = (e.clientY - rect.top)  - layoutRect.y;
  const hitId = editor.hit_test(relX, relY, layoutRect.w, layoutRect.h);
  if (hitId === NULL_ID) return;

  e.preventDefault();

  const t = JSON.parse(editor.get_frame_transform(hitId)) as { pan_x: number; pan_y: number; scale: number; rotation_deg: number; flip_h: boolean; flip_v: boolean };
  if (!t) return;

  if (e.shiftKey) {
    const delta = e.deltaY > 0 ? 0.5 : -0.5;
    undoManager.snapshot();
    editor.set_image_transform(hitId, t.pan_x, t.pan_y, t.scale, t.rotation_deg + delta, t.flip_h, t.flip_v);
  } else {
    const factor = e.deltaY < 0 ? 1.01 : 1 / 1.01;
    undoManager.snapshot();
    editor.set_image_transform(hitId, t.pan_x, t.pan_y, Math.max(1.0, t.scale * factor), t.rotation_deg, t.flip_h, t.flip_v);
  }
  redraw();
}, { passive: false });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Restore persisted view preferences (the project-settings checkboxes are
// synced when the modal opens).
{
  const prefs = readPrefs();
  if (prefs.showBleed === false) {
    renderer.showBleed = false;
    editor.set_bleed_visible(false);
  }
  if (prefs.showSafeZone === false) renderer.showSafeZone = false;
}

// Baseline the autosave against the pristine boot document so the previous
// session's autosave isn't overwritten with an empty book while the restore
// prompt below is still open — only actual changes trigger a write.
_lastAutosaveJson = editor.save_state();

fitCanvas();
refreshBoxModel();
refreshOrderButton();

// ---------------------------------------------------------------------------
// Start screen — shown on boot instead of dropping straight into the canvas.
// Offers New / Open / Restore; choosing one reveals the editor.
// ---------------------------------------------------------------------------
{
  const startScreen = document.getElementById('start-screen')!;
  const shopSel     = document.getElementById('start-shop') as HTMLSelectElement;
  const formatSel   = document.getElementById('start-format') as HTMLSelectElement;
  const formatField = document.getElementById('start-format-field') as HTMLElement;

  // Print-shop presets first ("None" = pick a size yourself).
  shopSel.innerHTML = '<option value="">None — choose page size</option>'
    + PRINT_SHOP_SPECS.map(s => `<option value="${s.id}">${s.name}</option>`).join('');

  // Page-format options (reused from Project Settings); default to the editor's
  // current size (A4 landscape, 297×210).
  formatSel.innerHTML = PAGE_FORMAT_GROUPS.map(g =>
    `<optgroup label="${g.label}">${
      g.formats.map(f => `<option value="${f.value}" ${f.w === 297 && f.h === 210 ? 'selected' : ''}>${f.label}</option>`).join('')
    }</optgroup>`,
  ).join('');

  // A print shop dictates the page size, so hide the format picker when one is chosen.
  shopSel.addEventListener('change', () => { formatField.hidden = shopSel.value !== ''; });

  const enterEditor = () => {
    startScreen.hidden = true;
    fitCanvas();
    redraw();
  };

  // New book: either apply a shop preset, or the chosen page size for a custom book.
  document.getElementById('start-new')!.addEventListener('click', () => {
    if (shopSel.value) {
      applyShopPreset(shopSel.value);
    } else {
      const fmt = PAGE_FORMAT_GROUPS.flatMap(g => g.formats).find(f => f.value === formatSel.value);
      if (fmt) {
        const s = currentProjectSettings();
        editor.set_page_settings(fmt.w, fmt.h, s.bleed_mm, s.safe_zone_mm,
          s.spine_mm_per_page, s.spine_min_mm, s.print_dpi);
      }
      editor.set_print_spec_id('');
      editor.set_page_count_rules(0, 0, 0);
    }
    _lastAutosaveJson = editor.save_state(); // re-baseline so the blank book isn't autosaved as a "change"
    refreshBoxModel();
    refreshOrderButton();
    footer.update(editor, renderer);
    enterEditor();
  });

  // Open project: reuse the shared flow; only enter on success.
  document.getElementById('start-load')!.addEventListener('click', async () => {
    if (await runOpenProject()) enterEditor();
  });

  // Restore card — only when a prior autosave exists.
  void readAutosave().then((saved) => {
    if (!saved || saved.json === editor.save_state()) return; // nothing, or identical to a fresh document
    const card = document.getElementById('start-restore-card')!;
    const info = document.getElementById('start-restore-info')!;
    info.textContent = `“${saved.name || 'project'}” — autosaved ${new Date(saved.saved).toLocaleString()}`;
    card.hidden = false;
    document.getElementById('start-restore')!.addEventListener('click', () => {
      if (!editor.load_state(saved.json)) {
        showToast('Could not restore the previous session.', 'error');
        return;
      }
      lastSaveName = saved.name || 'project';
      void afterProjectLoaded(true);
      enterEditor();
    });
    document.getElementById('start-restore-discard')!.addEventListener('click', () => {
      void clearAutosave();
      card.hidden = true;
    });
  });

  startScreen.hidden = false;
}

textEditor.setLoadFontsHandler(async () => {
  const result = await tryLoadLocalFonts();
  if (result.error !== null) {
    showFontAccessWarning(result.error);
    return;
  }
  if (result.families.length > 0) textEditor.setFontFamilies(result.families);
});
