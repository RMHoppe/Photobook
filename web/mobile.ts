// mobile.ts — in-browser test runner.
// Test exports (wasm_test_list, wasm_test_run) are included in the main WASM
// build via the wasm-test feature being part of the default feature set.
// Panics in wasm_test_run propagate as JS exceptions (console_error_panic_hook),
// which we catch per-test without killing the WASM instance.

// Dynamic import so TypeScript doesn't require the generated pkg to exist at
// compile time. The actual module is resolved at runtime from pkg/.
type WasmModule = {
  default: (input?: string | URL | Request | BufferSource | WebAssembly.Module) => Promise<unknown>;
  init_panic_hook: () => void;
  wasm_test_list: () => string;
  wasm_test_run: (name: string) => void;
};

async function loadWasm(): Promise<WasmModule> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return import('./pkg/photobook_core.js') as Promise<WasmModule>;
}

async function runTests(): Promise<void> {
  const btn        = document.getElementById('btn-run-tests') as HTMLButtonElement;
  const resultsEl  = document.getElementById('test-results')  as HTMLElement;
  const summaryEl  = document.getElementById('test-summary')  as HTMLElement;
  const failuresEl = document.getElementById('test-failures') as HTMLElement;

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Loading…';
  resultsEl.hidden = false;
  summaryEl.className = 'test-summary test-running';
  summaryEl.textContent = 'Initialising test WASM…';
  failuresEl.innerHTML = '';

  let wasm: WasmModule;
  try {
    wasm = await loadWasm();
    await wasm.default();          // initialise the WASM module
    wasm.init_panic_hook();        // panics → JS exceptions, not traps
  } catch (err) {
    summaryEl.className = 'test-summary test-error';
    summaryEl.textContent = `Failed to load test WASM: ${err instanceof Error ? err.message : String(err)}`;
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-flask" aria-hidden="true"></i> Run Unit Tests';
    return;
  }

  const testNames = JSON.parse(wasm.wasm_test_list()) as string[];
  let passed = 0;
  const failures: Array<{ name: string; message: string }> = [];

  summaryEl.textContent = `Running 0 / ${testNames.length}…`;

  for (let i = 0; i < testNames.length; i++) {
    const name = testNames[i];
    summaryEl.textContent = `Running ${i + 1} / ${testNames.length}: ${name}`;
    try {
      wasm.wasm_test_run(name);
      passed++;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // console_error_panic_hook emits "panicked at 'msg', file:line:col"
      // Strip the prefix to keep just the assertion message.
      const message = raw.replace(/^panicked at /, '');
      failures.push({ name, message });
    }
  }

  const total = testNames.length;
  const allOk = failures.length === 0;
  summaryEl.className = `test-summary ${allOk ? 'test-pass' : 'test-fail'}`;
  summaryEl.textContent = allOk
    ? `All ${total} tests passed`
    : `${failures.length} failed, ${passed} passed (${total} total)`;

  for (const f of failures) {
    const block = document.createElement('div');
    block.className = 'test-failure-block';

    const header = document.createElement('div');
    header.className = 'test-failure-name';
    header.textContent = f.name;

    const log = document.createElement('pre');
    log.className = 'test-log';
    log.textContent = f.message;

    block.appendChild(header);
    block.appendChild(log);
    failuresEl.appendChild(block);
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Run Again';
}

document.getElementById('btn-run-tests')?.addEventListener('click', () => { void runTests(); });
