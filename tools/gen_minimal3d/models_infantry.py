"""Infantry: soldiers, civilians, technicians and the dog.

Retexture of 0.21.0: a standing person is four or five blocks (legs, torso, head, hat, the weapon, at most one
pack), soldiers wear the team colour on the torso, and every person is as tall as the original soldier. One skeleton
(`soldier`, `lying`, `fall`) is dressed by a `Look` (clothes, hat, weapon, back pack) for every foot soldier.
E1 carries every pose the engine knows (body idle, move, attack, stand2, idle1, idle2, die1..die6, crushed;
prone idle, move, attack). The others carry the required poses only (idle, move, attack, die1..die6, crushed and, for
soldiers that take cover, prone idle, move, attack) to keep the atlas small. 8 facings; deaths have one. Pixels, nose
towards +y, origin on the ground. The dog has its own four-legged skeleton."""

from core import Unit, dsin
from specs import InfantrySpec, Pose




class Look:
    """Clothes and gear of one person. Colours are palette names, '#rrggbb' or 'T' (team).
    hat_kind: helmet, cap, hat, hardhat, hair, ponytail, hood or none. gun: rifle, grenade, rocket, flame, pistols,
    pistol, kit, wrench, tesla, toolbox, none. back: tank, coil or sack (the one pack drawn) or None. skirt: a skirt
    or dress colour (drawn as the legs). coat: a long coat colour (drawn as the torso)."""

    def __init__(self, shirt='T', pants='olive', skin='skin', hat='olive', hat_kind='helmet', gun='rifle', gun_c='darker',
                 skirt=None, coat=None, back=None, back_c='rust'):
        self.shirt, self.pants, self.skin, self.hat, self.hat_kind, self.gun, self.gun_c = shirt, pants, skin, hat, hat_kind, gun, gun_c
        self.skirt, self.coat, self.back, self.back_c = skirt, coat, back, back_c


E1_LOOK = Look()

# Heights of a standing person (px): legs, torso, head. As tall as the original soldier (decoration bounds 18 px
# on screen with the depth of the body).
LEG_H, BODY_H, HEAD_H = 5.6, 5.6, 3.4
HEAD_Z = LEG_H + BODY_H
TOP_Z = HEAD_Z + HEAD_H


def head(u, look, cx, cy, z, w=3.2):
    """The head and what is on it (2 shapes; 1 when the hood or helmet is the head)."""
    k, c = look.hat_kind, look.hat
    if k in ('hood', 'helmet') and look.gun in ('flame', 'tesla', 'none'):
        u.box(cx - w / 2 - 0.2, cy - w / 2, w + 0.4, w, HEAD_H + 0.6, c, z)
        return
    u.box(cx - w / 2, cy - w / 2, w, w, HEAD_H, look.skin, z)
    if k == 'none':
        return
    if k == 'hat':
        u.box(cx - w / 2 - 0.8, cy - w / 2 - 0.8, w + 1.6, w + 1.6, 1.0, c, z + HEAD_H - 0.4)
    elif k == 'cap':
        u.box(cx - w / 2, cy - w / 2, w, w + 1.0, 0.9, c, z + HEAD_H - 0.4)
    elif k in ('hair', 'ponytail'):
        u.box(cx - w / 2, cy - w / 2 - 0.2, w, w * 0.7, HEAD_H * 0.5 + 0.8, c, z + HEAD_H * 0.5)
    else:  # helmet, hardhat, hood
        u.box(cx - w / 2 - 0.3, cy - w / 2 - 0.3, w + 0.6, w + 0.6, 1.3, c, z + HEAD_H - 0.6)


def back_pack(u, look, lying=False):
    """The one pack a soldier carries on the back (towards -y): the flame tank, the coil, the sack (1 shape)."""
    k = look.back
    if k not in ('tank', 'coil', 'sack'):
        return
    c = {'tank': look.back_c, 'coil': 'ice', 'sack': look.back_c}[k]
    if lying:
        u.box(-1.8, -4.6, 3.6, 2.6, 2.0, c, 1.8)
    else:
        u.box(-1.8, -3.8, 3.6, 1.8, 4.6, c, LEG_H + 0.6)


def weapon(u, look, aim, flash, z, y0=0.4):
    """The weapon held in front of the body (1 shape), and when it fires, its flash (translucent or glowing)."""
    g = look.gun
    if g == 'none':
        return
    c = {'rifle': look.gun_c, 'grenade': 'dark', 'rocket': look.gun_c, 'flame': 'steel', 'pistols': 'darker',
         'pistol': 'darker', 'kit': 'paint', 'wrench': 'steel2', 'toolbox': 'red', 'tesla': 'steel2'}[g]
    if g == 'toolbox' or (g == 'kit' and not aim):
        u.box(1.8, -0.6, 1.8, 2.4, 2.0, c, LEG_H - 1.6)
        return
    length = 4.0 if g in ('rifle', 'rocket', 'flame', 'tesla') else 2.6
    w = 1.6 if g in ('rocket', 'kit') else 1.0
    lift = 0.0 if aim else -1.2
    u.box(1.0, y0, w, length, w, c, z + lift)
    if aim and flash:
        fc = {'flame': 'molten', 'tesla': 'ice', 'kit': 'green'}.get(g, 'glow')
        u.box(0.6, y0 + length, w + 0.8, 1.6, w + 0.8, fc, z - 0.4, emit=True)


def soldier(look, phase=0.0, aim=False, flash=False, arm_up=0.0, head_turn=0.0, hips=0.0):
    """A standing person: legs, torso (the team colour on soldiers), head and hat, the weapon and maybe a pack. The
    legs stride with `phase` (degrees); the weapon comes up when `aim`, with a flash on the second beat."""
    u = Unit()
    stride = 1.6 * abs(dsin(phase))
    legs = look.skirt or look.pants
    u.box(-1.9, -1.0 - stride, 3.8, 2.0 + 2 * stride, LEG_H, legs)
    u.box(-2.7, -1.5, 5.4, 3.0, BODY_H + hips, look.coat or look.shirt, LEG_H)
    back_pack(u, look)
    weapon(u, look, aim, flash, LEG_H + BODY_H * 0.55 + arm_up)
    head(u, look, head_turn, 0.0, HEAD_Z + hips)
    return u


def lying(look, phase=0.0, aim=False, flash=False):
    """A person prone along the facing: legs behind, torso, head forward, the weapon ahead; arms crawl with `phase`."""
    u = Unit()
    s = dsin(phase)
    u.box(-1.8, -6.5 + s, 3.6, 4.0, 1.6, look.pants)
    u.box(-2.4, -2.5, 4.8, 5.0, 2.2, look.shirt)
    u.box(-1.6, 2.5, 3.2, 3.0, 2.4, look.hat if look.hat_kind in ('helmet', 'hood', 'hardhat') else look.skin)
    back_pack(u, look, lying=True)
    weapon(u, look, True, flash, 0.8, 5.5)
    return u


def fall(look, t, kind):
    """Dying: t 0 (standing) to 1 (down). kind: 'shot' (falls back), 'blown' (flung, face down), 'burn' (charred, flames),
    'zap' (white in blue sparks), 'crush' (flattened). Three blocks: legs, torso, head."""
    u = Unit()
    if kind == 'crush':
        u.box(-3, -4, 6, 8, 0.8, look.coat or look.shirt, 0)
        u.box(-3.4, -1, 1.2, 3, 0.5, 'red', 0, a=0.9)
        return u
    shirt, skin, pants = look.coat or look.shirt, look.skin, look.skirt or look.pants
    if kind == 'burn':
        shirt = skin = pants = '#2a2622'
    if kind == 'zap':
        shirt = skin = pants = 'paint'
    lift = 5 * dsin(180.0 * min(1.0, t * 1.6)) if kind == 'blown' else 0
    tt = min(1.0, t * 1.4)
    back = -1 if kind == 'blown' else 1
    u.box(-1.9, -1.0 - 6 * tt * back if back > 0 else -1.0, 3.8, 2 + 4 * tt, LEG_H * (1 - tt) + 1.6 * tt, pants, lift)
    u.box(-2.4, -1.5 - 3 * tt * back, 4.8, 3 + 2 * tt, BODY_H * (1 - tt) + 2 * tt, shirt, LEG_H * (1 - tt) + lift)
    hy = -1.6 + (5.5 * tt if kind == 'blown' else -5.5 * tt)
    u.box(-1.6, hy, 3.2, 3.2, HEAD_H * (1 - tt) + 2.2 * tt, skin, HEAD_Z * (1 - tt) + lift)
    if kind == 'burn':
        flick = int(t * 12) % 2
        u.box(-1.5, -1, 3, 3, 4 + 2 * flick, 'molten', 5 * (1 - tt) + 1, a=0.9, emit=True)
    if kind == 'zap':
        u.bolt(0, 0, 3, [(-3, 0), (1.2 * (int(t * 8) % 2), 2.5), (-1.2, 5), (2, 8)], 0.35, 'ice', emit=True)
    if kind == 'shot' and t > 0.6:
        u.box(0.5, -5, 2.2, 1.6, 0.4, 'red', 0, a=0.8)
    return u


# ---- The dog ---------------------------------------------------------------------------------------

DOG_MAIN, DOG_LIGHT, DOG_DARK = '#8b5e34', '#a67c48', '#4e341c'


def dog(phase=0.0, lunge=0.0, crouch=0.0, jaw=False):
    """A blocky dog facing +y: legs (one block that strides with `phase`), the body with its team collar, the head;
    `lunge` throws it forward, `jaw` opens its mouth."""
    u = Unit()
    stride = 1.2 * abs(dsin(phase))
    u.box(-1.6, -3.2 - stride + lunge, 3.2, 6.2 + 2 * stride, 4.2 - crouch, DOG_DARK)
    u.box(-1.9, -4.0 + lunge, 3.8, 7.0, 3.6, DOG_MAIN, 4.2 - crouch)
    u.box(-2.0, 1.6 + lunge, 4.0, 1.2, 3.9, 'T', 4.1 - crouch)
    u.box(-1.5, 2.4 + lunge, 3.0, 3.4 + (0.8 if jaw else 0.0), 3.6, DOG_LIGHT, 6.6 - crouch)
    return u


def dog_fall(t, kind):
    """The dog going down on its side: legs, body, head (3 blocks). Kinds as in `fall`."""
    u = Unit()
    if kind == 'crush':
        u.box(-3.0, -4.4, 6.0, 9.0, 0.8, DOG_MAIN, 0)
        u.box(-3.0, -1, 1.2, 3, 0.5, 'red', 0, a=0.9)
        return u
    main, light, dark = DOG_MAIN, DOG_LIGHT, DOG_DARK
    if kind == 'burn':
        main = light = dark = '#2a2622'
    if kind == 'zap':
        main = light = dark = 'paint'
    lift = 4 * dsin(180.0 * min(1.0, t * 1.6)) if kind == 'blown' else 0
    tt = min(1.0, t * 1.4)
    u.box(-1.6 + 2.6 * tt, -3.6, 3.2, 7.0, 4.2 * (1 - tt) + 1.2 * tt, dark, lift)
    u.box(-1.9 - 0.6 * tt, -4.4, 3.8 + 1.2 * tt, 8.0, 3.6 * (1 - tt) + 2.6 * tt, main, 4.2 * (1 - tt) + lift)
    u.box(-1.5, 2.8 + tt, 3.0, 3.8, 3.6 * (1 - tt) + 2.2 * tt, light, 6.6 * (1 - tt) + lift)
    if kind == 'burn':
        flick = int(t * 12) % 2
        u.box(-1.8, -3, 3.6, 5, 3 + 2 * flick, 'molten', 3, a=0.9, emit=True)
    if kind == 'zap':
        u.bolt(0, 0, 2, [(-3, 0), (1.2 * (int(t * 8) % 2), 2.5), (-1.2, 5), (2, 7)], 0.35, 'ice', emit=True)
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
    'MEDI': Look(hat='paint', gun='kit', pants='#6b6f55'),
    'MECH': Look(hat='T', hat_kind='cap', gun='wrench', pants='#4a5560'),
    'SPY': Look(shirt='#2a2a32', pants='#2a2a32', hat='#1e1e24', hat_kind='hat', gun='pistol'),
    'THF': Look(hat='black', hat_kind='hood', gun='none', back='sack', back_c='sandy', pants='darker'),
    'SHOK': Look(hat='dark', hat_kind='helmet', gun='tesla', back='coil', pants='darker'),
    # Civilians: no rank colour, so every shirt is a real colour.
    'C1': Look(shirt='#d9d4c4', pants='#7a5a3a', hat=HAIR_BROWN, hat_kind='hair', gun='pistol'),
    'C2': Look(shirt='red', pants='skin', skirt='#4a3a5a', hat=HAIR_BLOND, hat_kind='hair', gun='none'),
    'C3': Look(shirt='#2e3a4e', pants='#2e3a4e', hat='#2e2e36', hat_kind='hat', gun='none'),
    'C4': Look(shirt='paint', pants='skin', skirt='#3a6ea5', hat=HAIR_BLACK, hat_kind='hair', gun='none'),
    'C5': Look(shirt='brick', pants='#4a5f8a', hat='sand', hat_kind='hat', gun='none'),
    'C6': Look(shirt='green', pants='skin', skirt='green', hat=HAIR_BROWN, hat_kind='hair', gun='none'),
    'C7': Look(shirt='#8a2a2a', pants='#2e3238', hat='#2e3238', hat_kind='cap', gun='pistol'),
    'C8': Look(shirt='yellow', pants='#3a6ea5', hat='sandy', hat_kind='hat', gun='none'),
    'C9': Look(shirt='orange', pants='skin', skirt='#c9ad6a', hat=HAIR_RED, hat_kind='hair', gun='none'),
    'C10': Look(shirt='paint', pants='#4a5560', coat='paint', hat=HAIR_GREY, hat_kind='hair', gun='none'),
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
