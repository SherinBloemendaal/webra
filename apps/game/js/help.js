// Help texts of the lobby options and the in-game settings, in one table so
// they are easy to check and to translate later. The "?" buttons of
// js/infotip.js show them. Every number here comes from the engine: weather
// and biomes from engine/src/weather.rs (docs/contracts.md section 3), map
// styles from engine/src/mapgen, tech levels from the techlevel.* tokens in
// engine/rules.json, starting units from World::spawn_start_units, AI
// difficulties from engine/src/ai.rs and ai_arsenal.rs, game speeds from
// SPEED_MS (protocol/constants.js). No DOM here: Node tests import it.

const AI =
  'AI Easy thinks every 2 s and builds no defences, airfields, minefields or superweapons. Normal thinks every second, builds 2 defences and uses superweapons and special attacks after 15 minutes. Hard thinks every 0.6 s, builds 4 defences and more aircraft and ships, and uses superweapons from the start.';

export const HELP = Object.freeze({
  // ---- Game mode -----------------------------------------------------------------
  mode:
    'A game mode sets the world and the rules below in one go (not the seed, the map size or the players). Changing any of those options switches to Custom. Save as keeps the current setup as your own mode; signed in, it follows your account.',
  modeOnline:
    'A game mode sets the world and the rules below in one go (not the seed, the map size or the players). Only the host picks it; changing any option switches to Custom. Everyone sees the options it set.',

  // ---- Battlefield ---------------------------------------------------------------
  mapSource: 'Random map: generated from the seed and the options below. Map file: a map made in the map editor or an imported OpenRA map.',
  mapSize: 'Width and height of a generated map in cells: Small 64, Medium 96, Large 128, Huge 160. Five or more players need at least Medium.',
  mapFile:
    'A WebRA map file (.webra-map.json) or an OpenRA Red Alert map (.oramap), converted when you load it. Players take its start positions in slot order. Maps that change the game rules ask you first.',
  onlineMap:
    'A generated map, or a map file from the server or uploaded by the host. Players without the file download it before they can get ready.',
  seed: 'The same seed, map size, style, biome and player count always make the same map. Share it to play a battlefield again.',

  // ---- World -----------------------------------------------------------------------
  mapStyle:
    'Layout of a generated map. Land: open plains, or highlands with cliffs and narrow passes. Rivers: river valleys with fords. Lakes: a central lake joined to smaller lakes by streams. Islands: a central sea with islands and straits. On Rivers, Lakes and Islands every base gets the same harbour. Random picks one from the seed.',
  biome:
    'Terrain of a generated map and the weather it gets. Temperate: rain and thunderstorms. Snow: snowfall, slippery vehicles, slower infantry and frozen ponds (ice). Desert: heat waves and sandstorms. Random picks one from the seed. Map files bring their own biome.',
  weather:
    "On: after 2 to 3 clear minutes the biome's weather comes and goes. Sight drops to 90 % in rain, 85 % in thunderstorms and snowfall, 75 % in sandstorms. On snow infantry moves at 90 % and vehicles speed up and brake slowly, turn at 70 % (50 % on ice) and slide. In a heat wave vehicles heat up by driving (about 40 s) and firing; overheated, they move at 75 % and reload a third slower until they cool down. Lightning does no damage. Cosmetic only: the same skies, but the game plays as under clear skies, snow and heat included. Off: always clear skies.",

  // ---- Rules -----------------------------------------------------------------------
  startingCash: 'Credits every player starts with. A bale of ore pays 25 credits, a bale of gems 50.',
  startingUnits:
    'MCV only: one Mobile Construction Vehicle. Light support: an MCV, 3 riflemen and a tank. Heavy support: an MCV, 5 riflemen and 3 tanks. Construction Yard: the yard already deployed, no units.',
  techLevel:
    'What can be built. Infantry only: power, refineries, barracks and basic infantry. Low: adds war factories, naval yards, light tanks, APCs, gunboats and submarines. Medium: adds radar, aircraft, medium and heavy tanks, artillery and defences such as turrets and Tesla Coils. No superweapons: everything but the Chronosphere, Iron Curtain and Missile Silo. Unrestricted: everything.',
  gameSpeed: 'How fast game time runs, compared with Normal: Slowest 50 %, Slower 80 %, Fast 114 %, Faster 133 %, Fastest 200 %.',
  fog: 'You only see enemies within sight of your own (and allied) units and structures. Off: everything you have ever explored stays visible.',
  explored: 'The black shroud is lifted at the start, so the whole map is known. With fog of war on, enemies still hide outside your sight.',
  buildRadius: 'Structures must be placed within range of one of your Construction Yards, as well as next to your other structures. Off: next to your structures is enough.',
  redeployableMcv: 'A Construction Yard can pack up into an MCV again and drive to a new spot.',
  oreRegrowth: 'Harvested ore grows back and spreads onto free clear ground. Gems never grow back.',
  cheats:
    'Every player gets the debug menu (` key or the Debug button): instant building, building anywhere, free cash, unlimited power, a revealed map and more. Good for testing, not for a fair game.',

  // ---- Players -----------------------------------------------------------------------
  player: `Your name, or who plays in a slot: you (moves you there), an AI or Closed (nobody plays there). ${AI}`,
  playerOnline: `Who plays in each slot. The host opens and closes slots, adds AI players and picks their difficulty. ${AI}`,
  color: 'Every player has their own colour. Picking a colour another player has swaps the two.',
  colorOnline: 'Every player needs their own colour; a colour in use cannot be picked.',
  faction:
    'Allies and Soviets build different armies, and every country adds its own units (named under the choice). Random picks are made when the game starts.',
  team: 'Players on the same team share vision, never target each other and win together. None: everyone for themselves.',
  spectators:
    'Spectators watch without playing. The host sets how many places there are (up to 8); anyone can move between a free player slot and the spectators.',

  // ---- In-game settings (Esc menu) ------------------------------------------------------
  'settings.edgeScrollSpeed': 'How fast the map scrolls when the pointer touches a screen edge. Off turns edge scrolling off.',
  'settings.keyScrollSpeed': 'How fast the arrow keys scroll the map.',
  'settings.showUnitPaths': 'Draws the routes of your selected units to where they are going.',
  'settings.pixelRatioCap':
    'Highest number of rendered pixels per screen pixel. Sharp screens report 2 or 3; a lower cap is much faster on phones and slightly softer.',
  'settings.lowQuality': 'Renders below screen resolution and with fewer weather particles. Faster on phones and old computers.',
  'settings.fullscreen': 'Fills the screen with the game. Esc and the number keys then go to the game in browsers that allow it.',
});

/** The help text of `key`; throws for an unknown key so a missing text is a bug, not a blank tooltip. */
export function helpText(key) {
  if (!Object.hasOwn(HELP, key)) throw new Error(`No help text for "${key}"`);
  return HELP[key];
}
