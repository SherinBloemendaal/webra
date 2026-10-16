// Art for the vehicles (2D minimal pack). Entries: id -> { body: [w, h, draw],
// turret?: [w, h, draw] }, drawn facing north; a turret sprite is drawn
// centred on the body and turns about its centre.
//
// Two to four flat shapes per vehicle (body and turret together), after the
// tank and the harvester of the retexture board: treads or wheels, the hull,
// the one team area (the turret, else the cargo bed or the deck) and the
// feature that names the vehicle (the gun, the scoop and ore, the rocket, the
// dish, the crane). One hard shadow per sprite. The kit is ./unitkit.js.

import { M, TEAM, box, disc, shape, sprite, inner, wheels, treads } from './unitkit.js';
import { pixelUnitDraw } from './pixel.js';

/**
 * A tank: treads `track` wide and the hull between them, the team turret
 * (`tr` its half size) centred on the sprite, and one or two guns forward
 * (`twin`: the gap between their centres), or `head` in place of the gun.
 */
function tank(w, h, { track, tr, gun = 2, twin = 0, head = null }) {
  const [W, H] = inner(w, h);
  const [cx, cy] = [w / 2, h / 2];
  const body = sprite(w, h, [
    [M.darker, ...treads(W, 0, H, track)],
    [M.steel2, box(track - 1, 1.5, W - 2 * (track - 1), H - 3, 1.5)],
  ], box(0, 0, W, H, 1.5));
  const turretBox = box(cx - tr, cy - tr, 2 * tr, 2 * tr, 2);
  const reach = cy - tr + 1;
  const guns = twin ? [box(cx - twin / 2 - gun / 2, 0, gun, reach), box(cx + twin / 2 - gun / 2, 0, gun, reach)] : [box(cx - gun / 2, 0, gun, reach)];
  const turret = sprite(w, h, [[TEAM, turretBox], head ?? [M.dark, ...guns]], turretBox);
  return { body, turret };
}

/**
 * A wheeled truck: wheels at `ys`, the steel chassis (the cab at the front),
 * the team cargo bed from `bed` down and the load drawn by the caller.
 */
function truck(w, h, ys, bed, load) {
  const [W, H] = inner(w, h);
  return {
    body: sprite(w, h, [
      [M.darker, ...wheels(W, ys)],
      [M.steel2, box(1.5, 0, W - 3, H, 1.5)],
      [TEAM, box(3, bed, W - 6, H - bed - 1.5, 1)],
      load(W, H),
    ], box(0, 0, W, H, 1.5)),
  };
}

export const VEHICLE_DRAW = {
  // Light Tank: a small hull, one gun.
  '1TNK': tank(22, 22, { track: 4.5, tr: 4.5, gun: 1.5 }),
  // Medium Tank: a bigger turret and gun.
  '2TNK': tank(24, 24, { track: 5, tr: 5, gun: 2 }),
  // Heavy Tank: wide treads, twin guns.
  '3TNK': tank(26, 26, { track: 5.5, tr: 5.5, gun: 1.6, twin: 3.4 }),
  // Mammoth Tank: the biggest hull, twin heavy guns.
  '4TNK': tank(36, 40, { track: 8, tr: 7.5, gun: 2.4, twin: 5.2 }),
  // Ore Truck (the board's harvester): the scoop in front, the team bed full of ore.
  HARV: (() => {
    const [W, H] = inner(32, 38);
    return {
      body: sprite(32, 38, [
        [M.darker, ...treads(W, 5.5, H - 5.5, 6)],
        [M.steel, box(1, 0, W - 2, 5.5, 1)],
        [TEAM, box(3.5, 5, W - 7, H - 5, 2)],
        [M.gold, box(7, 12, W - 14, H - 17, 1)],
      ], box(0, 0, W, H, 2)),
    };
  })(),
  // Ranger: a jeep with the machine gun mount as its turret.
  JEEP: (() => {
    const [W, H] = inner(18, 22);
    return {
      body: sprite(18, 22, [
        [M.darker, ...wheels(W, [2.5, H - 7.5])],
        [M.steel2, box(1.5, 0, W - 3, H, 3)],
      ], box(0, 0, W, H, 3)),
      turret: sprite(18, 22, [[TEAM, disc(9, 11, 3.2)], [M.dark, box(8.4, 1, 1.2, 8)]], disc(9, 11, 3.2)),
    };
  })(),
  // APC: a boxy troop carrier with a team roof and a bow machine gun.
  APC: (() => {
    const [W, H] = inner(22, 24);
    return {
      body: sprite(22, 24, [
        [M.darker, ...treads(W, 0, H, 4.5)],
        [M.steel2, box(3, 0, W - 6, H, 1.5)],
        [TEAM, box(5, 6, W - 10, H - 9, 1)],
        [M.dark, box(W / 2 - 0.6, 0, 1.2, 5)],
      ], box(0, 0, W, H, 1.5)),
    };
  })(),
  // Mobile Flak: WebRA's own pixel art in Red Alert's style (art/pixel.js); the
  // turret sits at OpenRA's Turreted offset (vehicles.yaml FTRK: -298,0,298).
  FTRK: pixelUnitDraw('FTRK', [-298, 0]),
  // V2 Launcher: the white rocket lying on the team bed.
  V2RL: truck(22, 28, [2, 10, 19], 7, (W, H) => [M.paint, shape(W / 2, 1.5, W / 2 + 2.6, 6, W / 2 + 2.6, H - 4, W / 2 - 2.6, H - 4, W / 2 - 2.6, 6)]),
  // Artillery: a long howitzer over a light tracked chassis, the team gun shield.
  ARTY: (() => {
    const [W, H] = inner(22, 26);
    return {
      body: sprite(22, 26, [
        [M.darker, ...treads(W, 7, H - 7, 4.5)],
        [M.steel2, box(3.5, 7, W - 7, H - 7, 1.5)],
        [TEAM, box(5, 8.5, W - 10, 7, 1.5)],
        [M.dark, box(W / 2 - 0.9, 0, 1.8, 12)],
      ], box(0, 7, W, H - 7, 1.5)),
    };
  })(),
  // Minelayer: a team mine deck with two rows of mines.
  MNLY: (() => {
    const [W, H] = inner(22, 24);
    return {
      body: sprite(22, 24, [
        [M.darker, ...treads(W, 0, H, 4.5)],
        [M.steel2, box(3, 0, W - 6, H, 1.5)],
        [TEAM, box(5, 7, W - 10, H - 9, 1)],
        [M.dark, ...[11, 16].flatMap((y) => [disc(W / 2 - 2.6, y, 1.6), disc(W / 2 + 2.6, y, 1.6)])],
      ], box(0, 0, W, H, 1.5)),
    };
  })(),
  // Radar Jammer: the white jamming dish on the bed.
  MRJ: truck(20, 26, [2, 10, 18], 8, (W) => [M.dome, disc(W / 2, 15.5, 5.2)]),
  // Mobile Gap Generator: the glowing gap emitter on the bed.
  MGG: truck(20, 26, [2, 10, 18], 8, (W) => [M.blue, disc(W / 2, 15.5, 4.6)]),
  // Tesla Tank: the tesla coil on the team turret.
  TTNK: tank(26, 26, { track: 5.5, tr: 5.5, head: [M.blue, disc(13, 13, 3.2), box(12.2, 0, 1.6, 9)] }),
  // Demolition Truck: the hazard-yellow bomb on the bed.
  DTRK: truck(20, 24, [2, 9, 16], 7, (W) => [M.yellow, box(W / 2 - 4, 9.5, 8, 8, 1.5)]),
  // Chrono Tank: an angular hull with the glass chrono core on a team plate.
  CTNK: (() => {
    const [W, H] = inner(24, 26);
    return {
      body: sprite(24, 26, [
        [M.darker, ...treads(W, 2, H - 2, 4.5)],
        [M.steel2, shape(W / 2, 0, W - 3.5, 4, W - 3.5, H, 3.5, H, 3.5, 4)],
        [TEAM, box(6, 7, W - 12, H - 10, 1)],
        [M.glass, disc(W / 2, 7 + (H - 10) / 2, 3.6)],
      ], box(0, 0, W, H, 1.5)),
    };
  })(),
  // Phase Transport: a slab-sided hull, the missile launcher as its turret.
  STNK: (() => {
    const [W, H] = inner(24, 26);
    const launcher = box(8, 8.5, 8, 9, 1.5);
    return {
      body: sprite(24, 26, [
        [M.darker, ...treads(W, 0, H, 4.5)],
        [M.steel2, shape(7, 0, W - 7, 0, W - 3.5, 4, W - 3.5, H, 3.5, H, 3.5, 4)],
      ], box(0, 0, W, H, 1.5)),
      turret: sprite(24, 26, [[TEAM, launcher], [M.paint, box(11, 1, 2, 9, 1)]], launcher),
    };
  })(),
  // Supply Truck: the canvas tarp over the front of the team bed.
  TRUK: truck(20, 26, [2, 10, 18], 7, (W, H) => [M.canvas, box(4.5, 8.5, W - 9, (H - 8.5) * 0.6, 1)]),
  // MAD Tank: the hazard-yellow seismic hammer on a team deck.
  QTNK: (() => {
    const [W, H] = inner(34, 38);
    return {
      body: sprite(34, 38, [
        [M.darker, ...treads(W, 0, H, 7)],
        [M.steel2, box(6, 0, W - 12, H, 1.5)],
        [TEAM, box(8, 3, W - 16, H - 6, 1.5)],
        [M.yellow, disc(W / 2, H / 2, 7)],
      ], box(0, 0, W, H, 1.5)),
    };
  })(),
  // MCV: the cab up front, the folded yellow crane over the team deck.
  MCV: (() => {
    const [W, H] = inner(32, 38);
    return {
      body: sprite(32, 38, [
        [M.darker, ...wheels(W, [3, 12, 21, H - 6], 4, 5)],
        [M.steel2, box(2, 0, W - 4, H, 2)],
        [TEAM, box(4, 9, W - 8, H - 11, 1.5)],
        [M.yellow, box(W / 2 - 3, 6, 6, H - 12, 1), disc(W / 2, H - 9, 5)],
      ], box(0, 0, W, H, 2)),
    };
  })(),
};
