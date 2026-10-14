// Help texts of the lobby options and the in-game settings, in one table so
// they are easy to check and to translate later. The "?" buttons of
// js/infotip.js show them. Every number here comes from the engine: weather
// and biomes from engine/src/weather.rs (docs/contracts.md section 3), map
// styles from engine/src/mapgen, tech levels from the techlevel.* tokens in
// engine/rules.json, starting units from World::spawn_start_units, AI bot
// types and difficulties from engine/src/ai_bots.rs (OpenRA's ai.yaml in
// engine/rules.json "bots"), game speeds from
// SPEED_MS (protocol/constants.js). No DOM here: Node tests import it.

const AI =
  "AI players run OpenRA's Red Alert bots. Rush AI attacks early with squads of 20 or more and adds factories when rich. Normal AI builds a full base and attacks with squads of 40 or more. Turtle AI keeps one barracks and one war factory, walls its base in with defences, lays mines and seldom attacks. Naval AI builds airfields, helipads and a navy and attacks with aircraft and ships. The difficulty sets how fast the bot reacts: Easy takes twice as long, plays with an extra 25% handicap and leaves the Iron Curtain, Chronosphere and Sonar Pulse alone, Normal plays at OpenRA's pace, Hard reacts in two thirds of the time.";

export const HELP = Object.freeze({
  // ---- Game mode -----------------------------------------------------------------
  mode:
    'A game mode sets the world and the rules below in one go (not the seed, the map size or the players). Changing any of those options switches to Custom. Save as keeps the current setup as your own mode; signed in, it follows your account.',
  modeOnline:
    'A game mode sets the world and the rules below in one go (not the seed, the map size or the players). Only the host picks it; changing any option switches to Custom. Everyone sees the options it set.',

  // ---- Battlefield ---------------------------------------------------------------
  mapSource:
    "Random map: generated from the seed and the options below. Map file: a map made in the map editor or an imported OpenRA map. Point at the map preview for a closer look: a magnifier shows that spot as the game draws it (the mouse wheel zooms; on a touch screen, press and hold). The lettered markers are the start positions: click one to start there.",
  mapSize: 'Width and height of a generated map in cells: Small 64, Medium 96, Large 128, Huge 160. Five or more players need at least Medium.',
  mapFile:
    'A WebRA map file (.webra-map.json) or an OpenRA Red Alert map (.oramap), converted when you load it. Players take its start positions in slot order. Maps that change the game rules ask you first. Maps made for an older WebRA are upgraded automatically; save them in the map editor to keep the upgrade.',
  onlineMap:
    'A generated map, a community map, or one of the host\'s own maps (made in the map editor, an imported .oramap, or a map from an earlier lobby), shared with this lobby only and never published. Players without it are asked to install it; nobody can get ready, and the game cannot start, until every player and spectator has it. Point at the map preview for a closer look: a magnifier shows that spot as the game draws it (the mouse wheel zooms; on a touch screen, press and hold). The lettered markers are the start positions: click one to start there.',
  seed: 'The same seed, map size, style, biome and player count always make the same map. Share it to play a battlefield again.',

  // ---- World -----------------------------------------------------------------------
  mapStyle:
    'Layout of a generated map. Land: open plains, or highlands with cliffs and narrow passes. Rivers: river valleys with fords. Lakes: a central lake joined to smaller lakes by streams. Islands: a central sea with islands and straits. On Rivers, Lakes and Islands every base gets the same harbour. Random picks one from the seed.',
  biome:
    'Terrain of a generated map and the weather it gets. Temperate: rain and thunderstorms. Snow: snowfall, slippery vehicles, slower infantry and frozen ponds (ice). Desert: heat waves and sandstorms. Random picks one from the seed. Map files bring their own biome.',
  techBuildings:
    'Neutral buildings of a generated map, captured with engineers. Standard: an oil derrick in every base and a hospital in the middle. Extra: also forward command posts and communications centers between neighbouring bases. Oil only: a derrick in every base and one in the middle. Oil rush: two derricks in every base, more in the middle and between neighbours. None: no tech buildings. Every base gets the same ones; villages of civilian buildings come with every generated map. Map files bring their own.',
  weather:
    "On: after 2 to 3 clear minutes the biome's weather comes and goes. Sight drops to 90 % in rain, 85 % in thunderstorms and snowfall, 75 % in sandstorms. On snow infantry moves at 90 % and vehicles speed up and brake slowly, turn at 70 % (50 % on ice) and slide. In a heat wave vehicles heat up by driving (about 40 s) and firing; overheated, they move at 75 % and reload a third slower until they cool down. Lightning does no damage. Cosmetic only: the same skies, but the game plays as under clear skies, snow and heat included. Off: always clear skies.",

  // ---- Rules -----------------------------------------------------------------------
  startingCash: 'Credits every player starts with. A bale of ore pays 25 credits, a bale of gems 50.',
  startingUnits:
    "MCV only: one Mobile Construction Vehicle. Light support (OpenRA's sets): the MCV with 3 riflemen and 2 rocket soldiers around it, plus a Ranger and a light tank (Allies) or an APC and a Mobile Flak (Soviets). Heavy support: the same plus 3 medium tanks (Allies) or 2 heavy tanks (Soviets). Construction Yard: the yard already deployed, no units.",
  techLevel:
    'What can be built. Infantry only: power, refineries, barracks and basic infantry. Low: adds war factories, naval yards, light tanks, APCs, gunboats and submarines. Medium: adds radar, aircraft, medium and heavy tanks, artillery and defences such as turrets and Tesla Coils. No superweapons: everything but the Chronosphere, Iron Curtain and Missile Silo. Unrestricted: everything. Like OpenRA, every player sees the countdowns of the Atom Bomb and the GPS Satellite, whoever owns them, at the top left of the battlefield.',
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
    'In a team game the team mates who did not pick a start position start next to each other, as far as possible from their enemies. Off, or without teams: every slot starts at its own start position (slot 1 at A, slot 2 at B...) unless someone picked that one.',
  bounty: 'Destroying an enemy unit or structure pays 10 percent of its value to the player who did it.',
  timeLimit:
    'The game ends after this many minutes of game time; the announcer counts the last minutes down. Then the side with the most experience (kills, repairs for allies) wins; players without a team count as one side, of which only the best player wins.',
  movement:
    'How units make room for each other. OpenRA (as in OpenRA): every unit holds its own cell (up to five soldiers share one), never pushes; a unit whose way is blocked asks an idle friend to step aside, waits for it, then drives around, and a group moved to one spot stops around it. Vehicles at a Service Depot and ore trucks at a refinery dock one at a time while the others wait next to it. WebRA: units drive freely and nudge each other softly out of the way; once they arrive they stay put, and queues at the depot and refinery wait their turn.',
  factoryLoss:
    'What a production queue does when its last factory of that kind is lost (the Construction Yard for structures and defenses; for units the barracks or kennel, the war factory, the airfield or helipad, the naval yard or sub pen). OpenRA (as in OpenRA): the queue is emptied at once and everything paid for it comes back, finished items in full; nothing can be queued there until such a building stands again. WebRA: unit queues keep their items and wait, paying nothing, until a new factory of that kind stands; structure queues are cancelled and refunded with an announcement.',
  oreRegrowth:
    'Ore mines grow a bale of ore every 3 s in their field and gem mines a bale of gems, so harvested fields grow back. Off: the mines stay dormant and harvested fields are gone for good.',
  reusableEngineers:
    'Engineers capture a structure from next to it after a longer wait (15 s instead of 8 s) and stay on the battlefield, instead of going in and being used up.',
  cheats:
    'Every player gets the debug menu (` key or the Debug button): instant building, building anywhere, free cash, unlimited power, a revealed map and more. Good for testing, not for a fair game.',

  // ---- Players -----------------------------------------------------------------------
  player: `Your name, or who plays in a slot: you (moves you there), an AI or Closed (nobody plays there). ${AI}`,
  playerOnline: `Who plays in each slot. The host opens and closes slots, adds AI players and picks their bot type and difficulty. ${AI}`,
  color: 'Every player has their own colour. Picking a colour another player has swaps the two.',
  colorOnline: 'Every player needs their own colour; a colour in use cannot be picked.',
  faction:
    'Allies and Soviets build different armies, and every country adds its own units (named under the choice). Random picks are made when the game starts.',
  team: 'Players on the same team share vision, never target each other and win together. None: everyone for themselves.',
  handicap:
    'Makes a player weaker on purpose, to even out a match: a 25 percent handicap means 75 percent firepower, a third more damage taken and 25 percent longer to build.',
  spawn:
    'Where the player starts. Automatic shows where the lobby puts the player now (it moves when someone picks that position). Pick a position here, or click a marker on the map preview: a free one is yours (the host places its AI players there first, then itself), clicking your own frees it again, a position another player picked is taken. Right-click (or Delete on a marked position) frees it; the host can free anyone\'s. On a generated map the map itself changes with the seed, size, style and number of players, and so the picks are cleared.',
  spectators:
    'Spectators watch without playing. The host sets how many places there are (up to 8); anyone can move between a free player slot and the spectators. While watching, the statistics panel (F1 to F7, or its list) shows each player by team with its flag: cash, economy (with oil derricks), what each one is building, its support powers and army as icons, combat (with how much of the map it sees) and graphs. Point at an icon for its details.',

  // ---- Campaign (js/campaign/menu.js) ------------------------------------------------------
  campaign:
    "OpenRA's Red Alert missions with their maps, rules and scripts: the Allied and Soviet campaigns, the Counterstrike and Aftermath missions, OpenRA's own and the ant missions. In the campaigns a chapter opens once you win a mission of the chapter before it (any of its variants); the other missions are open from the start. Your progress is kept with your settings and follows your account. The original movies are not part of WebRA: a card stands in for each. Point at the mission's map for a closer look: a magnifier shows that spot as the game draws it (the mouse wheel zooms; on a touch screen, press and hold).",
  'mission.difficulty':
    "How hard the mission's script makes it, as the mission sets it: more or stronger enemies, fewer reinforcements, less time or less money. Some missions have a fourth level, Real tough guy.",

  // ---- In-game settings (Esc menu, js/scale.js and js/layout.js) -----------------------
  'settings.uiScale':
    'Size of the sidebar, bars, menus and dialogs, from 50 % to 200 %; the battlefield gets the room that is left. It changes size only: how sharp the battlefield is drawn is Max resolution and Low quality.',
  'settings.gameScale':
    'How big units and terrain look, from 50 % to 300 %: the zoom Reset zoom returns to. The mouse wheel, pinch and the zoom keys zoom from there, and the zoom you last used is remembered as a share of this scale: the next game (also missions, replays and watching) starts there, and changing the scale keeps it. Reset zoom and Defaults forget it. The marks on the slider are the scales where pixel art is sharpest. Unlike Max resolution and Low quality, it changes size, not sharpness.',
  'settings.scaleAuto':
    'Auto picks the scale for your screen and picks again when the window or its pixel density changes; moving the slider turns it off. UI scale: 100 % on phones and in windows of at least 1600 x 900, smaller in smaller windows, never below 85 %, the same on retina and other screens. Game scale: 100 % at 1920 x 1080, from 85 % to 150 % for other window sizes, 100 % on phones; on sharp screens it moves to the nearest scale where pixel art is sharpest, and in windows smaller than 1920 x 1080 to the smaller one (a 14 inch MacBook gets 67 %), so small screens show more of the map.',
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
  'settings.targetLines':
    'Lines from your selected units to what they were ordered to do, like OpenRA: green to where they move, red to what they attack or capture, orange for attack-moves and guarding, yellow for repairs and deliveries, with a dot at each target and queued waypoints after it. After orders: for a moment after an order or a selection, and while Shift is held. With Shift: only while Shift is held. Off: never.',
  'settings.playerStanceColors': 'Colours players by how they stand to you, like OpenRA: you green, allies yellow, enemies red. Spectators always see the players own colours.',
  'settings.hideReplayChat':
    "Like OpenRA: in a replay the players' chat lines stay out of the lines over the battlefield and play no sound; the chat history (Enter) still lists them. System lines always show.",
  'settings.uiFeedbackNotifications':
    'Like OpenRA: short text lines for UI events, such as "Selected 12 units across screen." after the select hotkeys. Off: no such lines.',
  'settings.gameEventNotifications':
    "Like OpenRA: the announcer's lines as text at the bottom of the battlefield (\"Unit ready.\", \"Construction complete.\"), also with the sound off. Off: no such lines; chat and system lines stay.",
  'settings.mouseCapture':
    'Locks the pointer to the game, like the locked cursor of desktop OpenRA, so it cannot slip onto another monitor and the screen edges always scroll. In fullscreen: when you enter fullscreen or click into the game there. Always: on every click into the game. Alt+M (Option+M on a Mac; rebindable in Controls) turns it off and on, Esc releases it; opening the menu, switching windows or leaving fullscreen releases it too. A click into the game captures it again.',
  'settings.mouseCaptureSpeed':
    "How fast the game cursor moves while the mouse is captured. At 1x it moves exactly like the system pointer, with your system's pointer speed and acceleration. With Raw mouse input on, 1x is one pixel per mouse count at slow speed, with the game's own acceleration on top.",
  'settings.mouseCaptureRaw':
    "Off (recommended): the captured pointer gets the same movement as the system pointer. On: the browser passes raw mouse counts without the system's acceleration where it supports that (such as Chrome and Edge; elsewhere the normal movement is used), and the game adds its own curve: slow, precise moves go one pixel per count, fast flicks up to three times as far. The change applies from the next capture.",
  'settings.errorReports':
    "When the site's operator has turned error reporting on, sends the error with the game's version, your browser and the game mode to WebRA's own Sentry (sentry.vitrion.dev) when something breaks. Never your name, chat, maps or account. Off: nothing is sent from this browser (the switch covers this browser; signed in, it syncs to your other devices). WebRA's server then reports its own errors either way, also of a request of yours that failed, without player data. The privacy notice on the website says whether reporting is on and what a report holds.",
  'settings.mouseCaptureEscMenu':
    'Off: with the mouse captured, the first Esc only releases it and the next Esc opens the menu. On: one Esc releases the mouse and also cancels the current mode or opens the menu.',

  // ---- Game menu pages (js/gamemenu.js MENU_PAGE_HELP_KEYS) ---------------------------------
  'menu.gameInfo':
    "The game's map, objectives and options, like OpenRA's game info. Objectives shows your mission and every player's score (OpenRA's player experience: a point per 100 credits of what they destroyed, plus repairs of allies' structures and infiltrations), the teams with the most score first; opponents keep the country the lobby showed until your game is decided. Briefing shows the mission briefing or the map's description, Options the lobby options this game is played with.",
  'menu.surrender':
    'Online games with more than one person, like OpenRA: you lose at once, your units and structures are destroyed and everyone sees you defeated. You can stay and watch the rest of the game as a spectator. Single player games have Leave and Restart instead.',

  // ---- Controls page notes (js/gamemenu.js CONTROLS_HELP_KEYS) --------------------------------
  'controls.keys':
    "The keys are OpenRA's Red Alert defaults, except where the browser keeps OpenRA's key: Shift+Tab is the next facility (Ctrl+Tab switches tabs), Alt+Shift+Q and Alt+Shift+W record bookmarks 1 and 2 (Ctrl+Q and Ctrl+W quit and close), and F11 and F12 have nothing (full screen and developer tools). Some browsers keep Ctrl/Cmd + number for switching tabs. WebRA holds those keys back while the game has focus where the browser allows it; in fullscreen (Chrome, Edge) the digit row and Esc are locked to the game. On macOS, Ctrl + number works as well as Cmd + number.",
  'controls.focus':
    'Like OpenRA, a key goes to the game unless the focused control uses it. Typing in a text field (the chat line, a save name) takes every key. A switch, slider or list keeps only the keys that work it (Space; the arrows, Home and End; Enter in a list), so the hotkeys keep working after a click on one. A button clicked with the mouse keeps no key; one reached with Tab keeps Tab and Enter.',
  'controls.selection':
    "Select all (Q) picks your units on screen of OpenRA's highest selection priority: combat units first, then support units such as the MCV, harvesters, defences and other structures. Select by type (W) adds the units of the selected types on screen. Press either again for the whole map. A double click adds that type on screen. Rest the mouse on the battlefield for a moment and a tooltip names what is there, like OpenRA: the unit or structure and its owner, a remembered structure under the fog, ore, or Unrevealed Terrain. Selected defences, detectors and gap generators show their range as a dashed circle, and placing a defence shows the circles of your defences of the same kind.",

  // ---- Audio (js/audio/panel.js in the game menu) --------------------------------------------
  'audio.master': 'Turns every sound up or down at once: effects, voices and music.',
  'audio.effects': 'Weapons, explosions, thunder and the other sounds of the battlefield.',
  'audio.voices': 'Unit replies and the announcer, spoken lines included.',
  'audio.music': 'Volume of the music; at 0 % no music plays, as with Music off.',
  'audio.speech':
    "When no original voice line is installed, your browser speaks unit replies and announcements with your system's voices. Off: radio blips and chimes only.",
  'audio.original':
    "Plays the original Red Alert sounds, voices and music installed from your own copy (Original content) instead of WebRA's own. Where Red Alert has no sound, as in OpenRA, it stays quiet, and lines OpenRA recorded itself (\"Battle control online\") show as text. Off: WebRA's sounds even when the originals are installed.",
  'audio.cashTicks': 'Plays a tick while the credits counter in the sidebar counts up or down, like Red Alert.',
  'audio.clickSounds': 'Plays a click on buttons, tabs and switches, like Red Alert. Production and support power buttons keep their own sounds.',
  'audio.musicOn': 'Plays music during games. Music needs installed original content or a texture pack with music.',
  'audio.menuMusic': "Plays Red Alert's intro track behind the main menu and its screens when the music is installed. It starts as soon as the browser allows sound: at once, or with your first click, tap or key press on the page. After a game the score track (won) or the map track (lost) plays until you pick another track.",
  'audio.musicShuffle': 'Plays the tracks in a random order. Off: in playlist order.',
  'audio.musicRepeat': 'All: the playlist starts again after the last track. One: the current track repeats. Off: music stops after the last track.',
});

/** The help text of `key`; throws for an unknown key so a missing text is a bug, not a blank tooltip. */
export function helpText(key) {
  if (!Object.hasOwn(HELP, key)) throw new Error(`No help text for "${key}"`);
  return HELP[key];
}
