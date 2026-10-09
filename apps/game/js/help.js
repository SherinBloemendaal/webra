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
    'A generated map, a community map, or one of the host\'s own maps (made in the map editor, an imported .oramap, or a map from an earlier lobby), shared with this lobby only and never published. Players without it are asked to install it; nobody can get ready, and the game cannot start, until every player and spectator has it.',
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
    "MCV only: one Mobile Construction Vehicle. Light support (OpenRA's sets): the MCV with 3 riflemen and 2 rocket soldiers around it, plus a Ranger and a light tank (Allies) or an APC and a Mobile Flak (Soviets). Heavy support: the same plus 3 medium tanks (Allies) or 2 heavy tanks (Soviets). Construction Yard: the yard already deployed, no units.",
  techLevel:
    'What can be built. Infantry only: power, refineries, barracks and basic infantry. Low: adds war factories, naval yards, light tanks, APCs, gunboats and submarines. Medium: adds radar, aircraft, medium and heavy tanks, artillery and defences such as turrets and Tesla Coils. No superweapons: everything but the Chronosphere, Iron Curtain and Missile Silo. Unrestricted: everything.',
  gameSpeed: 'How fast game time runs, compared with Normal: Slowest 50 %, Slower 80 %, Fast 114 %, Faster 133 %, Fastest 200 %.',
  fog: 'You only see enemies within sight of your own (and allied) units and structures. Off: everything you have ever explored stays visible.',
  explored: 'The black shroud is lifted at the start, so the whole map is known. With fog of war on, enemies still hide outside your sight.',
  buildRadius: 'Structures must be placed within range of one of your Construction Yards, as well as next to your other structures. Off: next to your structures is enough.',
  redeployableMcv: 'A Construction Yard can pack up into an MCV again and drive to a new spot.',
  crates:
    'A Badger drops a crate by parachute now and then (one to three on the map). Drive any ground unit or ship onto it: cash, a promotion, units, a new MCV if your base is gone, healing, invulnerability, copies of the unit, the map revealed, or bad luck (an explosion, napalm, the map hidden again).',
  shortGame: 'A player loses when its last structure (and MCV) is gone, not its last unit. Defences, walls and fake structures do not count.',
  allyBuildRadius: "Allied structures count too: you may build next to your allies' structures and within range of their Construction Yards.",
  separateTeamSpawns:
    'In a team game the team mates start next to each other, as far as possible from their enemies. Off, or without teams: every slot starts at the start position with its number.',
  bounty: 'Destroying an enemy unit or structure pays 10 percent of its value to the player who did it.',
  timeLimit:
    'The game ends after this many minutes of game time; the announcer counts the last minutes down. Then the side with the most experience (kills, repairs for allies) wins; players without a team count as one side, of which only the best player wins.',
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
  handicap:
    'Makes a player weaker on purpose, to even out a match: a 25 percent handicap means 75 percent firepower, a third more damage taken and 25 percent longer to build.',
  spectators:
    'Spectators watch without playing. The host sets how many places there are (up to 8); anyone can move between a free player slot and the spectators.',

  // ---- In-game settings (Esc menu, js/scale.js and js/layout.js) -----------------------
  'settings.uiScale':
    'Size of the sidebar, bars, menus and dialogs, from 50 % to 200 %; the battlefield gets the room that is left. It changes size only: how sharp the battlefield is drawn is Max resolution and Low quality.',
  'settings.gameScale':
    'How big units and terrain look, from 50 % to 300 %: the zoom a game starts at and Reset zoom returns to. The mouse wheel, pinch and the zoom keys zoom from there. The marks on the slider are the scales where pixel art is sharpest. Unlike Max resolution and Low quality, it changes size, not sharpness.',
  'settings.scaleAuto':
    'Auto picks the scale for your screen and picks again when the window or its pixel density changes; moving the slider turns it off. UI scale: 100 % on phones and in windows of at least 1600 x 900 (90 % on high-density screens), smaller in smaller windows, never below 85 % (80 % on high-density screens). Game scale: 100 % at 1920 x 1080, from 85 % to 150 % for other window sizes, 100 % on phones.',
  'settings.pixelRatioCap':
    'Highest number of pixels the battlefield is drawn with per screen pixel. Sharp screens report 2 or 3; a lower cap is much faster on phones and slightly softer. Sharpness and speed only: sizes are UI scale and game scale.',
  'settings.lowQuality':
    'Draws the battlefield below screen resolution (0.75 pixels per screen pixel) and with fewer weather particles: faster on phones and old computers, a little softer, the same size.',
  'settings.reduceMotion':
    'Big explosions shake the camera and an atom bomb flashes the screen white, like OpenRA. On: no shaking and only a dim flash. Like the browser: on when the system asks for reduced motion.',
  'settings.fullscreen': 'Fills the screen with the game. Esc and the number keys then go to the game in browsers that allow it.',
  'settings.edgeScrollSpeed': 'How fast the map scrolls when the pointer touches a screen edge. Off turns edge scrolling off.',
  'settings.keyScrollSpeed': 'How fast the arrow keys scroll the map.',
  'settings.showUnitPaths': 'Draws the routes of your selected units to where they are going.',
  'settings.playerStanceColors': 'Colours players by how they stand to you, like OpenRA: you green, allies yellow, enemies red. Spectators always see the players own colours.',
  'settings.mouseCapture':
    'Locks the pointer to the game, like the locked cursor of desktop OpenRA, so it cannot slip onto another monitor and the screen edges always scroll. In fullscreen: when you enter fullscreen or click into the game there. Always: on every click into the game. Alt+M (Option+M on a Mac; rebindable in Controls) turns it off and on, Esc releases it; opening the menu, switching windows or leaving fullscreen releases it too. A click into the game captures it again.',
  'settings.mouseCaptureSpeed':
    'How fast the game cursor moves while the mouse is captured: 1x matches the normal pointer. Browsers that pass raw mouse movement (without the system acceleration) can feel slower; raise it then.',
  'settings.mouseCaptureEscMenu':
    'Off: with the mouse captured, the first Esc only releases it and the next Esc opens the menu. On: one Esc releases the mouse and also cancels the current mode or opens the menu.',

  // ---- Audio (js/audio/panel.js in the game menu) --------------------------------------------
  'audio.master': 'Turns every sound up or down at once: effects, voices and music.',
  'audio.effects': 'Weapons, explosions, thunder and the other sounds of the battlefield.',
  'audio.voices': 'Unit replies and the announcer, spoken lines included.',
  'audio.music': 'Volume of the music; at 0 % no music plays, as with Music off.',
  'audio.speech':
    "When no original voice line is installed, your browser speaks unit replies and announcements with your system's voices. Off: radio blips and chimes only.",
  'audio.original':
    "Plays the original Red Alert sounds, voices and music installed from your own copy (Original content) instead of WebRA's own. Off: WebRA's sounds even when the originals are installed.",
  'audio.cashTicks': 'Plays a tick while the credits counter in the sidebar counts up or down, like Red Alert.',
  'audio.clickSounds': 'Plays a click on buttons, tabs and switches, like Red Alert. Production and support power buttons keep their own sounds.',
  'audio.musicOn': 'Plays music during games. Music needs installed original content or a texture pack with music.',
  'audio.menuMusic': "Plays Red Alert's intro track behind the main menu when the music is installed. After a game the score track (won) or the map track (lost) plays until you pick another track.",
  'audio.musicShuffle': 'Plays the tracks in a random order. Off: in playlist order.',
  'audio.musicRepeat': 'All: the playlist starts again after the last track. One: the current track repeats. Off: music stops after the last track.',
});

/** The help text of `key`; throws for an unknown key so a missing text is a bug, not a blank tooltip. */
export function helpText(key) {
  if (!Object.hasOwn(HELP, key)) throw new Error(`No help text for "${key}"`);
  return HELP[key];
}
