"""Developer preview: render models to an enlarged PNG montage (not part of the pack)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402


def montage(images, scale=4, bg=(40, 46, 54), path='preview.png', team=(77, 140, 242), pad=6, max_width=1800):
    """Lay out core.Image frames on a dark ground in wrapped rows, enlarged `scale` times, and write a PNG."""
    ims = [i for i in images if i.w]
    rows, row, width = [], [], pad
    for im in ims:
        w = im.w * scale + pad
        if row and width + w > max_width:
            rows.append(row)
            row, width = [], pad
        row.append(im)
        width += w
    if row:
        rows.append(row)
    W = max(sum(i.w * scale + pad for i in r) + pad for r in rows)
    heights = [max(i.h * scale for i in r) + pad for r in rows]
    H = sum(heights) + pad
    out = bytearray(bytes(bg + (255,)) * (W * H))
    top = pad
    for r, rh in zip(rows, heights):
        x = pad
        for im in r:
            for yy in range(im.h):
                for xx in range(im.w):
                    o = (yy * im.w + xx) * 4
                    a = im.rgba[o + 3]
                    if not a:
                        continue
                    cr, cg, cb = im.rgba[o], im.rgba[o + 1], im.rgba[o + 2]
                    if im.team[yy * im.w + xx]:
                        m = 0.35 + (cr / 255) * 1.05
                        cr, cg, cb = [min(255, int(c * m)) for c in team]
                    al = a / 255
                    for sy in range(scale):
                        for sx in range(scale):
                            p = ((top + (rh - pad - im.h * scale) + yy * scale + sy) * W + x + xx * scale + sx) * 4
                            out[p] = int(out[p] * (1 - al) + cr * al)
                            out[p + 1] = int(out[p + 1] * (1 - al) + cg * al)
                            out[p + 2] = int(out[p + 2] * (1 - al) + cb * al)
            x += im.w * scale + pad
        top += rh
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(core.png_bytes(W, H, bytes(out)))
    return path
