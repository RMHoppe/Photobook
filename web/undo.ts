// undo.ts — Undo/redo stack manager.

import type { PhotobookEditor } from './pkg/photobook_core.js';
import { UNDO_MAX } from './constants.js';

export class UndoManager {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private btnUndo: HTMLButtonElement;
  private btnRedo: HTMLButtonElement;
  private editor: PhotobookEditor;

  constructor(editor: PhotobookEditor, btnUndo: HTMLButtonElement, btnRedo: HTMLButtonElement) {
    this.editor = editor;
    this.btnUndo = btnUndo;
    this.btnRedo = btnRedo;
    this._updateButtons();

    btnUndo.addEventListener('click', () => this.undo());
    btnRedo.addEventListener('click', () => this.redo());
  }

  snapshot(): void {
    this.undoStack.push(this.editor.save_state());
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
    this.redoStack.length = 0;
    this._updateButtons();
  }

  undo(): void {
    if (this.undoStack.length === 0) return;
    this.redoStack.push(this.editor.save_state());
    this.editor.load_state(this.undoStack.pop()!);
    this._updateButtons();
  }

  redo(): void {
    if (this.redoStack.length === 0) return;
    this.undoStack.push(this.editor.save_state());
    this.editor.load_state(this.redoStack.pop()!);
    this._updateButtons();
  }

  private _updateButtons(): void {
    this.btnUndo.disabled = this.undoStack.length === 0;
    this.btnRedo.disabled = this.redoStack.length === 0;
  }
}
