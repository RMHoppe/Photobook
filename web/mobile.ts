// mobile.ts — test runner for the mobile landing page.

interface TestRunResponse {
  stdout: string;
  stderr: string;
  exit_code: number;
}

interface FailureBlock {
  name: string;
  log: string;
}

interface ParsedResults {
  passed: number;
  failed: number;
  failures: FailureBlock[];
  summaryLine: string;
}

function parseCargoOutput(stdout: string): ParsedResults {
  const lines = stdout.split('\n');
  let passed = 0, failed = 0;
  let summaryLine = '';

  for (const line of lines) {
    const m = line.match(/^test\s+\S+\s+\.\.\.\s+(ok|FAILED|ignored)\s*$/);
    if (m) {
      if (m[1] === 'ok') passed++;
      else if (m[1] === 'FAILED') failed++;
    }
    if (line.startsWith('test result:')) summaryLine = line.trim();
  }

  // Extract per-failure detail blocks from the "failures:" section.
  const failures: FailureBlock[] = [];
  const sectionStart = stdout.indexOf('\nfailures:\n\n');
  if (sectionStart !== -1) {
    const section = stdout.slice(sectionStart + '\nfailures:\n\n'.length);
    const sectionEnd = section.indexOf('\nfailures:\n');
    const detail = sectionEnd !== -1 ? section.slice(0, sectionEnd) : section;
    for (const chunk of detail.split(/^---- /m)) {
      const headerEnd = chunk.indexOf(' stdout ----');
      if (headerEnd === -1) continue;
      failures.push({
        name: chunk.slice(0, headerEnd).trim(),
        log:  chunk.slice(headerEnd + ' stdout ----'.length).trim(),
      });
    }
  }

  return { passed, failed, failures, summaryLine };
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function runTests(): Promise<void> {
  const btn        = document.getElementById('btn-run-tests') as HTMLButtonElement;
  const resultsEl  = document.getElementById('test-results')  as HTMLElement;
  const summaryEl  = document.getElementById('test-summary')  as HTMLElement;
  const failuresEl = document.getElementById('test-failures') as HTMLElement;

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Running…';
  resultsEl.hidden = false;
  summaryEl.className = 'test-summary test-running';
  summaryEl.textContent = 'Running cargo test…';
  failuresEl.innerHTML = '';

  let data: TestRunResponse;
  try {
    const resp = await fetch('/api/run-tests', { method: 'POST' });
    if (!resp.ok) throw new Error(`Server returned ${resp.status} — tests only run in the local dev environment`);
    data = await resp.json() as TestRunResponse;
  } catch (err) {
    summaryEl.className = 'test-summary test-error';
    summaryEl.textContent = err instanceof Error ? err.message : String(err);
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-flask" aria-hidden="true"></i> Run Unit Tests';
    return;
  }

  // Compilation error or cargo missing — show raw stderr.
  if (!data.stdout && data.stderr) {
    summaryEl.className = 'test-summary test-error';
    summaryEl.textContent = 'Build failed';
    failuresEl.innerHTML = `<pre class="test-log">${escHtml(data.stderr)}</pre>`;
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Run Again';
    return;
  }

  const parsed = parseCargoOutput(data.stdout);
  const allOk = parsed.failed === 0 && (parsed.passed > 0 || parsed.summaryLine !== '');

  summaryEl.className = `test-summary ${allOk ? 'test-pass' : 'test-fail'}`;
  summaryEl.textContent = parsed.summaryLine || (allOk
    ? `All ${parsed.passed} tests passed`
    : `${parsed.failed} failed, ${parsed.passed} passed`);

  for (const f of parsed.failures) {
    const block = document.createElement('div');
    block.className = 'test-failure-block';

    const header = document.createElement('div');
    header.className = 'test-failure-name';
    header.textContent = f.name;

    const log = document.createElement('pre');
    log.className = 'test-log';
    log.textContent = f.log;

    block.appendChild(header);
    block.appendChild(log);
    failuresEl.appendChild(block);
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Run Again';
}

document.getElementById('btn-run-tests')?.addEventListener('click', () => { void runTests(); });
