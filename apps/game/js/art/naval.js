// Art for ships (flat 1996 style). Entries: id -> { body: [w, h, draw], turret?: [w, h, draw] },
// drawn facing north. Helpers and palette come from ./kit.js.

import { C, rect, rrect, circle, poly, line } from './kit.js';

export const NAVAL_DRAW = {};

/** Extra special sprites ([w, h, draw]), at most 8; see SPECIAL_SLOTS in sprites.js. */
export const NAVAL_SPECIALS = [];
