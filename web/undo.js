// undo.ts — Undo/redo button-state wrapper.
//
// The actual history stack lives in Rust (see PhotobookEditor::snapshot_undo,
// undo, redo). Snapshots are cheap struct clones, not JSON strings, and
// restores diff-mark dirty bits so incremental rendering survives undo.
export class UndoManager {
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
        this.editor.snapshot_undo();
        this._updateButtons();
    }
    undo() {
        const ok = this.editor.undo();
        if (ok)
            this._updateButtons();
        return ok;
    }
    redo() {
        const ok = this.editor.redo();
        if (ok)
            this._updateButtons();
        return ok;
    }
    /** Clear both stacks (called after loading a project file). */
    reset() {
        this.editor.reset_undo();
        this._updateButtons();
    }
    _updateButtons() {
        this.btnUndo.disabled = !this.editor.can_undo();
        this.btnRedo.disabled = !this.editor.can_redo();
    }
}
