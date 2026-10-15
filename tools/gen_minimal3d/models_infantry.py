"""Infantry: soldiers, civilians, technicians and the dog.

One skeleton (`soldier`, `lying`, `fall`) is dressed by a `Look` (clothes, hat, weapon, back pack) for every foot
soldier. E1 carries every pose the engine knows (body idle, move, attack, stand2, idle1, idle2, die1..die6, crushed;
prone idle, move, attack). The others carry the required poses only (idle, move, attack, die1..die6, crushed and, for
soldiers that take cover, prone idle, move, attack) to keep the atlas small. 8 facings; deaths have one. Pixels, nose
towards +y, origin on the ground. The dog has its own four-legged skeleton."""

from core import Unit, dsin, dcos
from specs import InfantrySpec, Pose




class Look:
    """Clothes and gear of one person. Colours are palette names, '#rrggbb' or 'T' (team).
    hat_kind: helmet, cap, hat, hardhat, hair, ponytail, hood or none. gun: rifle, grenade, rocket, flame, pistols,
    pistol, kit, wrench, tesla, toolbox, none. back: tank, coil, sack, bag or None. skirt: a skirt or dress colour (the
    legs are short and show `pants`). coat: a long coat colour. tie: a tie colour. long_hair: hair down the back."""

    def __init__(self, shirt='T', pants='olive', skin='skin', hat='olive', hat_kind='helmet', gun='rifle', gun_c='darker',
                 skirt=None, coat=None, tie=None, back=None, back_c='rust', cross=False, glasses=False, long_hair=False):
        self.shirt, self.pants, self.skin, self.hat, self.hat_kind, self.gun, self.gun_c = shirt, pants, skin, hat, hat_kind, gun, gun_c
        self.skirt, self.coat, self.tie, self.back, self.back_c = skirt, coat, tie, back, back_c
        self.cross, self.glasses, self.long_hair = cross, glasses, long_hair


E1_LOOK = Look()


def put_hat(u, look, cx, cy, zt, tilt=0.0):
    """Hat, hair, hood, face details on a 3 x 3 head centred (cx, cy) whose top is at height zt."""
    k, c, b = look.hat_kind, look.hat, zt - 0.6
    if k == 'helmet':
        u.box(cx - 2, cy - 2, 4, 4, 1.6, c, b)
    elif k == 'cap':
        u.box(cx - 1.8, cy - 1.8, 3.6, 3.6, 1.2, c, b)
        u.box(cx - 1.8, cy + 1.8, 3.6, 1.4, 0.4, c, b)
    elif k == 'hat':
        u.box(cx - 2.8, cy - 2.8, 5.6, 5.6, 0.5, c, b)
        u.box(cx - 1.7, cy - 1.7, 3.4, 3.4, 1.4, c, b + 0.5)
    elif k == 'hardhat':
        u.box(cx - 2, cy - 2, 4, 4, 1.2, c, b)
        u.box(cx - 0.6, cy - 2, 1.2, 4, 0.7, c, b + 1.2)
    elif k in ('hair', 'ponytail'):
        u.box(cx - 1.7, cy - 1.7, 3.4, 3.4, 1.1, c, b + 0.1)
        if k == 'ponytail':
            u.box(cx - 0.5, cy - 3.1, 1, 1.6, 2.6, c, max(0.0, zt - 3.4))
    elif k == 'hood':
        u.box(cx - 1.8, cy - 1.8, 3.6, 3.6, 3.0, c, zt - 2.6)
        u.box(cx - 1.2, cy + 1.8, 2.4, 0.2, 0.7, look.skin, zt - 1.4)
    if look.long_hair:
        z0 = max(0.0, zt - 3.0)
        u.box(cx - 1.8, cy - 2.2, 3.6, 1.0, zt + 0.2 - z0, look.hat, z0)
    if look.cross:
        u.box(cx - 0.3, cy + 2.0, 0.6, 0.2, 1.2, 'red', b + 0.2)
        u.box(cx - 0.6, cy + 2.0, 1.2, 0.2, 0.5, 'red', b + 0.55)
        u.box(cx - 0.3, cy - 0.6, 0.6, 1.2, 0.2, 'red', b + 1.6)
        u.box(cx - 0.6, cy - 0.3, 1.2, 0.6, 0.2, 'red', b + 1.6)
    if look.glasses:
        u.box(cx - 1.4, cy + 1.5, 2.8, 0.25, 0.7, 'black', zt - 1.6)


def back_pack(u, look):
    """The pack on a standing soldier's back (towards -y)."""
    k, c = look.back, look.back_c
    if k == 'tank':
        for x in (-2.2, 0.2):
            u.box(x, -4.2, 2.0, 2.4, 5.4, c, 3.8)
            u.box(x + 0.5, -3.7, 1.0, 1.4, 0.8, 'steel2', 9.2)
    elif k == 'coil':
        u.box(-2.2, -4.6, 4.4, 3.0, 4.8, 'dark', 4.2)
        u.cyl(0, -3.1, 1.2, 2.0, 'steel2', 9.0)
        u.box(-0.7, -3.8, 1.4, 1.4, 1.4, 'ice', 11.0, emit=True)
    elif k == 'sack':
        u.box(-1.8, -4.6, 3.6, 3.0, 3.6, c, 3.6)
        u.box(-0.8, -4.0, 1.6, 1.6, 1.0, c, 7.2)
    elif k == 'bag':
        u.box(-1.8, -3.8, 3.6, 2.2, 3.2, c, 4.2)
        if look.cross:
            u.box(-0.3, -4.0, 0.6, 0.2, 1.8, 'red', 4.9)
            u.box(-0.9, -4.0, 1.8, 0.2, 0.6, 'red', 5.5)


def hand_gear(u, look, aim, flash, s, arm_up):
    """Arms and weapon of a standing person. `aim`: attacking; `flash`: the second beat of the attack."""
    g = look.gun
    sh, sk = look.shirt, look.skin
    sw = 1.6 * s
    two_fwd = aim and g in ('rifle', 'rocket', 'flame', 'pistols', 'tesla', 'kit')
    if two_fwd:
        z = 6.4
        u.box(-3.4, 0, 1.2, 4, 1.4, sk, z)
        u.box(2.2, 0, 1.2, 4, 1.4, sk, z)
    elif aim and g == 'pistol':
        u.box(-3.6, -1, 1.2, 2.6, 3.4, sh, 5.2)
        u.box(2.2, 0, 1.2, 4, 1.4, sk, 6.4)
    elif aim and g in ('grenade', 'wrench'):
        u.box(-3.6, -1, 1.2, 2.6, 3.4, sh, 5.2)
        if flash:
            u.box(2.2, 0, 1.2, 4, 1.4, sk, 6.0)
        else:
            u.box(2.4, -0.6, 1.2, 1.4, 3.8, sk, 6.0)
    else:
        u.box(-3.6, -1 - sw, 1.2, 2.6, 3.4, sh, 5.2)
        u.box(2.4, -1 + sw, 1.2, 2.6, 3.4, sh, 5.2)
    if g == 'rifle':
        z = 6.6 if aim else 4.6 + arm_up
        u.box(1.0, -2, 1, 8 if aim else 6, 1, look.gun_c, z)
        if aim and flash:
            u.box(0.8, 6.2, 1.4, 1.6, 1.4, 'glow', z - 0.2, emit=True)
            u.box(1.0, 7.8, 1, 1.2, 1, 'yellow', z, emit=True)
    elif g == 'rocket':
        if aim:
            u.tube((1.9, -4, 7.8), (1.9, 5, 7.8), 1.2, look.gun_c)
            u.tube((1.9, 5, 7.8), (1.9, 6.4, 7.8), 1.0, 'red')
            if flash:
                u.box(1.1, -8.2, 1.6, 3.6, 1.6, 'glow', 7.0, emit=True)
                u.box(1.3, -10, 1.2, 2, 1.2, 'molten', 7.2, emit=True)
        else:
            u.tube((2.8, -2.4, 5.0 + arm_up), (2.8, 4.4, 6.8 + arm_up), 1.1, look.gun_c)
            u.tube((2.8, 4.4, 6.8 + arm_up), (2.8, 5.6, 7.0 + arm_up), 0.9, 'red')
    elif g == 'flame':
        z = 6.0 if aim else 4.8
        u.box(1.0, -1, 1.2, 7 if aim else 5, 1.2, 'steel', z)
        u.box(1.0, 6 if aim else 4, 1.2, 1.0, 1.2, 'orange', z)
        if aim:
            n = 1 if flash else 0
            u.box(0.6, 7, 2.0, 2.6 + 1.4 * n, 2.0, 'molten', z - 0.4, emit=True)
            u.box(0.8, 9.6 + 1.4 * n, 1.6, 2.2, 1.6, 'orange', z - 0.2, emit=True)
            u.box(1.0, 11.8 + 1.4 * n, 1.2, 1.6, 1.2, 'yellow', z, emit=True)
    elif g == 'pistols':
        if aim:
            for x in (-3.2, 2.2):
                u.box(x, 3.8, 1, 2.4, 1.1, 'darker', 6.2)
            if flash:
                u.box(-3.4, 6.0, 1.4, 1.4, 1.4, 'glow', 6.0, emit=True)
                u.box(2.0, 6.0, 1.4, 1.4, 1.4, 'glow', 6.0, emit=True)
        else:
            for x in (-3.6, 2.4):
                u.box(x, 0.2, 1.1, 2.2, 1.1, 'darker', 4.4)
    elif g == 'pistol':
        if aim:
            u.box(2.2, 3.8, 1, 2.4, 1.1, 'darker', 6.2)
            if flash:
                u.box(2.0, 6.0, 1.4, 1.4, 1.4, 'glow', 6.0, emit=True)
        else:
            u.box(2.4, 0.2, 1.1, 2.2, 1.1, 'darker', 4.4)
    elif g == 'grenade':
        if aim:
            if not flash:
                u.box(2.3, -0.5, 1.4, 1.4, 1.4, 'dark', 9.6)
            else:
                u.box(2.4, 4.0, 1.2, 1.2, 1.2, 'dark', 6.0)
        else:
            u.box(2.4, 0.4, 1.2, 1.2, 1.2, 'dark', 4.4)
        u.box(-2.8, 1.0, 1.8, 1.4, 1.4, 'canvas', 3.2)
    elif g == 'wrench':
        if aim and not flash:
            u.box(2.6, -0.2, 0.8, 0.8, 3.6, 'steel2', 9.0)
            u.box(2.2, -0.4, 1.6, 1.2, 0.9, 'steel2', 12.0)
        elif aim:
            u.box(2.6, 4.0, 0.8, 4.0, 0.8, 'steel2', 5.6)
            u.box(2.2, 8.0, 1.6, 1.0, 0.9, 'steel2', 5.5)
        else:
            u.box(2.6, 0.8, 0.8, 4.0, 0.8, 'steel2', 4.6)
            u.box(2.2, 4.8, 1.6, 1.0, 0.9, 'steel2', 4.5)
    elif g == 'kit':
        if aim:
            u.box(-0.4, 4.2, 0.8, 2.4, 0.8, 'steel2', 6.6)
            u.box(-0.7, 6.4, 1.4, 1.2, 1.4, 'green', 6.3, emit=True)
        u.box(-5.0 if aim else 2.6, 0.6, 2.0, 2.6, 2.0, 'paint', 3.0 if not aim else 4.8)
        u.box(-4.7 if aim else 3.5, 0.6, 0.6, 0.25, 1.4, 'red', 3.3 if not aim else 5.1)
    elif g == 'toolbox':
        u.box(2.6, 0.2, 1.6, 3.0, 2.0, 'red', 2.8 - 0.0)
        u.box(2.9, 0.8, 1.0, 1.8, 0.5, 'steel2', 4.8)
    elif g == 'tesla':
        if aim:
            u.box(1.0, 3.6, 1.2, 2.6, 1.2, 'steel2', 6.1)
            u.box(1.0, 6.2, 1.2, 1.2, 1.2, 'ice', 6.1, emit=True)
            if flash:
                zz = (6.2, 6.5, 6.0, 6.4)
                xs = (0.6, 1.8, 0.4, 1.4)
                for i in range(4):
                    u.box(xs[i], 7.6 + 2.0 * i, 1.0, 2.0, 1.0, 'ice' if i % 2 else 'ice2', zz[i], emit=True)
        else:
            u.box(2.4, 0.4, 1.2, 3.4, 1.2, 'steel2', 4.4)


def soldier(look, phase=0.0, aim=False, flash=False, arm_up=0.0, head_turn=0.0, hips=0.0):
    """A standing person: legs swing with `phase` (degrees), weapon out when `aim`, a flash on the second beat."""
    u = Unit()
    s = dsin(phase)
    lh = 2.8 if look.skirt else 4.2
    for side, sgn in ((-1, 1), (1, -1)):
        u.box(side * 1.3 - 0.9, -1 + 1.8 * s * sgn, 1.8, 2, lh, look.pants)
    if look.skirt:
        u.box(-2.8, -2, 5.6, 4, 2.2, look.skirt, 2.6)
    if look.coat:
        u.box(-2.9, -2.0, 5.8, 4, 3.8, look.coat, 1.8)
    u.box(-2.4, -1.5, 4.8, 3, 4.6, look.shirt, 4.2 + hips)
    if look.tie:
        u.box(-0.4, 1.5, 0.8, 0.2, 3.0, look.tie, 5.6)
    back_pack(u, look)
    hand_gear(u, look, aim, flash, s, arm_up)
    u.box(-1.5 + head_turn, -1.5, 3, 3, 2.6, look.skin, 8.8)
    put_hat(u, look, head_turn, 0.0, 11.4)
    return u


def lying(look, phase=0.0, aim=False, flash=False):
    """A person prone along the facing: legs behind, torso, head forward; arms crawl with `phase`."""
    u = Unit()
    s = dsin(phase)
    u.box(-1.8, -6, 1.5, 4, 1.4, look.pants)
    u.box(0.3, -6, 1.5, 4, 1.4, look.pants)
    u.box(-2.4, -2.5, 4.8, 5, 2, look.shirt, 0)
    u.box(-1.5, 2.2, 3, 2.8, 2.2, look.skin, 0)
    put_hat(u, look, 0.0, 3.6, 2.2)
    u.box(-3.6, 0.5 + 1.4 * s, 1.2, 3, 1.2, look.skin, 0.4)
    u.box(2.4, 0.5 - 1.4 * s, 1.2, 3, 1.2, look.skin, 0.4)
    g = look.gun
    if g == 'rifle':
        u.box(0.6, 1, 1, 8, 1, look.gun_c, 1.2)
        if flash:
            u.box(0.4, 9, 1.4, 1.8, 1.4, 'glow', 1.0, emit=True)
    elif g == 'rocket':
        u.tube((1.4, -2.5, 2.9), (1.4, 6.5, 2.9), 1.0, look.gun_c)
        u.tube((1.4, 6.5, 2.9), (1.4, 7.8, 2.9), 0.8, 'red')
        if flash:
            u.box(0.8, -6.0, 1.2, 3.4, 1.2, 'glow', 2.4, emit=True)
    elif g == 'flame':
        u.box(0.6, 1, 1, 6, 1, 'steel', 1.2)
        u.box(0.6, 7, 1, 0.8, 1, 'orange', 1.2)
        n = 3.0 if flash else 1.6
        u.box(0.4, 7.8, 1.4, n, 1.4, 'molten', 1.0, emit=True)
        u.box(0.6, 7.8 + n, 1.0, 1.4, 1.0, 'yellow', 1.2, emit=True)
    elif g == 'pistols':
        u.box(-3.4, 3.4, 1, 2.2, 1, 'darker', 0.6)
        u.box(2.4, 3.4, 1, 2.2, 1, 'darker', 0.6)
        if flash:
            u.box(-3.6, 5.6, 1.4, 1.4, 1.4, 'glow', 0.4, emit=True)
            u.box(2.2, 5.6, 1.4, 1.4, 1.4, 'glow', 0.4, emit=True)
    elif g == 'pistol':
        u.box(2.4, 3.4, 1, 2.2, 1, 'darker', 0.6)
        if flash:
            u.box(2.2, 5.6, 1.4, 1.4, 1.4, 'glow', 0.4, emit=True)
    elif g == 'grenade':
        u.box(2.4, 3.6, 1.2, 1.2, 1.2, 'dark', 0.6)
        if flash:
            u.box(2.4, 6.0, 1.2, 1.2, 1.2, 'dark', 1.0)
    elif g == 'wrench':
        u.box(2.6, 1.0, 0.8, 5.0, 0.8, 'steel2', 0.4)
        u.box(2.2, 6.0, 1.6, 1.0, 0.8, 'steel2', 0.4)
    elif g == 'kit':
        u.box(-1.6, -2.4, 3.2, 2.6, 1.6, 'paint', 2.0)
        u.box(-0.3, -2.4, 0.6, 2.2, 0.2, 'red', 3.6)
        u.box(-1.0, -1.7, 2.0, 0.8, 0.2, 'red', 3.6)
        if flash:
            u.box(-0.6, 5.4, 1.2, 1.2, 1.2, 'green', 0.4, emit=True)
    elif g == 'toolbox':
        u.box(-1.4, -2.2, 2.8, 2.6, 1.4, 'red', 2.0)
    elif g == 'tesla':
        u.box(0.6, 1, 1, 6, 1, 'steel2', 1.2)
        u.box(0.6, 7, 1, 1, 1, 'ice', 1.2, emit=True)
        if flash:
            for i in range(3):
                u.box((0.2, 1.2, 0.4)[i], 8 + 1.8 * i, 1, 1.8, 1, 'ice' if i % 2 else 'ice2', 1.0, emit=True)
    if look.back == 'tank':
        u.box(-1.9, -4, 1.6, 3.6, 1.6, look.back_c, 2.0)
        u.box(0.3, -4, 1.6, 3.6, 1.6, look.back_c, 2.0)
    elif look.back == 'coil':
        u.box(-1.9, -4.6, 3.8, 3, 1.8, 'dark', 2.0)
        u.box(-0.6, -3.8, 1.2, 1.2, 1.2, 'ice', 3.8, emit=True)
    elif look.back in ('sack', 'bag'):
        u.box(-1.6, -4.2, 3.2, 2.6, 1.6, look.back_c, 2.0)
    return u


def fall(look, t, kind):
    """Dying: t 0 (standing) to 1 (down). kind: 'shot' (falls back), 'blown' (flung, face down), 'burn' (charred, flames),
    'zap' (a white skeleton in blue sparks), 'crush' (flattened)."""
    u = Unit()
    if kind == 'crush':
        u.box(-3, -4, 6, 8, 0.8, look.coat or look.shirt, 0)
        u.box(-1.5, 3, 3, 2.4, 0.8, look.skin, 0)
        u.box(-3.4, -1, 1.2, 3, 0.5, 'red', 0, a=0.9)
        return u
    shirt = look.coat or look.shirt
    skin = look.skin
    pants = look.pants
    plain = kind in ('burn', 'zap')
    if kind == 'burn':
        shirt = skin = pants = '#2a2622'
    if kind == 'zap':
        shirt = skin = pants = 'paint'
    lift = 5 * dsin(180.0 * min(1.0, t * 1.6)) if kind == 'blown' else 0
    tt = min(1.0, t * 1.4)
    th = 4.6 * (1 - tt) + 2 * tt
    u.box(-2.4, -1.5 - 3 * tt, 4.8, 3 + 2 * tt, th, shirt, 4.2 * (1 - tt) + 0 * tt + lift)
    u.box(-2.3, -1.5 - 8 * tt if tt > 0.3 else -1, 1.8, 2 + 3 * tt, 4.2 * (1 - tt) + 1.4 * tt, pants, lift)
    u.box(0.5, -1.5 - 8 * tt if tt > 0.3 else -1, 1.8, 2 + 3 * tt, 4.2 * (1 - tt) + 1.4 * tt, pants, lift)
    hy = -1.5 - 3 * tt + (6.5 * tt if kind != 'blown' else -4 * tt)
    hh = 2.6 * (1 - tt) + 2.2 * tt
    hz = 8.8 * (1 - tt) + lift
    u.box(-1.5, hy, 3, 3, hh, skin, hz)
    if not plain and look.hat_kind != 'none':
        # The hat goes down with the head (hoods, hair and helmets alike).
        flat = Look(hat=look.hat, hat_kind=look.hat_kind if look.hat_kind != 'ponytail' else 'hair', skin=look.skin,
                    cross=look.cross)
        put_hat(u, flat, 0.0, hy + 1.5, hz + hh)
    u.box(-3.8 - 2 * tt, -2 + 3 * tt, 1.2, 3, 1.2 + 2 * (1 - tt), skin, 5.2 * (1 - tt) + lift)
    u.box(2.6 + 2 * tt, -2 + 3 * tt, 1.2, 3, 1.2 + 2 * (1 - tt), skin, 5.2 * (1 - tt) + lift)
    if look.skirt and not plain:
        u.box(-2.8, -2 - 3 * tt, 5.6, 4, 1.4 + 0.8 * (1 - tt), look.skirt, 2.6 * (1 - tt) + 0.6 * tt + lift)
    if kind == 'burn':
        flick = int(t * 12) % 2
        u.box(-1.5, -1, 3, 3, 4 + 2 * flick, 'molten', 5, a=0.9, emit=True)
        u.box(-0.8, -0.4, 1.8, 1.8, 3 + 2 * (1 - flick), 'glow', 7, a=0.9, emit=True)
    if kind == 'zap':
        for i, off in enumerate((-3, 3)):
            u.bolt(off, 0, 3, [(0, 0), (1.2 * (i + int(t * 8) % 2), 2.5), (-1.2, 5), (1, 8)], 0.35, 'ice', emit=True)
    if kind == 'shot' and t > 0.6:
        u.box(0.5, -5, 2.2, 1.6, 0.4, 'red', 0, a=0.8)
    return u


# ---- The dog ---------------------------------------------------------------------------------------

DOG_MAIN, DOG_LIGHT, DOG_DARK = '#8b5e34', '#a67c48', '#4e341c'


def dog(phase=0.0, lunge=0.0, crouch=0.0, jaw=False):
    """A four-legged box dog facing +y: diagonal legs swing with `phase`; `lunge` throws it forward, `jaw` opens its mouth."""
    u = Unit()
    s = dsin(phase)
    for x, y, sg in ((-1.9, 2.8, 1), (0.7, 2.8, -1), (-1.9, -4.6, -1), (0.7, -4.6, 1)):
        u.box(x, y + 1.6 * s * sg + lunge, 1.2, 1.4, 3.0 - crouch, DOG_DARK)
    u.box(-1.8, -5.4 + lunge, 3.6, 9.0, 3.4, DOG_MAIN, 2.6 - crouch)
    u.box(-1.9, 2.2 + lunge, 3.8, 1.0, 3.7, 'T', 3.2 - crouch)
    hz = 4.2 - crouch
    u.box(-1.5, 3.2 + lunge, 3, 3, 3, DOG_LIGHT, hz)
    if jaw:
        u.box(-0.8, 6.0 + lunge, 1.6, 2.2, 0.9, DOG_LIGHT, hz + 1.5)
        u.box(-0.8, 6.0 + lunge, 1.6, 2.0, 0.7, DOG_LIGHT, hz - 0.2)
        u.box(-0.6, 6.0 + lunge, 1.2, 1.6, 0.6, 'red', hz + 0.5)
    else:
        u.box(-0.8, 6.0 + lunge, 1.6, 2.2, 1.3, DOG_LIGHT, hz + 0.3)
    u.box(-0.4, 8.0 + lunge, 0.8, 0.4, 0.6, 'black', hz + 1.2)
    u.box(-1.8, 3.4 + lunge, 0.8, 1.0, 1.2, DOG_DARK, hz + 3.0)
    u.box(1.0, 3.4 + lunge, 0.8, 1.0, 1.2, DOG_DARK, hz + 3.0)
    u.box(-0.5, -7.2 + lunge, 1.0, 2.0, 1.0, DOG_MAIN, 5.4 - crouch)
    u.box(-0.5, -8.0 + lunge, 1.0, 1.0, 1.0, DOG_MAIN, 6.4 - crouch)
    return u


def dog_fall(t, kind):
    """The dog going down on its side. Kinds as in `fall`."""
    u = Unit()
    if kind == 'crush':
        u.box(-3.4, -5, 6.8, 10, 0.8, DOG_MAIN, 0)
        u.box(-1.5, 4.6, 3, 2.4, 0.8, DOG_LIGHT, 0)
        u.box(-3.4, -1, 1.2, 3, 0.5, 'red', 0, a=0.9)
        return u
    main, light, dark = DOG_MAIN, DOG_LIGHT, DOG_DARK
    if kind == 'burn':
        main = light = dark = '#2a2622'
    if kind == 'zap':
        main = light = dark = 'paint'
    lift = 4 * dsin(180.0 * min(1.0, t * 1.6)) if kind == 'blown' else 0
    tt = min(1.0, t * 1.4)
    u.box(-1.8 - 0.8 * tt, -5.4, 3.6 + 1.6 * tt, 9, 3.4 * (1 - tt) + 2.4 * tt, main, 2.6 * (1 - tt) + lift)
    for x, y in ((-1.9, 2.8), (0.7, 2.8), (-1.9, -4.6), (0.7, -4.6)):
        u.box(x + (2.0 * tt if x > 0 else -2.0 * tt), y, 1.2 + 1.6 * tt, 1.4, 3.0 * (1 - tt) + 1.0 * tt, dark, lift)
    u.box(-1.5, 3.2 + 1.0 * tt, 3, 3, 3 * (1 - tt) + 2.2 * tt, light, 4.2 * (1 - tt) + lift)
    u.box(-0.8, 6.0 + 1.0 * tt, 1.6, 2.2, 1.3 * (1 - tt) + 1.0 * tt, light, 4.5 * (1 - tt) + lift)
    u.box(-0.5, -8.0, 1.0, 2.8, 1.0, main, 0.6 + lift)
    if kind == 'burn':
        flick = int(t * 12) % 2
        u.box(-1.8, -3, 3.6, 5, 3 + 2 * flick, 'molten', 3, a=0.9, emit=True)
        u.box(-1.0, -1.5, 2.0, 2.4, 3 + 2 * (1 - flick), 'glow', 5, a=0.9, emit=True)
    if kind == 'zap':
        for i, off in enumerate((-3, 3)):
            u.bolt(off, 0, 2, [(0, 0), (1.2 * (i + int(t * 8) % 2), 2.5), (-1.2, 5), (1, 7)], 0.35, 'ice', emit=True)
    if kind == 'shot' and t > 0.6:
        u.box(0.5, -6, 2.2, 1.6, 0.4, 'red', 0, a=0.8)
    return u


# ---- Poses -----------------------------------------------------------------------------------------


def body_poses(look, full=False, armed=True):
    """Every body pose of a person. `full`: also the stand2, idle1 and idle2 flourishes (E1 only: they cost many frames).
    `armed` False: attack is the idle pose."""
    poses = {
        'idle': Pose(lambda k: soldier(look), 1, 0),
        'move': Pose(lambda k: soldier(look, phase=k * 60.0), 6, 10),
        'attack': (Pose(lambda k: soldier(look, aim=True, flash=bool(k % 2)), 2, 12) if armed else
                   Pose(lambda k: soldier(look), 1, 0)),
    }
    if full:
        poses.update({
            'stand2': Pose(lambda k: soldier(look, hips=0.0, arm_up=0.4), 1, 0),
            'idle1': Pose(lambda k: soldier(look, head_turn=(1, 0, -1, 0)[k % 4] * 0.8), 8, 6),
            'idle2': Pose(lambda k: soldier(look, arm_up=0.6 * dsin(k * 45.0)), 8, 6),
        })
    poses.update(death_poses(lambda t, kind: fall(look, t, kind)))
    return poses


def death_poses(fn):
    return {
        'die1': Pose(lambda k: fn(k / 5, 'shot'), 6, 8, facings=1),
        'die2': Pose(lambda k: fn(k / 5, 'shot'), 6, 8, facings=1),
        'die3': Pose(lambda k: fn(k / 5, 'blown'), 6, 10, facings=1),
        'die4': Pose(lambda k: fn(k / 5, 'blown'), 6, 10, facings=1),
        'die5': Pose(lambda k: fn(k / 5, 'burn'), 6, 8, facings=1),
        'die6': Pose(lambda k: fn(k / 3, 'zap'), 4, 10, facings=1),
        'crushed': Pose(lambda k: fn(1.0, 'crush'), 1, 0, facings=1),
    }


def prone_poses(look, armed=True):
    return {
        'idle': Pose(lambda k: lying(look), 1, 0),
        'move': Pose(lambda k: lying(look, phase=k * 60.0), 6, 8),
        'attack': (Pose(lambda k: lying(look, flash=bool(k % 2)), 2, 12) if armed else Pose(lambda k: lying(look), 1, 0)),
    }


def person(look, prone=True, armed=True, full=False):
    return InfantrySpec(body_poses(look, full, armed), prone_poses(look, armed) if prone else None)


def dog_poses():
    poses = {
        'idle': Pose(lambda k: dog(), 1, 0),
        'move': Pose(lambda k: dog(phase=k * 60.0), 6, 12),
        'attack': Pose(lambda k: dog(lunge=2.6, jaw=True, phase=0) if k % 2 else dog(crouch=0.8), 2, 8),
    }
    poses.update(death_poses(dog_fall))
    return poses


# ---- Looks ---------------------------------------------------------------------------------------------

HAIR_BROWN, HAIR_BLACK, HAIR_BLOND, HAIR_RED, HAIR_GREY = '#4a2a16', '#1a1a1a', '#e8c860', '#b0481e', '#bdb7a6'

LOOKS = {
    'E2': Look(gun='grenade', gun_c='dark'),
    'E3': Look(gun='rocket', gun_c='dark'),
    'E4': Look(gun='flame', hat='#4a4a40', hat_kind='hood', back='tank', back_c='rust', pants='#4a4a40'),
    'E6': Look(hat='yellow', hat_kind='hardhat', gun='toolbox', pants='#6b6f55'),
    'E7': Look(hat=HAIR_BROWN, hat_kind='ponytail', gun='pistols', pants='#3a4a2a'),
    'MEDI': Look(hat='paint', cross=True, gun='kit', back='bag', back_c='paint', pants='#6b6f55'),
    'MECH': Look(hat='T', hat_kind='cap', gun='wrench', pants='#4a5560'),
    'SPY': Look(shirt='#2a2a32', pants='#2a2a32', hat='#1e1e24', hat_kind='hat', gun='pistol', tie='T'),
    'THF': Look(hat='black', hat_kind='hood', gun='none', back='sack', back_c='sandy', pants='darker'),
    'SHOK': Look(hat='dark', hat_kind='helmet', gun='tesla', back='coil', pants='darker'),
    # Civilians: no rank colour, so every shirt is a real colour.
    'C1': Look(shirt='#d9d4c4', pants='#7a5a3a', hat=HAIR_BROWN, hat_kind='hair', gun='pistol'),
    'C2': Look(shirt='red', pants='skin', skirt='#4a3a5a', hat=HAIR_BLOND, hat_kind='hair', long_hair=True, gun='none'),
    'C3': Look(shirt='#2e3a4e', pants='#2e3a4e', hat='#2e2e36', hat_kind='hat', tie='red', gun='none'),
    'C4': Look(shirt='paint', pants='skin', skirt='#3a6ea5', hat=HAIR_BLACK, hat_kind='hair', long_hair=True, gun='none'),
    'C5': Look(shirt='brick', pants='#4a5f8a', hat='sand', hat_kind='hat', gun='none'),
    'C6': Look(shirt='green', pants='skin', skirt='green', hat=HAIR_BROWN, hat_kind='hair', long_hair=True, gun='none'),
    'C7': Look(shirt='#8a2a2a', pants='#2e3238', hat='#2e3238', hat_kind='cap', gun='pistol'),
    'C8': Look(shirt='yellow', pants='#3a6ea5', hat='sandy', hat_kind='hat', gun='none'),
    'C9': Look(shirt='orange', pants='skin', skirt='#c9ad6a', hat=HAIR_RED, hat_kind='hair', long_hair=True, gun='none'),
    'C10': Look(shirt='paint', pants='#4a5560', coat='paint', hat=HAIR_GREY, hat_kind='hair', glasses=True, gun='none'),
    'C11': Look(shirt='#5a7a3a', pants='#4a4743', hat=HAIR_GREY, hat_kind='cap', gun='none'),
    'TECN': Look(shirt='#4a74a8', pants='#4a74a8', hat='paint', hat_kind='hardhat', gun='pistol'),
    'TECN2': Look(shirt='orange', pants='orange', hat='#4a4743', hat_kind='cap', gun='pistol'),
}

ARMED_CIVS = ('C1', 'C7', 'TECN', 'TECN2')
NO_PRONE = ('THF', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'TECN', 'TECN2')
UNARMED = ('E6', 'THF', 'C2', 'C3', 'C4', 'C5', 'C6', 'C8', 'C9', 'C10', 'C11')

ACTORS = {'E1': person(E1_LOOK, full=True)}
for _id, _look in LOOKS.items():
    ACTORS[_id] = person(_look, prone=_id not in NO_PRONE, armed=_id not in UNARMED)
ACTORS['DOG'] = InfantrySpec(dog_poses())

# The mission variants carry the same weapons as their base soldiers in the rules: they share the art.
ALIASES = {'E1R1': 'E1', 'E3R1': 'E3', 'SPY.England': 'SPY'}
