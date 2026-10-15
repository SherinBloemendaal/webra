"""Shared helpers for the models files (units mostly): tracks, wheels, barrels. All in pixels, x right,
y forward, z up (core.Unit). Add your own helpers in your own models file."""


def tracks(u, x_in, x_out, y0, y1, h, c='darker', cap='dark'):
    """Two caterpillar tracks: boxes between x_in and x_out (mirrored), from y0 to y1, h high, with a lighter top plate."""
    for sgn in (-1, 1):
        xa, xb = sorted((sgn * x_in, sgn * x_out))
        u.box(xa, y0, xb - xa, y1 - y0, h, c)
        u.box(xa + 0.5, y0 + 0.5, xb - xa - 1, y1 - y0 - 1, 0.8, cap, h)


def wheel(u, x, y, r, width, c='darker', hub='steel2', z=None, n=8):
    """A wheel with its axle along x, centre (x, y), radius r, standing on the ground (or at height z), `width` thick."""
    zc = r if z is None else z
    u.tube((x - width / 2, y, zc), (x + width / 2, y, zc), r, c, n)
    u.tube((x - width / 2 - 0.2, y, zc), (x + width / 2 + 0.2, y, zc), r * 0.45, hub, n)


def barrel(u, x, y0, y1, z, r=1.0, c='dark', tip='darker', pitch=0.0):
    """A gun barrel along the facing from y0 to y1 at (x, z), raised `pitch` px at the far end, with a darker muzzle."""
    u.tube((x, y0, z), (x, y1, z + pitch), r, c)
    u.tube((x, y1 - 1.5, z + pitch * (y1 - 1.5 - y0) / max(1e-6, y1 - y0)), (x, y1 + 0.3, z + pitch), r * 1.3, tip)
