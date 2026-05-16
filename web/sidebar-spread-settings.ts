// sidebar-spread-settings.ts — SpreadSettingsPanel (shown in sidebar when nothing is selected).

export interface SpreadSettingsData {
  default_margin_top: number;
  default_margin_right: number;
  default_margin_bottom: number;
  default_margin_left: number;
  left_bg: string;
  right_bg: string;
}

export class SpreadSettingsPanel {
  private containerEl: HTMLElement;
  private onChange: (data: SpreadSettingsData) => void;
  private _built = false;
  private _emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(containerEl: HTMLElement, onChange: (data: SpreadSettingsData) => void) {
    this.containerEl = containerEl;
    this.onChange = onChange;
  }

  show(data: SpreadSettingsData): void {
    if (!this._built) this._build();
    this._populate(data);
  }

  private _build(): void {
    this._built = true;
    this.containerEl.innerHTML = `
      <div class="bm-section">
        <h4>Default margins (mm)</h4>
        <div class="bm-grid">
          ${this._numField('def-margin-top',    'Top')}
          ${this._numField('def-margin-right',  'Right')}
          ${this._numField('def-margin-bottom', 'Bottom')}
          ${this._numField('def-margin-left',   'Left')}
        </div>
      </div>
      <div class="bm-section">
        <h4>Page backgrounds</h4>
        <div class="bm-grid">
          <div class="bm-field">
            <label>Left page</label>
            <input type="color" data-field="left-bg" value="#ffffff" />
          </div>
          <div class="bm-field">
            <label>Right page</label>
            <input type="color" data-field="right-bg" value="#ffffff" />
          </div>
        </div>
      </div>
    `;

    this.containerEl.querySelectorAll<HTMLInputElement>('input').forEach(el => {
      el.addEventListener('change', () => this._emit());
      el.addEventListener('input',  () => this._emit());
    });
  }

  private _populate(data: SpreadSettingsData): void {
    this._setNum('def-margin-top',    data.default_margin_top);
    this._setNum('def-margin-right',  data.default_margin_right);
    this._setNum('def-margin-bottom', data.default_margin_bottom);
    this._setNum('def-margin-left',   data.default_margin_left);
    this._setColor('left-bg',  data.left_bg  || '#ffffff');
    this._setColor('right-bg', data.right_bg || '#ffffff');
  }

  private _setNum(name: string, value: number): void {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (el) el.value = value.toFixed(2);
  }

  private _setColor(name: string, value: string): void {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (el) el.value = value;
  }

  private _numField(name: string, label: string): string {
    return `<div class="bm-field">
      <label>${label}</label>
      <input type="number" min="0" max="200" step="0.5" data-field="${name}" value="0" />
    </div>`;
  }

  private _emit(): void {
    if (this._emitTimer !== null) clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => {
      const g = (name: string): number => {
        const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
        if (!el) return 0;
        const v = parseFloat(el.value);
        return isNaN(v) ? 0 : v;
      };
      const gc = (name: string): string => {
        const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
        return el ? el.value : '#ffffff';
      };
      this.onChange({
        default_margin_top:    g('def-margin-top'),
        default_margin_right:  g('def-margin-right'),
        default_margin_bottom: g('def-margin-bottom'),
        default_margin_left:   g('def-margin-left'),
        left_bg:  gc('left-bg'),
        right_bg: gc('right-bg'),
      });
    }, 150);
  }
}
