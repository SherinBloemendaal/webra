#!/usr/bin/env python3
"""Generate WebRA's built-in 3D minimal texture pack: apps/game/packs/minimal3d*.webrapack.

    python3 tools/gen_minimal3d/generate.py                 write the archives
    python3 tools/gen_minimal3d/generate.py --check         fail when the committed archives are out of date (CI)
    python3 tools/gen_minimal3d/generate.py --preview POWR 1TNK [--scale 4] [--out file.png]
                                                            draw models enlarged side by side (developer aid)
    python3 tools/gen_minimal3d/generate.py --coverage      list rules actors that have no art yet

The look and the rules of the models are in core.py; one models_*.py file per category declares the actors.
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import core  # noqa: E402
import pack  # noqa: E402
import preview  # noqa: E402


def preview_models(ids, scale, out):
    actors, specials, aliases = pack.collect()
    images = []
    for i in ids:
        spec = actors.get(i) or actors.get(aliases.get(i)) or specials.get(i)
        if spec is None:
            raise SystemExit(f'no spec for {i}')
        for spr in spec.sprites():
            if spr.hidden or (spr.pose != 'idle' and not os.environ.get('ALLPOSES')):
                continue
            sh = spr.sheet
            fw, fh = sh['frame']
            # Show the first frame of a few rows (north, east, south, west for a turning sprite).
            rows = sorted({0, spr.facings // 4, spr.facings // 2, 3 * spr.facings // 4}) if spr.facings > 1 else [0]
            for r in rows:
                im = core.Image(0, 0, fw, fh)
                for y in range(fh):
                    s = ((r * fh + y) * sh['width']) * 4
                    im.rgba[y * fw * 4:(y + 1) * fw * 4] = sh['rgba'][s:s + fw * 4]
                    im.team[y * fw:(y + 1) * fw] = sh['team'][(r * fh + y) * sh['width']:(r * fh + y) * sh['width'] + fw]
                images.append(im)
            if spr.pose == 'idle' and spr.part == 'body' and hasattr(spec, 'cameo'):
                pass
    preview.montage(images, scale, path=out)
    print('wrote', out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--coverage', action='store_true')
    ap.add_argument('--preview', nargs='+', metavar='ID')
    ap.add_argument('--scale', type=int, default=4)
    ap.add_argument('--out', default='preview.png')
    ap.add_argument('--only', nargs='+', metavar='ID', help='render only these actors (no archives are written)')
    args = ap.parse_args()
    if args.preview:
        return preview_models(args.preview, args.scale, args.out)
    if args.coverage:
        actors, specials, aliases = pack.collect()
        missing, unknown, bad = pack.coverage(actors, aliases, specials)
        print(f'{len(actors)} actors and {len(aliases)} aliases declared; {len(missing)} without art')
        print('missing:', ' '.join(missing))
        print('unknown:', ' '.join(unknown))
        print('bad aliases:', ' '.join(bad))
        return 1 if missing or unknown or bad else 0
    archives = pack.build(args.only)
    if args.only:
        print(f'rendered {len(args.only)} actors ok (nothing written)')
        return 0
    if args.check:
        problems = pack.check(archives)
        if problems:
            print('the committed 3D minimal pack is out of date:')
            for p in problems[:40]:
                print('  ' + p)
            if len(problems) > 40:
                print(f'  ... and {len(problems) - 40} more')
            return 1
        print('3D minimal pack is up to date')
        return 0
    pack.write(archives)
    return 0


if __name__ == '__main__':
    sys.exit(main())
