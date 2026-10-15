// The loading screen's tips (the canvas board "Tips voor het laadscherm",
// screens/LoadingTips): one action per tip, at most two lines, only what the
// game really does. A tip may start with a hotkey (`hotkey`: its OpenRA name,
// js/openra-hotkeys.js), shown in the tooltip yellow as the player's own
// binding (js/hotkeys.js boundKey), or with a fixed key name (`key`).
//
// The screen shows them in turn: the one after the last shown, which the
// settings keep (`guide.lastTip`, js/registry.js), and moves on every
// TIP_MS. Pure: no DOM here (js/loadingboard.js draws them).

/** A tip stays this long before the next one. */
export const TIP_MS = 5000;

/** [group, lamp (LED_STATES), tips: { hotkey?, key?, text }[]]. */
export const TIP_GROUPS = Object.freeze([
  {
    name: 'Getting started',
    led: 'ok',
    tips: [
      { text: 'Deploy your MCV first: it becomes the Construction Yard that builds everything else.' },
      { text: 'A Power Plant first, then an Ore Refinery: the refinery brings a free Ore Truck.' },
      { text: 'New buildings must touch the area around your other buildings. Build toward the ore.' },
      { text: 'A Radar Dome turns on the radar minimap in the sidebar.' },
      { hotkey: 'Production01', text: 'Production slot 1: the slot keys build the items of the open production tab in order.' },
    ],
  },
  {
    name: 'Money',
    led: 'warn',
    tips: [
      { text: 'Blue gems are worth more than gold ore.' },
      { text: 'A second Ore Truck on the same refinery raises your income.' },
      { text: 'When you hear "Silos needed", build silos: a full refinery stops paying.' },
      { text: 'An engineer can capture an Oil Derrick: a bonus when taken and a steady income after.' },
      { text: 'Selling a building gives part of its cost back, and some of its crew walks out.' },
    ],
  },
  {
    name: 'Power and weather',
    led: 'warn',
    tips: [
      { text: 'Low power slows production and turns off defences such as the Tesla Coil.' },
      { hotkey: 'PowerDown', text: 'Power down: click a building to turn it off so the rest keeps running.' },
      { text: 'Lightning halves the health of what it strikes and likes power plants best.' },
      { text: "A struck power plant cuts its owner's power for 15 seconds." },
      { text: 'A Lightning Rod grounds every strike within 6 cells. Put it between your power plants.' },
      { text: 'On snow and ice vehicles slide; in a heat wave they overheat if they keep driving or firing.' },
    ],
  },
  {
    name: 'Orders',
    led: 'on',
    tips: [
      { hotkey: 'AttackMove', text: 'Attack move: walk to a spot and fight everything on the way.' },
      { hotkey: 'Guard', text: 'Guard: click a unit to follow and protect it.' },
      { hotkey: 'Stop', text: 'Stop what the selected units are doing.' },
      { hotkey: 'Scatter', text: 'Scatter: units step aside, good against splash damage.' },
      { key: 'Shift', text: 'Hold it while you give orders to queue waypoints.' },
      { hotkey: 'Deploy', text: 'Deploy: unfold an MCV, unload a transport, or make a factory primary.' },
    ],
  },
  {
    name: 'Camera and selection',
    led: 'info',
    tips: [
      { hotkey: 'CycleBase', text: 'Jump to your base.' },
      { hotkey: 'ToLastEvent', text: 'Jump to the last radar event.' },
      { hotkey: 'ToSelection', text: 'Jump to your selection.' },
      { hotkey: 'SelectAllUnits', text: 'Select your combat units on the screen; press it again for the whole map.' },
      { hotkey: 'SelectUnitsByType', text: 'Add the units of the selected types on the screen.' },
      { text: 'Double click a unit to select all of that type on the screen.' },
    ],
  },
  {
    name: 'Online and superweapons',
    led: 'info',
    tips: [
      { text: 'Online games do not pause. The game menu opens over the running game.' },
      { text: 'Lost the connection? Reload within 2 minutes to take your seat back.' },
      { text: 'Team chat only reaches your allies.' },
      { text: 'Every player sees the Atom Bomb and GPS countdowns of all players, AI players too.' },
      { text: 'A countdown that blinks white means that power is ready.' },
    ],
  },
]);

/** Every tip in order, with its group. */
export const TIPS = Object.freeze(TIP_GROUPS.flatMap((g) => g.tips.map((t) => Object.freeze({ ...t, group: g.name }))));

/** The tip after the last one shown (`lastTip`: -1 before the first; out of range starts over). */
export function nextTipIndex(lastTip, count = TIPS.length) {
  if (count <= 0) return -1;
  const last = Number.isInteger(lastTip) && lastTip >= 0 && lastTip < count ? lastTip : -1;
  return (last + 1) % count;
}

/** Step `by` tips from `index`, round the list. */
export function stepTip(index, by, count = TIPS.length) {
  if (count <= 0) return -1;
  return (((index + by) % count) + count) % count;
}

/**
 * A tip's key text and sentence: `keyText(hotkey)` gives a hotkey's current
 * binding ("A", "Ctrl+X"), or null when it is unbound (the tip then reads
 * without a key).
 */
export function tipParts(tip, keyText) {
  const key = tip.hotkey ? keyText(tip.hotkey) : (tip.key ?? null);
  return { key: key || null, text: tip.text };
}
