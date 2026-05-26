// undo.ts — Undo/redo button-state wrapper.
//
// The actual history stack lives in Rust (see PhotobookEditor::snapshot_undo,
// undo, redo). Snapshots are cheap struct clones, not JSON strings, and
// restores diff-mark dirty bits so incremental rendering survives undo.

import type { PhotobookEditor } from './pkg/photobook_core.js';

export class UndoManager {
  private btnUndo: HTMLButtonElement;
  private btnRedo: HTMLButtonElement;
  private editor: PhotobookEditor;

  constructor(editor: PhotobookEditor, btnUndo: HTMLButtonElement, btnRedo: HTMLButtonElement) {
    this.editor  = editor;
    this.btnUndo = btnUndo;
    this.btnRedo = btnRedo;
    this._updateButtons();

    btnUndo.addEventListener('click', () => this.undo());
    btnRedo.addEventListener('click', () => this.redo());
  }

  snapshot(): void {
    this.editor.snapshot_undo();
    this._updateButtons();
  }

  undo(): boolean {
    const ok = this.editor.undo();
    if (ok) this._updateButtons();
    return ok;
  }

  redo(): boolean {
    const ok = this.editor.redo();
    if (ok) this._updateButtons();
    return ok;
  }

  /** Clear both stacks (called after loading a project file). */
  reset(): void {
    this.editor.reset_undo();
    this._updateButtons();
  }

  private _updateButtons(): void {
    this.btnUndo.disabled = !this.editor.can_undo();
    this.btnRedo.disabled = !this.editor.can_redo();
  }
}
