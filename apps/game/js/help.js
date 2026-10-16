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
    'A game mode sets the world and the rules below in one go (not the seed, the map size or the players). Changing any of those options switches to Custom. Save as (or Save setup at the bottom of the skirmish screen) keeps the current setup as your own mode; signed in, it follows your account.',
  modeOnline:
    'A game mode sets the world and the rules below in one go (not the seed, the map size or the players). Only the host picks it; changing any option switches to Custom. Everyone sees the options it set.',

  // ---- Battlefield ---------------------------------------------------------------
  mapSource:
    "Random map: generated from the seed and the options below. Map file: a map made in the map editor or an imported OpenRA map. For a closer look, hold Ctrl (on macOS Cmd or Ctrl) with the mouse over the map preview: a magnifier shows that spot as the game draws it, the mouse wheel zooms it, and releasing the key hides it (on a touch screen, press and hold). The lettered markers are the start positions: click one to start there.",
  mapSize: 'Width and height of a generated map in cells: Small 64, Medium 96, Large 128, Huge 160. Five or more players need at least Medium.',
  mapFile:
    'A WebRA map file (.webra-map.json) or an OpenRA Red Alert map (.oramap), converted when you load it. Players take its start positions in slot order. Maps that change the game rules ask you first. Maps made for an older WebRA are upgraded automatically; save them in the map editor to keep the upgrade. Unload map goes back to the generated map with the size, style, biome and seed it had before; the map stays in your map library.',
  onlineMap:
    'A generated map, a community map, or one of the host\'s own maps (made in the map editor, an imported .oramap, or a map from an earlier lobby), shared with this lobby only and never published. Players without it are asked to install it; nobody can get ready, and the game cannot start, until every player and spectator has it. For a closer look, hold Ctrl (on macOS Cmd or Ctrl) with the mouse over the map preview: a magnifier shows that spot as the game draws it, the mouse wheel zooms it, and releasing the key hides it (on a touch screen, press and hold). The lettered markers are the start positions: click one to start there.',
  seed: 'The same seed, map size, style, biome and player count always make the same map. Share it to play a battlefield again. A map file needs no seed: each game on one gets a new seed for crates, the AI and the weather (replays and saves keep it).',

  // ---- World -----------------------------------------------------------------------
  mapStyle:
    'Layout of a generated map. Land: open plains, or highlands with cliffs and narrow passes. Rivers: river valleys with fords. Lakes: a central lake joined to smaller lakes by streams. Islands: a central sea with islands and straits. On Rivers, Lakes and Islands every base gets the same harbour. Random picks one from the seed.',
  biome:
    'Terrain of a generated map and the weather it gets. Temperate: rain and thunderstorms. Snow: snowfall, slippery vehicles, slower infantry and frozen ponds (ice). Desert: heat waves and sandstorms. Random picks one from the seed. Map files bring their own biome.',
  techBuildings:
    'Neutral buildings of a generated map, captured with engineers. Standard: an oil derrick in every base and a hospital in the middle. Extra: also forward command posts and communications centers between neighbouring bases. Oil only: a derrick in every base and one in the middle. Oil rush: two derricks in every base, more in the middle and between neighbours. None: no tech buildings. Every base gets the same ones; villages of civilian buildings come with every generated map. Map files bring their own.',
  weather:
    "On: after 2 to 3 clear minutes the biome's weather comes and goes. Sight drops to 90 % in rain, 85 % in thunderstorms and snowfall, 75 % in sandstorms. On snow infantry moves at 90 % and vehicles speed up and brake slowly, turn at 70 % (50 % on ice) and slide. In a heat wave vehicles heat up by driving (about 40 s) and firing; overheated, they move at 75 % and reload a third slower until they cool down. Lightning halves what it strikes and prefers power plants, bots' and humans' alike (their owner's power goes out for 15 s, and a struck plant makes half its power until repaired), never in a storm's last 8 s; Lightning Rods ground strikes within 6 cells. Cosmetic only: the same skies, but the game plays as under clear skies, snow and heat included. Off: always clear skies.",

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
    'How units make room for each other. OpenRA (as in OpenRA): every unit holds its own cell (up to five soldiers share one), never pushes; a unit whose way is blocked asks an idle friend to step aside, waits for it, then drives around, and a group moved to one spot stops around it. Ore trucks at a refinery dock one at a time while the others wait next to it. WebRA: units drive freely and nudge each other softly out of the way; once they arrive they stay put, and queues at the refinery wait their turn. In both, units sent to a Service Depot line up first come first served on spots of their own around it (helicopters hover, planes circle) and are repaired one after another.',
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
  playerOnline: `Who plays in each slot. The host opens and closes slots, sets up AI players and sets the others' team, handicap and start. ${AI}`,
  color: 'Every player has their own colour. Picking a colour another player has swaps the two.',
  colorOnline: 'Every player needs their own colour; a colour in use cannot be picked.',
  faction:
    'Allies and Soviets build different armies, and every country adds its own units (named under the choice). Random picks are made when the game starts.',
  team: 'Players on the same team share vision, never target each other and win together. None: everyone for themselves.',
  handicap:
    'Makes a player weaker on purpose, to even out a match: a 25 percent handicap means 75 percent firepower, a third more damage taken and 25 percent longer to build.',
  spawn:
    'Where the player starts. Automatic shows where the lobby puts the player now (it moves when someone picks that position). Pick a position here, or click a marker on the map preview: a free one is yours (the host places its AI players there first, then itself), clicking your own frees it again, a position another player picked is taken. Right-click (or Delete on a marked position) frees it; the host can free anyone\'s. On a generated map the map itself changes with the seed, size, style and number of players, and so the picks are cleared.',
  bulk:
    'Bulk edit changes many slots at once. Tick rows, or click a row: Ctrl (Cmd on a Mac) adds or removes one, Shift selects every row from the last one you clicked down or up to this one. Then pick an action and Apply: team presets (free for all, humans vs AI, split or alternate into teams, or one team), AI type and difficulty, fill empty slots with AI or remove the AI, factions (or shuffled countries), shuffled colors, handicap, start positions and opening or closing slots. With nothing selected an action changes every slot it can (as the FFA, 2 teams and Humans v AI buttons do). Slots the map locks keep their setting. Online only the host can, and the server checks every change; factions and colors then change only for the host\'s own slot and the AI slots, as every player picks their own.',
  spectators:
    'Spectators watch without playing. The host sets how many places there are (up to 8); anyone can move between a free player slot and the spectators. While watching, the statistics panel (F1 to F7, or its list) shows each player by team with its flag: cash, economy (with oil derricks), what each one is building, its support powers and army as icons, combat (with how much of the map it sees) and graphs. Point at an icon for its details.',
  connection:
    "Each player's connection to the game server: a ping every 2 seconds, the round trip in milliseconds, its jitter (how much it varies) and the loss (pings answered after more than a second). Good (four bars): under 80 ms, jitter up to 20 ms and no loss. Fair (three bars): 80 to 150 ms, or jitter above 20 ms; playable. Poor (one bar): above 150 ms, or more than 2% loss; expect stutter, because in an online game everyone waits for the slowest player. Test again sends three pings at once; the host can kick a player whose connection stays poor. Start game warns about a poor connection but does not stop you.",

  // ---- Campaign (js/campaign/menu.js) ------------------------------------------------------
  campaign:
    "OpenRA's Red Alert missions with their maps, rules and scripts: the Allied and Soviet campaigns, the Counterstrike and Aftermath missions, OpenRA's own and the ant missions. In the campaigns a chapter opens (until then Locked) once you win a mission of the chapter before it, any of its variants; the other missions are open from the start. Next marks the mission after your furthest win. Your progress follows your account. The original movies are not part of WebRA: a card stands in for each; once installed (Original content), Watch the briefing plays it. For a closer look, hold Ctrl (on macOS Cmd or Ctrl) with the mouse over the mission's map: a magnifier shows that spot as the game draws it, the mouse wheel zooms it, and releasing the key hides it (on a touch screen, press and hold).",
  'mission.difficulty':
    "How hard the mission's script makes it, as the mission sets it: more or stronger enemies, fewer reinforcements, less time or less money. Some missions have a fourth level, Real tough guy.",

  // ---- In-game settings (Esc menu, js/scale.js and js/layout.js) -----------------------
  'settings.uiScale':
    'Size of the sidebar, bars, menus and dialogs, from 50 % to 200 %; the battlefield gets the room that is left. It changes size only: how sharp the battlefield is drawn is Max resolution and Low quality.',
  'settings.gameScale':
    'How big units and terrain look, from 50 % to 300 %: the zoom Reset zoom returns to. The mouse wheel, pinch and the zoom keys zoom from there, and the zoom you last used is remembered as a share of this scale: the next game (also missions, replays and watching) starts there, and changing the scale keeps it. Reset zoom and Defaults forget it. The marks on the slider are the scales where pixel art is sharpest. Unlike Max resolution and Low quality, it changes size, not sharpness.',
  'settings.scaleAuto':
    'Auto picks the scale for your screen and picks again when the window or its pixel density changes; moving the slider turns it off. UI scale: 100 % on phones and in windows of at least 1600 x 900, smaller in smaller windows, never below 85 %, the same on retina and other screens. Game scale: 100 % at 1920 x 1080, from 85 % to 150 % for other window sizes, 100 % on phones; on sharp screens it moves to the nearest scale where pixel art is sharpest, and in windows smaller than 1920 x 1080 to the smaller one (a 14 inch MacBook gets 67 %), so small screens show more of the map.',
  'settings.zoomFactor':
    'How close the battlefield is: 1.0x is the game scale itself, higher zooms in. The mouse wheel and pinch change it too, and the next game starts at the zoom you last used.',
  'settings.pixelRatioCap':
    'Highest number of pixels the battlefield is drawn with per screen pixel. Sharp screens report 2 or 3; a lower cap is much faster on phones and slightly softer. Sharpness and speed only: sizes are UI scale and game scale.',
  'settings.lowQuality':
    'Draws the battlefield below screen resolution (0.75 pixels per screen pixel) and with fewer weather particles: faster on phones and old computers, a little softer, the same size.',
  'settings.reduceMotion':
    'Big explosions shake the camera and an atom bomb flashes the screen white, like OpenRA. On: no shaking and only a dim flash. Like the browser: on when the system asks for reduced motion.',
  'settings.fullscreen': 'Fills the screen with the game. Esc and the number keys then go to the game in browsers that allow it.',
  'settings.edgeScrollSpeed': 'How fast the map scrolls when the pointer touches an edge of the window, over the sidebar too. Off turns edge scrolling off.',
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
    'Locks the pointer to the game, like the locked cursor of desktop OpenRA, so it cannot slip onto another monitor and the screen edges always scroll. In fullscreen: when you enter fullscreen or click into the game there. Always: on every click into the game. Option+E on a Mac, Alt+Shift+E on Windows and Linux (Alt+E opens the browser menu there; rebindable in Controls) releases it and the game plays on, so you can use another monitor or app; Esc then cancels what you were doing but opens no menu until you click into the game again (the Menu button always opens it). Esc while captured releases it as before, and opening the menu, switching windows or leaving fullscreen releases it too. A click into the game captures it again.',
  'settings.mouseCaptureSpeed':
    "How fast the game cursor moves while the mouse is captured. At 1x it moves exactly like the system pointer, with your system's pointer speed and acceleration. With Raw mouse input on, 1x is one pixel per mouse count at slow speed, with the game's own acceleration on top.",
  'settings.mouseCaptureRaw':
    "Off (recommended): the captured pointer gets the same movement as the system pointer. On: the browser passes raw mouse counts without the system's acceleration where it supports that (such as Chrome and Edge; elsewhere the normal movement is used), and the game adds its own curve: slow, precise moves go one pixel per count, fast flicks up to three times as far. The change applies from the next capture.",
  'settings.errorReports':
    "When the site's operator has turned error reporting on, sends the error with the game's version, your browser and the game mode to WebRA's own Sentry (sentry.vitrion.dev) when something breaks. Never your name, chat, maps or account. Off: nothing is sent from this browser (the switch covers this browser; signed in, it syncs to your other devices). WebRA's server then reports its own errors either way, also of a request of yours that failed, without player data. The privacy notice on the website says whether reporting is on and what a report holds.",
  'settings.cloudReplays':
    'While you are signed in, the replay of every game you finish or leave (skirmish, online, missions and co-op) is uploaded to your account in the background and kept for 30 days. Your account keeps at most 100 replays and 100 MB; when a new one does not fit, the oldest go first. Watch, download or delete them from Replays on the start screen or on your account page. Online replays hold the other players\' names and the chat as you saw it. Off: nothing is uploaded from now on; replays already kept stay until they expire or you delete them.',
  'settings.perfCaptureStart':
    'Records the first 60 seconds of every game, from its first frame, as a performance capture: how long each frame, the simulation and the loading steps before it took. When it is done, the debug menu (` key) downloads it as a JSON file to send along with a report of a slow game; leaving the game downloads it too. It holds timings, your browser and graphics card, screen size, graphics settings, the map and the game options; never names, chat or your account. Nothing is sent anywhere by itself.',
  'debug.perfCapture':
    'For a game that stutters or lags: press Record performance (or Alt+P) and play on; after the chosen length, or when you press it again, the browser downloads a webra-perf JSON file. To catch the start of a game, turn on "Record the start of every game" and start the game again: the first 60 seconds are recorded and the debug menu offers the download. Leaving the game saves what was recorded. Send the file with your report (Discord, GitHub or e-mail). It holds frame times, simulation and loading times, long tasks of the browser, memory use, your browser and graphics card, screen size, graphics settings, the map name and size and the game options, with a summary at the top; never names, chat, the map itself or your account, and nothing is sent anywhere by the game.',
  'settings.mouseCaptureEscMenu':
    'Off: with the mouse captured, the first Esc only releases it and the next Esc opens the menu. On: one Esc releases the mouse and also cancels the current mode or opens the menu.',
  'settings.mouseCaptureNotice':
    'The short notice at the top of the screen when the mouse is captured, naming the key that releases it (Option+E on a Mac, Alt+Shift+E on Windows and Linux, or what you bound in Controls). Every time, only the first 3 times, or never. Phones and tablets without a mouse never capture it, so they never show it.',
  'settings.pauseWhenHidden':
    "Single player. Off (default): the game plays on while its tab or window is hidden (another tab, a minimised window), just as it does while you use another app or monitor. Browsers slow down hidden pages: the game keeps its pace where the browser lets its simulation worker run on (desktop Chromium browsers and Firefox usually do), but it can fall behind or stop where the browser suspends hidden pages (Safari, phones). Sounds of what happens meanwhile are not played; the music goes on. On: hiding the game opens the menu, which pauses it. Losing the focus to another window never pauses it either way. Online games never pause.",

  'settings.buildRightClick':
    "What a right click on a cameo in the build menu does. Picture its queue as a stack: the item being built at the bottom, each one queued later on top. Every cancel takes the top one, the most recently queued of that kind. OpenRA (default, as in OpenRA): the first right click holds the item being built; the next ones cancel from the top, so the held one goes last. WebRA: right clicks cancel from the top down to the item being built, then hold it, then cancel it. Both: when nothing is being built yet (not started, on hold or finished), a right click cancels from the top at once. Shift + right click (or a long press with Add) cancels five where a right click cancels one; middle click always cancels. Cancelling refunds what was paid.",

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
    "Select all (Q) picks your units on screen of OpenRA's highest selection priority: combat units first, then support units such as the MCV, harvesters, defences and other structures. Select by type (W) adds the units of the selected types on screen. Press either again for the whole map. A double click adds that type on screen. Rest the mouse on the battlefield for a moment and a tooltip names what is there, like OpenRA: the unit or structure and its owner, a remembered structure under the fog, ore, or Unrevealed Terrain. Selected defences, detectors, gap generators and lightning rods show their range as a dashed circle, and placing a defence shows the circles of your defences of the same kind.",

  'controls.production':
    "The build menu works like OpenRA's. Left click queues one, Shift + click five; you can queue as much as you like (up to 999 of one kind, 2000 in a tab) whether you have the credits or not. Production takes the money bit by bit as it builds: when the credits run out it waits (\"Insufficient funds\") and goes on by itself once money comes in. A red frame and a red $ on a cameo mean your credits do not cover all of its queued items yet, counting what is still to pay for it and everything ahead of it in that tab; its tooltip says how many. Right click holds or cancels (see Right click in the build menu), Shift + right click cancels five, middle click cancels at once. Cancelling refunds what was paid. On a touch screen a long press is the right click, and the Add button stands in for Shift.",

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

/**
 * The guide (game menu, Guide; js/guideview.js) and the tour in the first
 * skirmish games (js/tour.js): chapters of steps. A step has an `id` (kept
 * in the settings as guide.done, js/guide.js), a `title`, its `text`,
 * `watch` (what ticks it off by itself, shown as "Watching: ...") and, in
 * the tour's chapter, `tour` (the tour card's text). Every chapter has
 * `since`, the version that brought it; a step added to an existing chapter
 * later has its own `since` (js/guide.js: newer than the guide a player has
 * seen, it is "New" to them). Ids are never reused, also not after a step
 * goes (docs/contracts.md, "The guide and the tour"). `{key:action}` stands
 * for the key bound to that hotkey action now. The facts follow the README
 * and the engine: lightning (engine/src/lightning.rs), the ore values
 * (help `startingCash`), the countdowns (help `techLevel`), rejoining
 * (docs/contracts.md, Reconnecting); change them with the rules.
 */
export const GUIDE = Object.freeze(
  [
    {
      id: 'base',
      since: '0.17.0',
      title: 'Your first base',
      intro: 'Every game starts with a Mobile Construction Vehicle, the MCV. It becomes your Construction Yard, and everything else is built from there.',
      tip: 'Buildings must touch the area around your other buildings. Build toward the ore to keep the trucks close.',
      steps: [
        {
          id: 'base.mcv',
          title: 'Deploy the MCV',
          text: 'Select it and press Deploy ({key:deploy}), or click it again. It unfolds into the Construction Yard.',
          watch: 'MCV deployed',
          tour: 'Select your MCV and press Deploy ({key:deploy}), or click it once more. It unfolds into your Construction Yard.',
        },
        {
          id: 'base.power',
          title: 'Build a Power Plant',
          text: 'Open the Buildings tab, click Power Plant, wait for READY, then click the map near your yard to place it.',
          watch: 'Power Plant placed',
          tour: 'Click the glowing Power Plant in the sidebar. When it says READY, click the map next to your Construction Yard.',
        },
        {
          id: 'base.refinery',
          title: 'Build an Ore Refinery',
          text: 'It comes with a free Ore Truck that starts gathering at once. This is your income.',
          watch: 'Ore Refinery placed',
          tour: 'Build the glowing Ore Refinery and place it toward the ore. Its free Ore Truck starts gathering at once.',
        },
        {
          id: 'base.production',
          title: 'Build Barracks and a War Factory',
          text: 'Barracks train infantry, the War Factory builds vehicles. Both need power.',
          watch: 'Barracks and War Factory placed in one game',
          tour: 'Build Barracks for infantry and a War Factory for vehicles. Both need power.',
        },
        {
          id: 'base.radar',
          title: 'Build a Radar Dome',
          text: 'It turns on the radar minimap in the sidebar.',
          watch: 'Radar Dome placed',
          tour: 'Build a Radar Dome: it turns on the radar minimap at the top of the sidebar.',
        },
      ],
    },
    {
      id: 'ore',
      since: '0.17.0',
      title: 'Money and ore',
      intro: 'Credits pay for everything. Ore Trucks bring ore and gems to a refinery, which turns them into credits.',
      tip: 'An engineer can capture a neutral Oil Derrick: it pays a bonus when taken and a steady income after.',
      steps: [
        { id: 'ore.deliver', title: 'Keep the trucks busy', text: 'Trucks gather by themselves. Send one to a field by selecting it and clicking the ore.', watch: 'Ore delivered' },
        { id: 'ore.truck', title: 'Add a second truck', text: 'More trucks on the same refinery means more income, up to the point where they wait in line.', watch: 'Ore Truck built' },
        { id: 'ore.gems', title: 'Gems are worth more', text: 'A bale of gems pays 50 credits, a bale of ore 25. Ore fields grow back if the lobby allows it.', watch: 'Chapter read' },
        { id: 'ore.silo', title: 'Build silos', text: 'When the refinery is full you hear "Silos needed". Silos store the extra.', watch: 'Silo placed' },
      ],
    },
    {
      id: 'power',
      since: '0.17.0',
      title: 'Power',
      intro: 'Almost every building uses power. The bar at the left of the sidebar shows what you make against what you use.',
      tip: 'Power plants are a favourite target: protect them, or the enemy turns your defences off.',
      steps: [
        { id: 'power.bar', title: 'Watch the power bar', text: 'Green is fine. When the use line passes the top of the bar you are on low power.', watch: 'Chapter read' },
        { id: 'power.low', title: 'Low power hurts', text: 'Production slows down, the radar goes dark and powered defences such as the Tesla Coil stop working.', watch: 'First low power' },
        { id: 'power.more', title: 'Build more power', text: 'A Power Plant, or later an Advanced Power Plant, which makes more on the same space.', watch: 'Second Power Plant placed' },
        { id: 'power.down', title: 'Power down to save', text: 'The power button on the sidebar turns a building off, so the others keep running.', watch: 'A building powered down' },
      ],
    },
    {
      id: 'units',
      since: '0.17.0',
      title: 'Commanding units',
      intro: 'Select units by clicking them or dragging a box. Then click where they should go or what they should attack.',
      tip: 'Hover any button for a tooltip with its key. Every key can be changed under Controls.',
      steps: [
        { id: 'units.order', title: 'Move and attack', text: 'Left click the ground to move, an enemy to attack. Right click cancels.', watch: 'First order given' },
        { id: 'units.attackMove', title: 'Attack move ({key:attackMove})', text: 'Units walk to the spot and fight everything they meet on the way.', watch: 'First attack move' },
        {
          id: 'units.guard',
          title: 'Guard, Stop and Scatter',
          text: 'Guard ({key:guard}) follows and protects a unit, Stop ({key:stop}) halts, Scatter ({key:scatter}) spreads units against splash damage.',
          watch: 'Guard, Stop or Scatter used',
        },
        { id: 'units.queue', title: 'Queue with Shift', text: 'Hold Shift while clicking to add waypoints that run one after another.', watch: 'First queued waypoint' },
        { id: 'units.stance', title: 'Fire stances', text: 'The four buttons right of the commands: attack anything, defend, return fire, hold fire.', watch: 'Fire stance changed' },
      ],
    },
    {
      id: 'weather',
      since: '0.17.0',
      title: 'Weather and lightning',
      intro: 'Some maps have weather. A badge on the screen says what it does. Thunderstorms are the dangerous one.',
      tip: 'The lobby can make the weather only for show, or turn it off.',
      steps: [
        { id: 'weather.storm', title: 'Lightning halves health', text: 'A strike takes half the health of whatever it hits.', watch: 'First thunderstorm' },
        {
          id: 'weather.plants',
          title: 'It likes power plants',
          text: "Lightning prefers to strike power plants, and a hit knocks out its owner's power for 15 seconds.",
          watch: 'Chapter read',
        },
        { id: 'weather.rod', title: 'Build a Lightning Rod', text: 'It grounds every strike within 6 cells. Put one between your power plants.', watch: 'Lightning Rod placed' },
        {
          id: 'weather.other',
          title: 'Other weather',
          text: 'Bad weather shortens sight, vehicles slide on snow and ice, and in a heat wave vehicles that keep driving or firing overheat.',
          watch: 'Chapter read',
        },
      ],
    },
    {
      id: 'powers',
      since: '0.17.0',
      title: 'Superweapons',
      intro: 'Late in the game, tech buildings unlock support powers. Their countdowns show at the top left.',
      tip: 'The Iron Curtain makes units invulnerable for a while; the Chronosphere teleports them.',
      steps: [
        {
          id: 'powers.timers',
          title: 'Read the timers',
          text: "Every player sees the Atom Bomb and GPS countdowns of all players, AI players too, in each owner's colour.",
          watch: 'Chapter read',
        },
        { id: 'powers.ready', title: 'Support powers', text: 'A support power button lights up when it is ready. Click it, then click the map where it should go.', watch: 'A support power ready' },
        { id: 'powers.spread', title: 'Spread your base', text: 'Do not put everything in one spot when an enemy Atom Bomb is close to ready.', watch: 'Chapter read' },
      ],
    },
    {
      id: 'team',
      since: '0.17.0',
      title: 'Teams and online',
      intro: 'In team games allies share vision and win together. AI players are in the slot list like everyone else.',
      tip: "Spectators can watch any player's view or all of them, with statistics per team.",
      steps: [
        { id: 'team.chat', title: 'Talk to your team', text: 'Team chat ({key:openTeamChat}) only reaches allies; all chat ({key:openGeneralChat}) reaches everyone.', watch: 'First team chat' },
        { id: 'team.online', title: 'Online, the game goes on', text: 'Online the game does not pause: the menu opens over the running game.', watch: 'First online game' },
        { id: 'team.rejoin', title: 'Losing the connection', text: 'Reload within 2 minutes and you take your seat back.', watch: 'Chapter read' },
      ],
    },
  ].map((c) => Object.freeze({ ...c, steps: Object.freeze(c.steps.map((s) => Object.freeze(s))) })),
);

/** The help text of `key`; throws for an unknown key so a missing text is a bug, not a blank tooltip. */
export function helpText(key) {
  if (!Object.hasOwn(HELP, key)) throw new Error(`No help text for "${key}"`);
  return HELP[key];
}
