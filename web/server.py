#!/usr/bin/env python3
"""Dev server: serves web/ as static files; POST /api/run-tests runs cargo test."""
import http.server
import json
import os
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def do_POST(self):
        if self.path == '/api/run-tests':
            self._handle_run_tests()
        else:
            self.send_error(404)

    def _handle_run_tests(self):
        try:
            result = subprocess.run(
                ['cargo', 'test', '-p', 'photobook-core'],
                cwd=str(PROJECT_ROOT),
                capture_output=True,
                text=True,
                timeout=120,
                env={**os.environ, 'CARGO_TERM_COLOR': 'never'},
            )
            payload = json.dumps({
                'stdout': result.stdout,
                'stderr': result.stderr,
                'exit_code': result.returncode,
            })
        except subprocess.TimeoutExpired:
            payload = json.dumps({
                'stdout': '',
                'stderr': 'Timeout: tests took longer than 120 s',
                'exit_code': -1,
            })
        except FileNotFoundError:
            payload = json.dumps({
                'stdout': '',
                'stderr': 'cargo not found — run this from a dev environment with Rust installed',
                'exit_code': -1,
            })

        data = payload.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass  # suppress per-request noise


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    httpd = http.server.HTTPServer(('', port), Handler)
    print(f'Dev server running at http://localhost:{port}', flush=True)
    httpd.serve_forever()
