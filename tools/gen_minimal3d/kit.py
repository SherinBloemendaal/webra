"""Shared helpers for the models files: gun barrels. All in pixels, x right, y forward, z up (core.Unit). Add your
own helpers in your own models file."""


def barrel(u, x, y0, y1, z, r=1.0, c='dark', tip='darker', pitch=0.0):
    """A gun barrel along the facing from y0 to y1 at (x, z), raised `pitch` px at the far end, with a darker muzzle."""
    u.tube((x, y0, z), (x, y1, z + pitch), r, c)
    u.tube((x, y1 - 1.5, z + pitch * (y1 - 1.5 - y0) / max(1e-6, y1 - y0)), (x, y1 + 0.3, z + pitch), r * 1.3, tip)
