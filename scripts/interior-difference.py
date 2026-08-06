#!/usr/bin/env python3
"""Appearance difference INSIDE the silhouette, over a height band, against the baseline.

Silhouette IoU is computed from the 11% of figure cells that lie on the outline; this reads the
other 89%. It exists because a faceless mannequin and a finished face scored 0.8803 and 0.8803 on
the outline metric — identical to four decimals — so that metric cannot be used to answer whether a
face is right, or present.

Both renders are aligned by bounding box, the same normalisation the score uses, then resampled to a
common lattice. Only cells that are figure in BOTH are compared, so the number is appearance and not
outline leaking back in. The result is mean absolute luminance difference as a fraction of full
range: 0.000 is pixel-identical inside the mask, and larger is further from the baseline.

Restrict with --from/--to to read one region: the head is roughly 0.00..0.19 of figure height.

Usage: interior-difference.py <baseline.png> <render.png> [<render.png> ...] [--from 0] [--to 1]
"""
import argparse
import os
import struct
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from silhouette_iou import mask_of, bbox  # noqa: E402

GRID = 192


def to_bmp(path, out_dir):
    dst = os.path.join(out_dir, os.path.basename(os.path.dirname(path)) + '-'
                       + os.path.basename(path) + '.bmp')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', path, '-pix_fmt', 'bgr24', dst],
                   check=True)
    return dst


def sample(path, tmp):
    """Per-cell (luminance, is-figure) over the figure's bounding box, on a GRID x GRID lattice."""
    bmp = to_bmp(path, tmp)
    w, h, fg, _ = mask_of(bmp)
    x0, x1, y0, y1 = bbox(w, h, fg)      # NOTE the order: bbox returns x0, x1, y0, y1
    with open(bmp, 'rb') as f:
        head = f.read(54)
        bw_, bh_ = struct.unpack('<ii', head[18:26])
        offset = struct.unpack('<i', head[10:14])[0]
        f.seek(offset)
        stride = (bw_ * 3 + 3) // 4 * 4
        data = f.read(stride * abs(bh_))

    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    luma, solid = [0.0] * (GRID * GRID), [False] * (GRID * GRID)
    for gy in range(GRID):
        ys = y0 + gy * bh // GRID
        ye = max(y0 + (gy + 1) * bh // GRID, ys + 1)
        for gx in range(GRID):
            xs = x0 + gx * bw // GRID
            xe = max(x0 + (gx + 1) * bw // GRID, xs + 1)
            total = n = on = 0
            for y in range(ys, min(ye, h)):
                row = (h - 1 - y) * stride
                for x in range(xs, min(xe, w)):
                    i = row + x * 3
                    total += data[i] + data[i + 1] + data[i + 2]
                    n += 1
                    if fg[y * w + x]:
                        on += 1
            luma[gy * GRID + gx] = (total / (3 * n)) if n else 0.0
            solid[gy * GRID + gx] = n and on > n / 2
    return luma, solid


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('baseline')
    ap.add_argument('renders', nargs='+')
    ap.add_argument('--from', dest='lo', type=float, default=0.0)
    ap.add_argument('--to', dest='hi', type=float, default=1.0)
    a = ap.parse_args(argv)

    tmp = tempfile.mkdtemp(prefix='interior-diff-')
    bl, bs = sample(a.baseline, tmp)
    rows = range(int(a.lo * GRID), max(int(a.hi * GRID), int(a.lo * GRID) + 1))

    print(f'band y/H {a.lo:.2f}..{a.hi:.2f}   vs {os.path.basename(a.baseline)}')
    for path in a.renders:
        ml, ms = sample(path, tmp)
        cells = [gy * GRID + gx for gy in rows for gx in range(GRID)
                 if bs[gy * GRID + gx] and ms[gy * GRID + gx]]
        if not cells:
            print(f'  {path}: no overlapping figure cells')
            continue
        diff = sum(abs(bl[i] - ml[i]) for i in cells) / len(cells) / 255
        label = f'{os.path.basename(os.path.dirname(path))}'
        print(f'  {label:<12} interior difference {diff:.4f}   ({len(cells)} cells)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
