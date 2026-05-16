// sidebar-divider.ts — DividerPanel (shown in sidebar when a divider is selected).

export class DividerPanel {
  private containerEl: HTMLElement;
  private onChange: (gap: number) => void;
  private _built = false;

  constructor(containerEl: HTMLElement, onChange: (gap: number) => void) {
    this.containerEl = containerEl;
    this.onChange = onChange;
  }

  show(gap: number): void {
    if (!this._built) this._build();
    (this.containerEl.querySelector('#divider-gap-input') as HTMLInputElement).value = gap.toFixed(2);
  }

  private _build(): void {
    this._built = true;
    this.containerEl.dataset.panel = 'divider';
    this.containerEl.innerHTML = `
      <div class="bm-section">
        <h4>Gap (mm)</h4>
        <div class="bm-grid">
          <div class="bm-field">
            <label>Gap</label>
            <input id="divider-gap-input" type="number" min="0" max="50" step="0.5" value="0" />
          </div>
        </div>
      </div>`;

    const input = this.containerEl.querySelector('#divider-gap-input') as HTMLInputElement;
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (!isNaN(v)) this.onChange(Math.max(0, v));
    });
  }
}
