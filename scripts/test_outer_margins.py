#!/usr/bin/env python3
"""Run the actual margin engine and write an SVG gallery, text layouts and JSON results.
Requires Python 3 and the project's Rust toolchain. No Python packages needed.
"""
import argparse
import html
import itertools
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
EPS = 0.002  # mm: tolerate f32 layout arithmetic


def margin(t, r=None, b=None, l=None):
    return dict(top=t, right=t if r is None else r,
                bottom=t if b is None else b, left=t if l is None else l)


def cases():
    pieces = dict(I=[0, 1, 2, 3], O=[0, 1, 4, 5], T=[0, 1, 2, 5],
                  L=[0, 4, 5, 6], J=[2, 4, 5, 6], S=[1, 2, 4, 5], Z=[0, 1, 5, 6])
    for name, cells in pieces.items():
        # Generate every orientation and every translation fitting either grid.
        for width, height in [(4, 2), (2, 4)]:
            seen = set()
            points = [(i % 4, i // 4) for i in cells]
            for rotation in range(4):
                if rotation:
                    points = [(-y, x) for x, y in points]
                minx, miny = min(x for x, y in points), min(y for x, y in points)
                norm = [(x-minx, y-miny) for x, y in points]
                for dx in range(width-max(x for x, y in norm)):
                    for dy in range(height-max(y for x, y in norm)):
                        selection = tuple(sorted((y+dy)*width+x+dx for x, y in norm))
                        if selection in seen:
                            continue
                        seen.add(selection)
                        yield f'{width}x{height}-{name}-' + '-'.join(map(str, selection)), [
                            [i/width for i in range(1, width)] for _ in range(height)], selection
    for selection in [(0, 2, 3), (0, 2), (0, 3), (0, 1, 3, 4)]:
        yield 'unequal-' + '-'.join(map(str, selection)), [[.6], [.3, .6]], selection
    for name, selection in [('ring', (0, 1, 2, 3, 5, 6, 7, 8)),
                            ('O', (0, 1, 3, 4)), ('diagonal', (0, 4, 8))]:
        yield '3x3-' + name, [[1/3, 2/3]]*3, selection

    yield '3x3-ring-pinwheel', [[1/3, 2/3]]*3, (0, 1, 2, 3, 5, 6, 7, 8)


def rects(frames):
    return {f['id']: tuple(f['rect'][k] for k in ('x', 'y', 'w', 'h')) for f in frames}


def same(a, b):
    return a.keys() == b.keys() and all(abs(x-y) < EPS for key in a for x, y in zip(a[key], b[key]))


def intersection(a, b):
    x, y, w, h = a
    u, v, p, q = b
    return max(0, min(x+w, u+p)-max(x, u))*max(0, min(y+h, v+q)-max(y, v))


def inside(x, y, r):
    return r[0] <= x <= r[0]+r[2] and r[1] <= y <= r[1]+r[3]


def outline_regions(before, after, m):
    """Exact cell partition comparison to rectangular erosion of the selected union.

    At each cell midpoint the translated margin rectangle must be entirely covered
    by original selected panels. This handles notches and holes independently of
    the engine's edge/twin representation. Only used for zero-gap baselines.
    """
    l, r, t, b = (m[k] or 0 for k in ('left', 'right', 'top', 'bottom'))
    xs, ys = {0., 200.}, {0., 200.}
    for x, y, w, h in before:
        for edge in (x, x+w):
            xs.update((edge+l, edge-r))
        for edge in (y, y+h):
            ys.update((edge+t, edge-b))
    for x, y, w, h in after:
        xs.update((x, x+w))
        ys.update((y, y+h))
    xs, ys = sorted(xs), sorted(ys)
    regions = []
    for x0, x1 in zip(xs, xs[1:]):
        for y0, y1 in zip(ys, ys[1:]):
            if x1-x0 < EPS or y1-y0 < EPS:
                continue
            x, y = (x0+x1)/2, (y0+y1)/2
            box = (x-l, y-t, l+r, t+b)
            # Area noise scales with the neighborhood perimeter. Serialized f32
            # rectangles can leave micron-sized seams at unequal splits.
            expected = abs(sum(intersection(box, p) for p in before)-(l+r)*(t+b)) < EPS * (l+r+t+b)
            actual = any(inside(x, y, p) for p in after)
            if expected != actual:
                regions.append((x0, y0, x1-x0, y1-y0, actual))
    return regions


def outline_error(before, after, m):
    return sum(w*h for x, y, w, h, actual in outline_regions(before, after, m))


def checks(data, selection, m, gap):
    before, after = rects(data['before']), rects(data['after'])
    selected = {data['ids'][i] for i in selection}
    failures = []
    if not all(w > 0 and h > 0 for x, y, w, h in after.values()):
        failures.append('non-positive panel dimensions')
    if any(intersection(a, b) > .01 for a, b in itertools.combinations(after.values(), 2)):
        failures.append('panels overlap')
    if not same({k: v for k, v in before.items() if k not in selected},
                {k: v for k, v in after.items() if k not in selected}):
        failures.append('unselected panels changed')
    for label, expected in [('undone', before), ('redone', after), ('reloaded', after)]:
        if not same(expected, rects(data[label])):
            failures.append(label + ' geometry differs')
    for side, value in m.items():
        actual = data['readback'][side]
        if value is not None and (actual is None or abs(actual-value) > EPS):
            failures.append(f'{side} readback: expected {value}, got {actual}')
    # Check the gap at every original shared selected seam, where faces still overlap.
    for a, b in itertools.combinations(selected, 2):
        ra, rb = before[a], before[b]
        for axis in (0, 1):
            other = 1-axis
            first, second = (a, b) if ra[axis] < rb[axis] else (b, a)
            u, v = before[first], before[second]
            overlap = min(u[other]+u[other+2], v[other]+v[other+2])-max(u[other], v[other])
            oldgap = v[axis]-u[axis]-u[axis+2]
            if overlap > EPS and abs(oldgap-gap) < EPS:
                u, v = after[first], after[second]
                newgap = v[axis]-u[axis]-u[axis+2]
                if abs(newgap-oldgap) > EPS:
                    failures.append(f'internal gap {first}/{second}: {oldgap:.3f} -> {newgap:.3f} mm')
    error = None
    if gap == 0 and all(v is not None for v in m.values()):
        error = outline_error([before[k] for k in selected], [after[k] for k in selected], m)
        if error > .1:
            failures.append(f'selected outline differs by {error:.2f} square mm')
    return failures, error


def svg(data, selection, title, m, gap, pinwheel=False):
    selected = {data['ids'][i] for i in selection}
    labels = {fid: chr(65+i) for i, fid in enumerate(data['ids'])}
    width = 660 if pinwheel else 440
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} 242">',
             f'<rect width="{width}" height="242" fill="white"/>',
             f'<text x="10" y="12" font-size="7">{html.escape(title)}</text>']
    stages = [(10, 'before'), (230, 'margin_after'), (450, 'after')] if pinwheel else [(10, 'before'), (230, 'after')]
    for offset, key in stages:
        caption = {'before': '1. Original ring', 'margin_after': '2. Margins applied', 'after': '3. Pinwheel added'}[key] if pinwheel else key
        parts.append(f'<g transform="translate({offset},30)"><text y="-5" font-size="8">{caption} (mm)</text><rect width="200" height="200" fill="#fff4dd" stroke="#333" stroke-width=".4"/>')
        for f in data[key]:
            x, y, w, h = (f['rect'][k] for k in ('x', 'y', 'w', 'h'))
            fill = '#5aa8df' if f['id'] in selected else '#d9dde2'
            if pinwheel and f['id'] == data['ids'][-1]:
                fill = '#48ba9a'
            parts.append(f'<rect x="{x}" y="{y}" width="{max(0,w)}" height="{max(0,h)}" fill="{fill}" fill-opacity=".75" stroke="#333" stroke-width=".3"/>')
            parts.append(f'<text x="{x+w/2}" y="{y+h/2}" text-anchor="middle" font-size="6">{labels[f["id"]]}</text>')
        if key != 'before':
            if (not pinwheel or key == 'margin_after') and gap == 0 and all(v is not None for v in m.values()):
                before, after = rects(data['before']), rects(data[key])
                regions = outline_regions([before[k] for k in selected],
                                          [after[k] for k in selected], m)
                for x, y, w, h, actual in regions:
                    color = '#e76f00' if actual else '#d000c8'
                    parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{color}" fill-opacity=".85"><title>{"Outside expected outline" if actual else "Missing selected area"}</title></rect>')
            for a, b in itertools.combinations(rects(data[key]).values(), 2):
                if intersection(a, b) > .01:
                    x, y = max(a[0], b[0]), max(a[1], b[1])
                    w = min(a[0]+a[2], b[0]+b[2])-x
                    h = min(a[1]+a[3], b[1]+b[3])-y
                    parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#ed1111"><title>Panel overlap</title></rect>')
        parts.append('</g>')
    return ''.join(parts) + '</svg>'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=pathlib.Path, default=ROOT/'target/outer-margin-report')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--all', action='store_true', help='run the exhaustive regression matrix')
    mode.add_argument('--quick', action='store_true', help='alias for the default five showcase cases')
    args = parser.parse_args()
    subprocess.run(['cargo', 'build', '--offline', '--quiet', '-p', 'photobook-core',
                    '--example', 'outer_margin_probe'], cwd=ROOT, check=True)
    metadata = json.loads(subprocess.check_output(['cargo', 'metadata', '--offline', '--no-deps', '--format-version=1'], cwd=ROOT))
    binary = pathlib.Path(metadata['target_directory'])/'debug/examples/outer_margin_probe'
    variants = [('uniform5', [margin(5)]), ('uniform10', [margin(10)]),
                ('asymmetric', [margin(3, 7, 11, 5)]),
                ('top-only', [dict(top=8, right=None, bottom=None, left=None)]),
                ('asymmetric-top', [margin(3, 7, 11, 5), dict(top=8, right=None, bottom=None, left=None)]),
                ('repeat10', [margin(10), margin(10)]),
                ('live10', [margin(5), margin(10), margin(5), margin(10)])]
    # One deliberate setting per shape: keep the default report visually scannable.
    showcase = {
        '4x2-T-0-1-2-5': ('asymmetric', 'T: inspect both shoulders for overlapping panels.'),
        '4x2-S-1-2-4-5': ('asymmetric', 'S: inspect the two opposite notches for overlap and outline errors.'),
        'unequal-0-1-3-4': ('asymmetric', 'Unequal panels: inspect the notch above the unselected lower-left panel.'),
        '3x3-ring': ('uniform10', 'Ring: inspect all four corners around the unselected center.'),
        '3x3-ring-pinwheel': ('uniform10', 'Apply 10 mm margins to the ring first, then add J with a clockwise pinwheel with a nominal 30 × 30 mm layout cell at original center E’s top-right junction. Do not reapply margins. Green is the new panel; inspect its seams and nearby overlaps.'),
    }
    requests, descriptions = [], []
    for name, rows, selection in cases():
        if not args.all and name not in showcase:
            continue
        for gap in ((0, 4) if args.all else (0,)):
            for variant, steps in variants:
                if name == '3x3-ring-pinwheel' and (gap != 0 or variant != 'uniform10'):
                    continue
                if not args.all and variant != showcase[name][0]:
                    continue
                request = dict(rows=rows, selection=selection, gap=gap, steps=steps)
                if name == '3x3-ring-pinwheel':
                    request['pinwheel'] = dict(anchor_index=4, size_mm=30)
                requests.append(request)
                descriptions.append((f'{name}-gap{gap}-{variant}', name, variant))
    proc = subprocess.run([str(binary)], input=''.join(json.dumps(r)+'\n' for r in requests),
                          capture_output=True, text=True)
    if proc.returncode:
        raise RuntimeError(proc.stderr)
    results = [json.loads(line) for line in proc.stdout.splitlines()]
    if len(results) != len(requests):
        raise RuntimeError('probe returned an incomplete result set')
    args.output.mkdir(parents=True, exist_ok=True)
    report, gallery, baselines = [], [], {}
    for req, data, (slug, name, variant) in zip(requests, results, descriptions):
        effective = dict.fromkeys(('top', 'right', 'bottom', 'left'))
        for step in req['steps']:
            effective.update({k: v for k, v in step.items() if v is not None})
        if 'pinwheel' in req:
            margin_data = dict(data, after=data['margin_after'], undone=data['margin_undone'],
                               redone=data['margin_redone'], reloaded=data['margin_reloaded'])
            failures, error = checks(margin_data, req['selection'], effective, req['gap'])
            failures = ['margin stage: ' + f for f in failures]
            final = rects(data['after'])
            new_panel = next(f for f in data['after'] if f['id'] == data['ids'][-1])
            if any(abs(new_panel['face_rect'][axis] - req['pinwheel']['size_mm']) > EPS for axis in ('w', 'h')):
                failures.append('pinwheel: new layout cell has unexpected size')
            # At E's top-right junction the clockwise pinwheel replaces the
            # four B/C/E/F contacts. Preserve each visible arm gap separately.
            prior = rects(data['margin_after'])
            b, c, e, f = (prior[data['ids'][i]] for i in (1, 2, 4, 5))
            expected_gaps = [c[0]-b[0]-b[2], f[0]-e[0]-e[2],
                             f[1]-c[1]-c[3], e[1]-b[1]-b[3]]
            b, c, e, f = (final[data['ids'][i]] for i in (1, 2, 4, 5))
            j = final[data['ids'][-1]]
            actual_gaps = [j[0]-b[0]-b[2], f[0]-j[0]-j[2],
                           j[1]-c[1]-c[3], e[1]-j[1]-j[3]]
            for side, actual, expected in zip(('left', 'right', 'top', 'bottom'), actual_gaps, expected_gaps):
                if abs(actual-expected) > EPS:
                    failures.append(f'pinwheel: {side} gap changed from {expected:.3f} to {actual:.3f} mm')
            if len(final) != len(data['before']) + 1:
                failures.append('pinwheel did not add exactly one panel')
            if not all(w > 0 and h > 0 for x, y, w, h in final.values()):
                failures.append('pinwheel: non-positive panel dimensions')
            if any(intersection(a, b) > .01 for a, b in itertools.combinations(final.values(), 2)):
                failures.append('pinwheel: panels overlap')
            if any(x < -EPS or y < -EPS or x+w > 200+EPS or y+h > 200+EPS for x, y, w, h in final.values()):
                failures.append('pinwheel: panel extends outside page')
            for stage, expected in [('undone', rects(data['margin_after'])), ('redone', final), ('reloaded', final)]:
                if not same(expected, rects(data[stage])):
                    failures.append('pinwheel: ' + stage + ' geometry differs')
        else:
            failures, error = checks(data, req['selection'], effective, req['gap'])
        key = (name, req['gap'])
        if variant == 'uniform10':
            baselines[key] = rects(data['after'])
        elif variant in ('repeat10', 'live10') and not same(baselines[key], rects(data['after'])):
            failures.append('repeated/live updates differ from direct 10 mm application')
        status = 'FAIL' if failures else 'PASS'
        focus = showcase.get(name, ('', ''))[1]
        text = [slug, status, focus, 'Selected panels: ' + ' '.join(chr(65+i) for i in req['selection']),
                'Margins: ' + json.dumps(req['steps']), ('Original grid labels before margins and pinwheel (* = selected):' if 'pinwheel' in req else 'Baseline layout (* = selected):')]
        i = 0
        for row in req['rows']:
            text.append(' | '.join(chr(65+j)+('*' if j in req['selection'] else ' ') for j in range(i, i+len(row)+1)))
            i += len(row)+1
        if 'pinwheel' in req:
            text.append('Sequence: BEFORE = original ring; MARGIN_AFTER = ring margins applied; AFTER = pinwheel added. Margins are not reapplied. J is new and was not in the margin selection.')
        for stage in (('before', 'margin_after', 'after') if 'pinwheel' in req else ('before', 'after')):
            if 'pinwheel' in req:
                text.extend(['', stage.upper() + ' sampled map (uppercase = selected, lowercase = unselected, . = gap):'])
                rs = rects(data[stage])
                for row in range(30):
                    line = ''
                    for col in range(60):
                        hits = [i for i, fid in enumerate(data['ids']) if fid in rs and inside((col+.5)*200/60, (row+.5)*200/30, rs[fid])]
                        line += ('!' if len(hits)>1 else (chr(65+hits[0]) if hits[0] in req['selection'] else chr(97+hits[0]))) if hits else '.'
                    text.append(line)
            text.extend(['', stage.upper() + ' (mm)', 'panel       x         y         w         h'])
            geometry = rects(data[stage])
            for i, fid in enumerate(data['ids']):
                if fid not in geometry:
                    continue
                text.append(f'{chr(65+i):5s}' + ''.join(f'{v:10.3f}' for v in geometry[fid]))
        text.extend(['', *failures])
        (args.output/(slug+'.txt')).write_text('\n'.join(text)+'\n')
        (args.output/(slug+'.svg')).write_text(svg(data, req['selection'], slug + ' ' + status, effective, req['gap'], 'pinwheel' in req))
        report.append(dict(case=slug, status=status, failures=failures, outline_error_mm2=error,
                           request=req, geometry=data))
        gallery.append(f'<article class="{status}"><h3>{html.escape(slug)}: {status}</h3><p>{html.escape(focus)}</p><p>Margins (mm): {html.escape(json.dumps(req['steps'][-1]))}</p><a href="{slug}.txt">Text layout</a><img loading="lazy" src="{slug}.svg"><pre>{html.escape(chr(10).join(failures))}</pre></article>')
    failed = sum(r['status'] == 'FAIL' for r in report)
    summary = f'{len(report)} cases: {len(report)-failed} passed, {failed} failed'
    (args.output/'results.json').write_text(json.dumps(report, indent=2)+'\n')
    (args.output/'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Outer margin tests</title><style>body{font:14px system-ui;margin:24px}article{border:1px solid #aaa;padding:12px;margin:16px 0}img{display:block;width:min(100%,1000px)}.FAIL h3{color:#ad2222}pre{white-space:pre-wrap}</style><h1>'+summary+'</h1><p>Blue: selected. Gray: unselected. Green: newly inserted pinwheel panel. Cream: uncovered page. <strong>Red: overlap. Magenta: missing selected area. Orange: outside expected outline.</strong> Images show actual core geometry, not browser screenshots. PASS covers automated checks only; review corner appearance and panel proportions visually. Zero-gap outline checks use the proposed inset-of-union expectation. Nonzero-gap and top-only cases omit that oracle.</p>'+''.join(gallery))
    print(summary)
    print(args.output/'index.html')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
