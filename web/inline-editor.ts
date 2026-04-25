// inline-editor.ts — Overlay textarea for in-place text editing on the canvas.

import type { PhotobookEditor } from './pkg/photobook_core.js';
import type { CanvasRenderer } from './canvas.js';
import type { TextElement } from './types.js';
import { getSpreadInfo, getTextElements, updateTextElement } from './wasm-bridge.js';

export interface InlineEditorCallbacks {
  snapshot: () => void;
  redraw: () => void;
  refreshBoxModel: () => void;
  spreadRect: () => { x: number; y: number; w: number; h: number };
  /** Called on each keystroke so the sidebar panel stays in sync. */
  showTextEditor: (el: TextElement) => void;
}

export class InlineEditor {
  private textarea: HTMLTextAreaElement;
  private ruler: HTMLSpanElement;

  // Anchor state captured when an edit session starts (canvas-area CSS px).
  private _ox   = 0; // left edge of bounding box
  private _hw   = 0; // initial half-width (for centre/right anchor calculation)
  private _xMm  = 0; // el.x_mm at edit start (mm) — for x_mm correction on resize
  private _dirty = false;

  private editor: PhotobookEditor;
  private renderer: CanvasRenderer;
  private cb: InlineEditorCallbacks;

  constructor(
    areaEl: HTMLElement,
    editor: PhotobookEditor,
    renderer: CanvasRenderer,
    callbacks: InlineEditorCallbacks,
  ) {
    this.editor   = editor;
    this.renderer = renderer;
    this.cb       = callbacks;

    // Textarea overlay — appended to canvas-area so it scrolls/clips correctly.
    this.textarea = document.createElement('textarea');
    this.textarea.id = 'inline-text-editor';
    // Disable word-wrap so long lines behave like the canvas (no implicit newlines).
    this.textarea.setAttribute('wrap', 'off');
    areaEl.appendChild(this.textarea);

    // Hidden span for measuring line widths in the browser's actual font metrics.
    this.ruler = document.createElement('span');
    this.ruler.style.cssText =
      'position:fixed;top:-9999px;left:-9999px;visibility:hidden;' +
      'pointer-events:none;white-space:pre;margin:0;padding:0;border:none;';
    document.body.appendChild(this.ruler);

    this._wireEvents();
  }

  get isActive(): boolean { return this.renderer.editingTextId !== null; }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  start(textId: number): void {
    const textElements = getTextElements(this.editor);
    const el = textElements.find(t => t.id === textId);
    if (!el) return;

    const sr = this.cb.spreadRect();
    const spreadInfo = getSpreadInfo(this.editor);
    const mmToPx = sr.w / spreadInfo.width_mm;

    // Position of the text element's top-left in canvas-area CSS coordinates.
    const areaEl   = this.textarea.parentElement!;
    const areaRect = areaEl.getBoundingClientRect();
    const canvasEl = areaEl.querySelector('canvas')!;
    const canvasRect = canvasEl.getBoundingClientRect();
    const ox = (canvasRect.left - areaRect.left) + sr.x + el.x_mm * mmToPx;
    const oy = (canvasRect.top  - areaRect.top)  + sr.y + el.y_mm * mmToPx;

    // Font metrics — must match canvas rendering (1 pt = 25.4/72 mm).
    const fontPx = el.font_size_pt * (25.4 / 72) * mmToPx;
    const lineH  = fontPx * 1.2;

    // Half-dimensions from the last rendered hit box.
    const hit = this.renderer._textHits.find(h => h.id === textId);
    const hw  = hit ? hit.hw : fontPx;
    const hh  = hit ? hit.hh : lineH / 2;

    // Store anchors for resize() and x_mm correction.
    this._ox   = ox;
    this._hw   = hw;
    this._xMm  = el.x_mm;

    const textH = Math.max(hh * 2, lineH + 4);

    this.textarea.value              = el.content ?? '';
    this.textarea.style.left         = `${ox}px`;
    this.textarea.style.top          = `${oy}px`;
    this.textarea.style.width        = `${hw * 2}px`;
    this.textarea.style.height       = `${textH}px`;
    this.textarea.style.fontSize     = `${fontPx}px`;
    this.textarea.style.fontFamily   = `"${el.font_family}", sans-serif`;
    this.textarea.style.fontWeight   = el.bold   ? 'bold'   : 'normal';
    this.textarea.style.fontStyle    = el.italic ? 'italic' : 'normal';
    this.textarea.style.color        = el.color  || '#000';
    this.textarea.style.textAlign    = el.align  || 'left';
    this.textarea.style.lineHeight   = `${lineH}px`;
    // transform-origin 50% 50% keeps the rotation centre at the element midpoint.
    this.textarea.style.transformOrigin = '50% 50%';
    this.textarea.style.transform    = el.rotation_deg !== 0
      ? `rotate(-${el.rotation_deg}deg)` : '';
    this.textarea.style.display = 'block';

    this.renderer.editingTextId = textId;
    this._dirty = false;
    this.cb.redraw();

    this.resize();
    this.textarea.focus();
    const len = this.textarea.value.length;
    this.textarea.setSelectionRange(len, len);
  }

  stop(): void {
    if (this.renderer.editingTextId === null) return;
    this.textarea.style.display = 'none';
    this.renderer.editingTextId = null;
    this.cb.redraw();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Measure the widest line and resize/reposition the textarea to keep the alignment anchor fixed. */
  resize(): number {
    if (this.renderer.editingTextId === null) return 0;

    this.ruler.style.fontSize   = this.textarea.style.fontSize;
    this.ruler.style.fontFamily = this.textarea.style.fontFamily;
    this.ruler.style.fontWeight = this.textarea.style.fontWeight;
    this.ruler.style.fontStyle  = this.textarea.style.fontStyle;

    const lines = this.textarea.value.split('\n');
    let maxLineW = 0;
    for (const line of lines) {
      this.ruler.textContent = line || '\u00A0';
      maxLineW = Math.max(maxLineW, this.ruler.offsetWidth);
    }
    const fontPx = parseFloat(this.textarea.style.fontSize) || 16;
    const newW = Math.max(maxLineW + 4, fontPx);

    const textElements = getTextElements(this.editor);
    const el = textElements.find(t => t.id === this.renderer.editingTextId);
    const align = el?.align ?? 'left';

    let newLeft = this._ox;
    if (align === 'center') {
      newLeft = this._ox + this._hw - newW / 2;
    } else if (align === 'right') {
      newLeft = this._ox + 2 * this._hw - newW;
    }

    this.textarea.style.left  = `${newLeft}px`;
    this.textarea.style.width = `${newW}px`;
    return newW;
  }

  private _wireEvents(): void {
    this.textarea.addEventListener('input', () => {
      const id = this.renderer.editingTextId;
      if (id === null) return;

      // Take one snapshot before the first change so the full edit is undoable.
      if (!this._dirty) {
        this._dirty = true;
        this.cb.snapshot();
      }

      const textElements = getTextElements(this.editor);
      const el = textElements.find(t => t.id === id);
      if (!el) return;

      this.textarea.style.height = 'auto';
      this.textarea.style.height = `${this.textarea.scrollHeight}px`;
      const newW = this.resize();

      // Adjust x_mm so the canvas renders at the same anchor as the overlay.
      const sr = this.cb.spreadRect();
      const mmToPx = sr.w / getSpreadInfo(this.editor).width_mm;
      const align = el.align ?? 'left';
      let x_mm_new = this._xMm;
      if (align === 'center') {
        x_mm_new = this._xMm + (this._hw - newW / 2) / mmToPx;
      } else if (align === 'right') {
        x_mm_new = this._xMm + (2 * this._hw - newW) / mmToPx;
      }

      const updated = { ...el, content: this.textarea.value, x_mm: x_mm_new };
      updateTextElement(this.editor, updated);
      this.cb.showTextEditor(updated);
      this.cb.redraw();
    });

    this.textarea.addEventListener('blur', () => {
      const wasEditing = this.renderer.editingTextId !== null;
      this.stop();
      if (wasEditing) this.cb.refreshBoxModel();
    });

    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.textarea.blur();
        e.preventDefault();
      }
      // Prevent canvas keyboard shortcuts from firing while typing.
      e.stopPropagation();
    });

    // Close the editor when the user clicks anywhere outside it.
    // Use capture phase so this fires before the canvas mousedown handler.
    document.addEventListener('mousedown', (e) => {
      if (this.renderer.editingTextId === null) return;
      if (this.textarea.contains(e.target as Node)) return;
      this.stop();
      // Defer blur() so the synchronous blur event doesn't cascade during this mousedown.
      setTimeout(() => { this.textarea.blur(); }, 0);
    }, true);
  }
}
