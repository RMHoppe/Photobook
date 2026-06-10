// ui-fields.ts — Shared HTML builders for labeled form fields.

export type NumFieldOpts = {
  min?: number | null; // null → no min attribute (allows negative values)
  max?: number;
  step?: number;
  fullWidth?: boolean;
};

export function wrapField(label: string, input: string, fullWidth = false): string {
  return `<div class="bm-field${fullWidth ? ' bm-full-width' : ''}"><label>${label}</label>${input}</div>`;
}

export function numField(name: string, label: string, opts: NumFieldOpts = {}): string {
  const { min = 0, max = 200, step = 0.5, fullWidth = false } = opts;
  const minAttr = min !== null ? `min="${min}" ` : '';
  return wrapField(
    label,
    `<input type="number" ${minAttr}max="${max}" step="${step}" data-field="${name}" value="0" />`,
    fullWidth,
  );
}

export function numFieldWithDice(name: string, label: string, opts: NumFieldOpts = {}): string {
  const { min = 0, max = 200, step = 0.5, fullWidth = false } = opts;
  const minAttr = min !== null ? `min="${min}" ` : '';
  const maxAttr = max !== undefined ? `max="${max}" ` : '';
  return wrapField(
    label,
    `<div class="bm-input-row"><input type="number" ${minAttr}${maxAttr}step="${step}" data-field="${name}" value="0" /><button class="bm-dice-btn" data-dice="${name}" title="Randomize across selection" hidden><i class="ti ti-dice-5"></i></button></div>`,
    fullWidth,
  );
}

export function colorField(name: string, label: string): string {
  return wrapField(label, `<input type="color" data-field="${name}" value="#000000" />`);
}

/** Write a numeric value into a [data-field] input. null/undefined → Mixed placeholder. */
export function setNumField(container: HTMLElement, name: string, value: number | null | undefined): void {
  const el = container.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
  if (!el) return;
  delete el.dataset.mixed;
  if (value == null) {
    el.value = '';
    el.placeholder = 'Mixed';
    el.dataset.mixed = '1';
  } else {
    el.value = value.toFixed(2);
    el.placeholder = '';
  }
}

/** Read a numeric value from a [data-field] input. Returns null if mixed; 0 if empty (not mixed). */
export function readNumField(container: HTMLElement, name: string): number | null {
  const el = container.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
  if (!el || el.dataset.mixed) return null;
  const v = parseFloat(el.value);
  return isNaN(v) ? 0 : v;
}

export function bindInputs(container: HTMLElement, handler: () => void, selector = 'input, select'): void {
  container.querySelectorAll<HTMLElement>(selector).forEach(el => {
    const onInput = () => { delete el.dataset.mixed; handler(); };
    el.addEventListener('change', onInput);
    el.addEventListener('input',  onInput);
  });
}

export function selectField(
  name: string,
  label: string,
  options: [string, string][],
  fullWidth = false,
): string {
  const opts = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  return wrapField(
    label,
    `<select data-field="${name}"><option value="" hidden>—</option>${opts}</select>`,
    fullWidth,
  );
}
