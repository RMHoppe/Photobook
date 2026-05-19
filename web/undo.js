// undo.ts — Undo/redo stack manager.
import { UNDO_MAX } from './constants.js';
export class UndoManager {
    undoStack = [];
    redoStack = [];
    btnUndo;
    btnRedo;
    editor;
    constructor(editor, btnUndo, btnRedo) {
        this.editor = editor;
        this.btnUndo = btnUndo;
        this.btnRedo = btnRedo;
        this._updateButtons();
        btnUndo.addEventListener('click', () => this.undo());
        btnRedo.addEventListener('click', () => this.redo());
    }
    snapshot() {
        this.undoStack.push(this.editor.save_state());
        if (this.undoStack.length > UNDO_MAX)
            this.undoStack.shift();
        this.redoStack.length = 0;
        this._updateButtons();
    }
    undo() {
        if (this.undoStack.length === 0)
            return;
        this.redoStack.push(this.editor.save_state());
        this.editor.load_state(this.undoStack.pop());
        this._updateButtons();
    }
    redo() {
        if (this.redoStack.length === 0)
            return;
        this.undoStack.push(this.editor.save_state());
        this.editor.load_state(this.redoStack.pop());
        this._updateButtons();
    }
    /** Clear both stacks (called after loading a project file). */
    reset() {
        this.undoStack = [];
        this.redoStack = [];
        this._updateButtons();
    }
    _updateButtons() {
        this.btnUndo.disabled = this.undoStack.length === 0;
        this.btnRedo.disabled = this.redoStack.length === 0;
    }
}
