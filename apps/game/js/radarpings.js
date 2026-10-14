// Radar pings (OpenRA RadarPings): a shrinking, turning triangle on the radar
// where something happened, and the spot the "jump to last radar event"
// hotkey (Space, OpenRA ToLastEvent) goes to. Made from the engine's events
// (engine/src/sound_events.rs), like OpenRA's:
//
// - a structure of the player or an ally under attack (DamageNotifier: red,
//   250 ticks, at most every 30 seconds per owner), and a unit (every 10 s);
// - a beacon of the player or an ally (PlaceBeacon: the owner's colour, for
//   as long as the beacon stays);
// - the player's or an ally's superweapon fired (SupportPower
//   DisplayRadarPing: the Nuke, Iron Curtain and Chronosphere);
// - WebRA addition: a move order of the watched player that stopped short
//   because the way stayed blocked (engine RouteBlocked: yellow, at the
//   unit, as often as the engine reports it).
//
// Only pings the viewer may see count (OpenRA: allies of the render player);
// the last of them is the last event. No DOM: js/minimap.js draws them.
//
// Times: pings shrink, turn and expire on the simulation clock
// (js/simclock.js), as OpenRA's RadarPings ticks with the world, so they
// stand still while the game is paused. The damage ping interval counts the
// page clock, as DamageNotifier's Game.RunTime does.

import { EV, STRIDE } from './audio/director.js';
import { POWER_KINDS } from './audio/catalog.js';

/** OpenRA RadarPingsInfo: start and end radius (radar pixels), shrink per tick, turn per tick (radians). */
export const FROM_RADIUS = 200;
export const TO_RADIUS = 15;
export const SHRINK_PER_TICK = 4;
export const TURN_PER_TICK = 0.12;
/** DamageNotifier and SupportPower RadarPingDuration (ticks). */
export const PING_TICKS = 250;
/** DamageNotifier NotifyInterval: structures (RA DamageNotifier) and units (DamageNotifier@Unit), milliseconds. */
export const STRUCTURE_INTERVAL_MS = 30000;
export const UNIT_INTERVAL_MS = 10000;
/** Support powers with DisplayRadarPing in Red Alert. */
export const PINGED_POWERS = new Set(['NukePower', 'GrantExternalConditionPower', 'ChronoshiftPower']);
/** Ticks a route-blocked ping stays (WebRA). */
export const ROUTE_BLOCKED_TICKS = 100;

const RED = [1, 0, 0];
const YELLOW = [1, 1, 0];

export class RadarPings {
  /**
   * @param {object} o
   * @param {(owner: number) => boolean} o.visible whether pings of `owner`'s
   *   things are for this viewer (owner and allies of the watched player)
   * @param {(owner: number) => boolean} [o.own] whether `owner` is the watched
   *   player (pings meant for that player alone); default `visible`
   * @param {(owner: number) => number[]} o.color an owner's colour, rgb 0..1
   * @param {number} o.pxPerWorld world pixels per engine world unit
   * @param {number} [o.tickMs] milliseconds per game tick
   */
  constructor({ visible, own = visible, color, pxPerWorld, tickMs = 40 }) {
    this.visible = visible;
    this.own = own;
    this.color = color;
    this.pxPerWorld = pxPerWorld;
    this.tickMs = tickMs;
    /** @type {{ x: number, y: number, color: number[], at: number, until: number }[]} */
    this.pings = [];
    /** World pixels of the last visible ping (OpenRA LastPingPosition), or null. */
    this.lastPosition = null;
    /** owner -> earliest time of the next damage ping, per kind. */
    this.nextStructure = new Map();
    this.nextUnit = new Map();
  }

  /** Add a ping at world pixels (x, y) shown for `ticks` game ticks. */
  add(x, y, color, ticks, now) {
    this.pings.push({ x, y, color, at: now, until: now + ticks * this.tickMs });
    this.lastPosition = { x, y };
  }

  /** The spot of the last radar event, or null. */
  last() {
    return this.lastPosition;
  }

  /**
   * Read a frame's engine events (flat, STRIDE per event) at simulation time
   * `now` (ms); `wall` is the page clock (ms) of the damage ping interval.
   */
  onEvents(events, now, wall = now) {
    if (!events) return;
    for (let i = 0; i + STRIDE <= events.length; i += STRIDE) {
      const kind = events[i];
      const a = events[i + 1];
      const x = events[i + 2] * this.pxPerWorld;
      const y = events[i + 3] * this.pxPerWorld;
      const owner = events[i + 4];
      const b = events[i + 5];
      if (!this.visible(owner)) continue;
      if (kind === EV.BUILDING_DAMAGED || kind === EV.UNIT_DAMAGED) {
        const next = kind === EV.BUILDING_DAMAGED ? this.nextStructure : this.nextUnit;
        if (wall < (next.get(owner) ?? -Infinity)) continue;
        next.set(owner, wall + (kind === EV.BUILDING_DAMAGED ? STRUCTURE_INTERVAL_MS : UNIT_INTERVAL_MS));
        this.add(x, y, RED, PING_TICKS, now);
      } else if (kind === EV.BEACON_PLACED) {
        this.add(x, y, this.color(owner), Math.max(1, b), now);
      } else if (kind === EV.POWER_ACTIVATED && PINGED_POWERS.has(POWER_KINDS[a])) {
        this.add(x, y, this.color(owner), PING_TICKS, now);
      } else if (kind === EV.ROUTE_BLOCKED && this.own(owner)) {
        this.add(x, y, YELLOW, ROUTE_BLOCKED_TICKS, now);
      }
    }
  }

  /**
   * Pings on screen at `now`: position, colour, and the triangle's radius
   * and turn (OpenRA RadarPing.Tick: from FROM_RADIUS down to TO_RADIUS).
   */
  active(now) {
    this.pings = this.pings.filter((p) => now < p.until);
    return this.pings.map((p) => {
      const ticks = (now - p.at) / this.tickMs;
      return {
        x: p.x,
        y: p.y,
        color: p.color,
        radius: Math.max(FROM_RADIUS - SHRINK_PER_TICK * ticks, TO_RADIUS),
        angle: -TURN_PER_TICK * ticks,
      };
    });
  }

  /** The three corners of a ping's triangle around (cx, cy), scaled by `scale`. */
  static triangle(cx, cy, radius, angle, scale = 1) {
    return [0, 1, 2].map((k) => {
      const a = angle + (k * 2 * Math.PI) / 3;
      return [cx + Math.cos(a) * radius * scale, cy + Math.sin(a) * radius * scale];
    });
  }
}
