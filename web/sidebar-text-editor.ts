// sidebar-text-editor.ts — TextElementEditor panel (shown when a text element is selected).

import type { TextElement } from './types.js';
import { debounce } from './utils.js';
import { bindInputs } from './ui-fields.js';

export class TextElementEditor {
  private containerEl: HTMLElement;
  private onChange: (el: TextElement) => void;
  private onLoadFonts: (() => Promise<void>) | null = null;
  private _built = false;
  private _current: TextElement | null = null;
  private _fontFamilies: string[] = [];

  constructor(containerEl: HTMLElement, onChange: (el: TextElement) => void) {
    this.containerEl = containerEl;
    this.onChange = onChange;
  }

  setLoadFontsHandler(handler: () => Promise<void>): void {
    this.onLoadFonts = handler;
    // If the panel is already built, wire up the button now.
    const btn = this.containerEl.querySelector<HTMLButtonElement>('#te-btn-load-fonts');
    if (btn) this._wireLoadFontsButton(btn);
  }

  clear(): void {
    this.containerEl.innerHTML = '<p class="no-selection">Select a text element to edit</p>';
    this._built = false;
    this._current = null;
  }

  show(el: TextElement): void {
    this._current = el;
    if (!this._built || this.containerEl.dataset.panel !== 'text') this._build();
    this._populate(el);
  }

  /**
   * Populate the font-family <select> with discovered system fonts.
   * Falls back to the hardcoded list if `families` is empty.
   * Call this after queryLocalFonts() resolves.
   */
  setFontFamilies(families: string[]): void {
    if (families.length === 0) return;
    this._fontFamilies = families;
    const sel = this.containerEl.querySelector<HTMLSelectElement>('[data-field="font_family"]');
    if (!sel) return; // panel not yet built — families stored, _build() will use them
    const current = sel.value;
    sel.innerHTML = families
      .map(f => `<option value="${f}">${f}</option>`)
      .join('');
    if (families.includes(current)) sel.value = current;
    const btn = this.containerEl.querySelector<HTMLButtonElement>('#te-btn-load-fonts');
    if (btn) { btn.textContent = '✓'; btn.disabled = true; }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _build(): void {
    this._built = true;
    this.containerEl.dataset.panel = 'text';

    const fallbackFonts = ['Arial', 'Courier New', 'Georgia', 'Helvetica',
                           'Impact', 'Times New Roman', 'Verdana'];
    const families = this._fontFamilies.length > 0 ? this._fontFamilies : fallbackFonts;
    const fontOptions = families.map(f => `<option value="${f}">${f}</option>`).join('');

    this.containerEl.innerHTML = `
      <div class="bm-section">
        <h4>Font</h4>
        <div class="bm-field bm-full-width te-font-family-row">
          <label>Family</label>
          <div class="te-font-family-controls">
            <select data-field="font_family">
              ${fontOptions}
            </select>
            <button id="te-btn-load-fonts" class="te-load-fonts-btn" title="Load system fonts">…</button>
          </div>
        </div>
        <div class="bm-grid" style="margin-top:4px">
          <div class="bm-field">
            <label>Size (pt)</label>
            <input type="number" min="4" max="300" step="1" data-field="font_size_pt" value="24" />
          </div>
          <div class="bm-field">
            <label>Style</label>
            <div class="te-style-row">
              <button class="te-toggle-btn" data-toggle="bold" title="Bold"><b>B</b></button>
              <button class="te-toggle-btn" data-toggle="italic" title="Italic"><i>I</i></button>
            </div>
          </div>
        </div>
      </div>
      <div class="bm-section">
        <h4>Colour &amp; Align</h4>
        <div class="bm-grid">
          <div class="bm-field">
            <label>Colour</label>
            <input type="color" data-field="color" value="#000000" />
          </div>
          <div class="bm-field">
            <label>Align</label>
            <div class="te-align-row">
              <button class="te-align-btn" data-align="left"   title="Left">L</button>
              <button class="te-align-btn" data-align="center" title="Center">C</button>
              <button class="te-align-btn" data-align="right"  title="Right">R</button>
            </div>
          </div>
        </div>
      </div>
      <div class="bm-section">
        <h4>Position (mm)</h4>
        <div class="bm-grid">
          <div class="bm-field"><label>X</label>
            <input type="number" step="0.5" data-field="x_mm" value="0" /></div>
          <div class="bm-field"><label>Y</label>
            <input type="number" step="0.5" data-field="y_mm" value="0" /></div>
        </div>
      </div>
      <div class="bm-section">
        <h4>Transform</h4>
        <div class="bm-grid bm-full-width">
          <div class="bm-field"><label>Rotation (°)</label>
            <input type="number" step="1" data-field="rotation_deg" value="0" /></div>
        </div>
      </div>
    `;

    bindInputs(this.containerEl, () => this._emit(), 'input, select, textarea');

    // Toggle buttons — bold / italic.
    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        this._emit();
      });
    });

    // Align buttons — mutually exclusive.
    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-align]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.containerEl.querySelectorAll('[data-align]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._emit();
      });
    });

    // Load-fonts button.
    const loadBtn = this.containerEl.querySelector<HTMLButtonElement>('#te-btn-load-fonts');
    if (loadBtn) this._wireLoadFontsButton(loadBtn);
  }

  private _wireLoadFontsButton(btn: HTMLButtonElement): void {
    if (!this.onLoadFonts) {
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    // Remove any old listener by replacing the element clone.
    const fresh = btn.cloneNode(true) as HTMLButtonElement;
    btn.replaceWith(fresh);
    fresh.addEventListener('click', async () => {
      fresh.disabled = true;
      fresh.textContent = '…';
      await this.onLoadFonts!();
      // Label updates are handled by setFontFamilies() after families are loaded.
    });
  }

  private _populate(el: TextElement): void {
    this._setSel('font_family', el.font_family || 'Helvetica');
    this._setNum('font_size_pt', el.font_size_pt);
    this._setToggle('bold',     el.bold);
    this._setToggle('italic',   el.italic);
    this._setColor('color',     el.color || '#000000');
    this._setAlign(el.align    || 'left');
    this._setNum('x_mm',        el.x_mm);
    this._setNum('y_mm',        el.y_mm);
    this._setNum('rotation_deg', el.rotation_deg);
  }

  private _setSel(name: string, value: string): void {
    const el = this.containerEl.querySelector<HTMLSelectElement>(`[data-field="${name}"]`);
    if (el) el.value = value;
  }

  private _setNum(name: string, value: number): void {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (el) el.value = value.toFixed(2);
  }

  private _setColor(name: string, value: string): void {
    const el = this.containerEl.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    if (el) el.value = value;
  }

  private _setToggle(name: string, active: boolean): void {
    const btn = this.containerEl.querySelector<HTMLButtonElement>(`[data-toggle="${name}"]`);
    btn?.classList.toggle('active', active);
  }

  private _setAlign(value: string): void {
    this.containerEl.querySelectorAll<HTMLButtonElement>('[data-align]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.align === value);
    });
  }

  private _emit = debounce(() => {
    if (!this._current) return;

    const gStr = (name: string): string => {
      const el = this.containerEl.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        `[data-field="${name}"]`,
      );
      return el ? el.value : '';
    };
    const gNum = (name: string): number => {
      const v = parseFloat(gStr(name));
      return isNaN(v) ? 0 : v;
    };
    const activeAlign = this.containerEl.querySelector<HTMLButtonElement>('[data-align].active');

    const updated: TextElement = {
      ...this._current,
      content:      this._current.content ?? '',
      font_family:  gStr('font_family'),
      font_size_pt: Math.max(1, gNum('font_size_pt')),
      bold:   !!this.containerEl.querySelector('[data-toggle="bold"].active'),
      italic: !!this.containerEl.querySelector('[data-toggle="italic"].active'),
      color:        gStr('color'),
      align:        activeAlign?.dataset.align ?? 'left',
      x_mm:         gNum('x_mm'),
      y_mm:         gNum('y_mm'),
      rotation_deg: gNum('rotation_deg'),
    };
    this.onChange(updated);
  }, 150);
}
