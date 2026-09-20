// num-input.ts — <num-input> custom element: a numeric field with its own spin buttons.
//
// Browsers style the native type="number" spinner differently (Firefox hides it until
// hover), so every numeric field wraps its <input type="number"> in <num-input>: the
// host is the bordered box, the real input sits inside it borderless with the native
// spinner suppressed, and a stacked +/- pair is pinned to the right edge (styled in
// style.css). The input stays in the light DOM, so [data-field] / #id queries and
// bindInputs() keep addressing the plain input exactly as before.

class NumInput extends HTMLElement {
  private _spin: HTMLSpanElement | null = null;

  connectedCallback(): void {
    if (this._spin) return; // already upgraded
    const spin = document.createElement('span');
    spin.className = 'num-spin';
    // the arrows are CSS-drawn triangles, not glyphs: ▴/▾ fall back to different
    // faces (and so different optical sizes) depending on the installed fonts
    spin.innerHTML =
      '<button type="button" tabindex="-1" data-step="1" aria-label="Increase"></button>' +
      '<button type="button" tabindex="-1" data-step="-1" aria-label="Decrease"></button>';
    spin.addEventListener('click', ev => {
      const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (b) this.step(Number(b.dataset.step));
    });
    this._spin = spin;
    this.appendChild(spin);
  }

  get input(): HTMLInputElement | null {
    return this.querySelector<HTMLInputElement>(':scope > input');
  }

  // Stepped by hand rather than via input.stepUp(): that throws on step="any".
  step(dir: number): void {
    const inp = this.input;
    if (!inp || inp.disabled) return;
    const raw = inp.getAttribute('step');
    const s = (!raw || raw === 'any') ? 1 : (parseFloat(raw) || 1);
    let v = parseFloat(inp.value);
    if (!isFinite(v)) v = 0;
    v = parseFloat((v + dir * s).toPrecision(12)); // drop binary-float noise
    const mn = parseFloat(inp.getAttribute('min') ?? '');
    const mx = parseFloat(inp.getAttribute('max') ?? '');
    if (isFinite(mn)) v = Math.max(v, mn);
    if (isFinite(mx)) v = Math.min(v, mx);
    inp.value = String(v);
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

if (!customElements.get('num-input')) customElements.define('num-input', NumInput);
