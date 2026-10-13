// The game menu's game info (OpenRA ingame-info.yaml GAME_INFO_PANEL,
// GameInfoLogic): the map's title over tabs
//
// - Objectives: in a skirmish OpenRA's SKIRMISH_STATS (GameInfoStatsLogic):
//   the local player's mission ("Destroy all opposition!" of
//   ConquestVictoryConditions) with its status, and every player's score
//   (PlayerStatistics experience) grouped by team, the teams with the most
//   score first, then the spectators. In a mission OpenRA's MISSION_OBJECTIVES
//   (GameInfoObjectivesLogic): the mission status and the objectives, from the
//   mission's own state (js/campaign/view.js shows the same list on the HUD)
// - Briefing (MAP_PANEL, GameInfoBriefingLogic): the map preview and the
//   mission briefing, or a map file's description; only when there is one
// - Options (LOBBY_OPTIONS_PANEL): the lobby options the game is played
//   with, read only
//
// A player still in the game sees no more than OpenRA shows it: names,
// teams, scores and win states of everyone, the real country only of itself
// and its allies (the others show the lobby's choice, "Random" for a random
// pick) until its own game is decided. Spectators and replays see every
// country. The full statistics (js/stats.js) stay for those who watch.
//
// OpenRA's Debug and Chat tabs are WebRA's debug menu and chat; the per
// player Mute and Kick buttons are not here (no in-game kick in WebRA).
//
// The models are pure (Node tests); renderGameInfo draws one into the menu.

import { objectiveLabel } from './campaign/view.js';
import { BIOMES, FACTIONS, LOBBY_SELECT_OPTIONS, LOBBY_TOGGLE_OPTIONS, MAP_SIZES, MAP_STYLES, TECH_BUILDINGS, WEATHER_MODES } from './lobby-state.js';

/** ConquestVictoryConditionsInfo.Objective (checkbox-stats-objective). */
export const CONQUEST_OBJECTIVE = 'Destroy all opposition!';

/** OpenRA label-mission-in-progress / -accomplished / -failed. */
export const MISSION_STATUS = Object.freeze({ playing: 'In progress', won: 'Accomplished', lost: 'Failed' });

/** WidgetUtils.WithSuffix: a player's name with its win state. */
const NAME_SUFFIX = { won: ' (Won)', lost: ' (Lost)', playing: '' };

/** A player's WinState from its statistics row (engine observer_stats). */
export function winState(row) {
  if (row?.won) return 'won';
  if (row?.defeated) return 'lost';
  return 'playing';
}

/** A faction's name for people ("random" is "Random"). */
export function factionLabel(value) {
  if (!value) return 'Unknown';
  return FACTIONS.get(value)?.label ?? value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * GameInfoLogic's tabs, in its order: Objectives (OpenRA always has an
 * objectives panel in Red Alert), Briefing when there is a text, Options.
 */
export function infoTabs({ briefing } = {}) {
  return [['objectives', 'Objectives'], ...(briefing ? [['briefing', 'Briefing']] : []), ['options', 'Options']];
}

/**
 * The SKIRMISH_STATS panel. `stats`: engine observer_stats rows (non-neutral
 * players); `names`: player names by engine index; `localPlayer`: this
 * screen's player, or null for spectators and replays; `allied(a, b)`;
 * `lobbyFactions`: what the lobby showed per player (the choice before a
 * random country was drawn), or null when that is unknown (a rejoin that saw
 * no lobby, a loaded save): then opponents show "Unknown" until the local
 * player's game is decided, never the drawn country; `spectators`: names.
 */
export function skirmishStats({ stats = [], names = [], localPlayer = null, allied = (a, b) => a === b, lobbyFactions = null, spectators = [] }) {
  const rows = (stats ?? []).filter((r) => Number.isInteger(r?.player));
  const local = localPlayer === null ? null : rows.find((r) => r.player === localPlayer);
  const localState = local ? winState(local) : null;
  // GameInfoStatsLogic: the real country for spectators, allies, and once the local player's game is decided.
  const revealAll = localPlayer === null || localState !== 'playing';
  const players = rows.map((r) => {
    const real = factionLabel(r.faction);
    const chosen = lobbyFactions?.[r.player] ?? null;
    const shown = chosen == null ? 'Unknown' : factionLabel(chosen);
    let faction;
    if (revealAll || allied(localPlayer, r.player)) faction = chosen == null || shown === real ? real : `${shown} (${real})`;
    else faction = shown;
    const state = winState(r);
    return {
      player: r.player,
      name: `${names[r.player] ?? `Player ${r.player + 1}`}${NAME_SUFFIX[state]}`,
      state,
      faction,
      score: Number(r.experience) || 0,
      team: Number(r.team) || 0,
    };
  });
  // OrderByDescending(experience).GroupBy(team).OrderByDescending(sum): stable, first appearance keeps its place.
  const sorted = players.map((p, i) => [p, i]).sort((a, b) => b[0].score - a[0].score || a[1] - b[1]).map(([p]) => p);
  const groups = [];
  for (const p of sorted) {
    let g = groups.find((x) => x.team === p.team);
    if (!g) groups.push((g = { team: p.team, players: [], score: 0 }));
    g.players.push(p);
    g.score += p.score;
  }
  const ordered = groups.map((g, i) => [g, i]).sort((a, b) => b[0].score - a[0].score || a[1] - b[1]).map(([g]) => g);
  // Team headers only when there is more than one group (label-team-name, label-no-team).
  for (const g of ordered) g.label = ordered.length > 1 ? (g.team > 0 ? `Team ${g.team}` : 'No Team') : null;
  return {
    kind: 'skirmish',
    objective: local ? { text: CONQUEST_OBJECTIVE, state: localState, status: MISSION_STATUS[localState] } : null,
    groups: ordered,
    spectators: [...spectators],
  };
}

/**
 * The MISSION_OBJECTIVES panel from the engine's mission_state (the local
 * player's objectives): primary objectives first (OpenRA orders by type),
 * the status from the local player's win state.
 */
export function missionObjectives(state, { defeated = false, won = false } = {}) {
  const s = won || state?.result === 'won' ? 'won' : defeated || state?.result === 'lost' ? 'lost' : 'playing';
  const list = (state?.objectives ?? []).map((o, i) => [o, i]);
  list.sort((a, b) => objectiveLabel(a[0]).localeCompare(objectiveLabel(b[0])) || a[1] - b[1]);
  return {
    kind: 'mission',
    state: s,
    status: MISSION_STATUS[s],
    error: state?.error ?? null,
    objectives: list.map(([o]) => ({ type: objectiveLabel(o), description: o.description, state: o.state })),
  };
}

const choice = (list, v) => list.find((c) => c.value === v)?.label ?? String(v);

/**
 * The lobby options the game runs with (LOBBY_OPTIONS_PANEL, disabled):
 * `options` the game's lobby options; `generated` whether the map was
 * generated (then its size, style, biome and tech buildings count);
 * `missionOptions` a mission's `{ key: { label, values, default } }` with
 * `missionValues` the chosen ones. Returns `{ selects: [{ label, value }],
 * toggles: [{ label, on }] }`.
 */
export function optionRows({ options = null, generated = false, missionOptions = null, missionValues = {}, gameSpeed = null } = {}) {
  const selects = [];
  const toggles = [];
  if (missionOptions) {
    for (const [key, o] of Object.entries(missionOptions)) {
      const v = missionValues?.[key] ?? o.default;
      selects.push({ label: o.label ?? key, value: o.values?.find(([x]) => x === v)?.[1] ?? String(v) });
    }
    if (gameSpeed) selects.push({ label: 'Game speed', value: choice(LOBBY_SELECT_OPTIONS.find((s) => s.key === 'gameSpeed').choices, gameSpeed) });
    return { selects, toggles };
  }
  if (!options) return { selects, toggles };
  if (generated) {
    selects.push({ label: 'Map size', value: choice(MAP_SIZES, options.mapSize) });
    selects.push({ label: 'Map style', value: choice(MAP_STYLES, options.mapStyle) });
    selects.push({ label: 'Biome', value: choice(BIOMES, options.biome) });
    selects.push({ label: 'Tech buildings', value: choice(TECH_BUILDINGS, options.techBuildings ?? 'standard') });
  }
  if (options.weather !== undefined) selects.push({ label: 'Weather', value: choice(WEATHER_MODES, options.weather) });
  for (const s of LOBBY_SELECT_OPTIONS) {
    if (options[s.key] === undefined) continue;
    const v = options[s.key];
    selects.push({ label: s.label, value: s.choices.find((c) => (typeof c === 'object' ? c.value : c) === v)?.label ?? String(v) });
  }
  for (const t of LOBBY_TOGGLE_OPTIONS) if (options[t.key] !== undefined) toggles.push({ label: t.label, on: !!options[t.key] });
  return { selects, toggles };
}

// ---- Drawing ---------------------------------------------------------------------------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A tick, a cross or an empty box (OpenRA's checkbox with its "tick" and "cross" marks). */
function mark(state) {
  const m = el('span', `game-info-mark game-info-mark-${state}`, state === 'completed' || state === 'won' ? '✓' : state === 'failed' || state === 'lost' ? '✗' : '');
  m.setAttribute('aria-hidden', 'true');
  return m;
}

function statusLine(state, status) {
  const p = el('p', 'game-info-status');
  const s = el('strong', `game-info-state game-info-state-${state}`, status);
  p.append(el('span', null, 'Mission: '), s);
  return p;
}

function renderSkirmish(panel, m) {
  if (m.objective) {
    panel.append(statusLine(m.objective.state, m.objective.status));
    const row = el('p', 'game-info-objective');
    row.dataset.state = m.objective.state;
    row.append(mark(m.objective.state), el('span', null, m.objective.text));
    panel.append(row);
  }
  const scroll = el('div', 'stats-scroll');
  const t = el('table', 'stats-table game-info-players');
  t.append(el('caption', null, 'Players'));
  const head = el('tr');
  for (const [text, cls] of [['Player', null], ['Faction', null], ['Score', 'num']]) {
    const th = el('th', cls, text);
    th.setAttribute('scope', 'col');
    head.append(th);
  }
  const thead = el('thead');
  thead.append(head);
  t.append(thead);
  for (const g of m.groups) {
    const tbody = el('tbody');
    if (g.label) {
      const tr = el('tr', 'game-info-team');
      const th = el('th', null, g.label);
      th.setAttribute('scope', 'rowgroup');
      th.colSpan = 2;
      tr.append(th, el('td', 'num', String(g.score)));
      tbody.append(tr);
    }
    for (const p of g.players) {
      const tr = el('tr');
      tr.dataset.state = p.state;
      tr.dataset.player = String(p.player);
      const th = el('th', 'game-info-name', p.name);
      th.setAttribute('scope', 'row');
      tr.append(th, el('td', null, p.faction), el('td', 'num', String(p.score)));
      tbody.append(tr);
    }
    t.append(tbody);
  }
  if (m.spectators.length) {
    const tbody = el('tbody');
    const tr = el('tr', 'game-info-team');
    const th = el('th', null, 'Spectators');
    th.setAttribute('scope', 'rowgroup');
    th.colSpan = 3;
    tr.append(th);
    tbody.append(tr);
    for (const name of m.spectators) {
      const row = el('tr');
      const cell = el('th', 'game-info-name', name);
      cell.setAttribute('scope', 'row');
      cell.colSpan = 3;
      row.append(cell);
      tbody.append(row);
    }
    t.append(tbody);
  }
  scroll.append(t);
  panel.append(scroll);
}

function renderMission(panel, m) {
  panel.append(statusLine(m.state, m.status));
  if (m.error) panel.append(el('p', 'hint game-info-error', `The mission's script stopped: ${m.error}`));
  if (!m.objectives.length) {
    panel.append(el('p', 'hint', 'No objectives yet.'));
    return;
  }
  const list = el('ul', 'game-info-objectives');
  for (const o of m.objectives) {
    const li = el('li', 'game-info-objective');
    li.dataset.state = o.state;
    const body = el('span');
    const done = o.state === 'completed' ? ', completed' : o.state === 'failed' ? ', failed' : '';
    body.append(el('span', 'game-info-objective-type', `${o.type}${done}: `), el('span', null, o.description));
    li.append(mark(o.state), body);
    list.append(li);
  }
  panel.append(list);
}

function renderBriefing(panel, b) {
  if (b.preview?.rgba && b.preview.width > 0) {
    const { rgba, width } = b.preview;
    const height = Math.floor(rgba.length / 4 / width);
    const canvas = el('canvas', 'game-info-preview');
    canvas.width = width;
    canvas.height = height;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Map of ${b.title}`);
    const ctx = canvas.getContext?.('2d');
    if (ctx && typeof ImageData !== 'undefined' && height > 0) ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer ?? rgba, rgba.byteOffset ?? 0, width * height * 4), width, height), 0, 0);
    panel.append(canvas);
  }
  panel.append(el('h2', null, b.title));
  if (b.author) panel.append(el('p', 'hint', `By ${b.author}`));
  const text = el('div', 'game-info-briefing');
  for (const para of String(b.text).split(/\n{2,}/)) text.append(el('p', null, para));
  panel.append(text);
}

function renderOptions(panel, o) {
  if (!o.selects.length && !o.toggles.length) {
    panel.append(el('p', 'hint', 'This game has no lobby options.'));
    return;
  }
  const dl = el('dl', 'game-info-options');
  for (const s of o.selects) dl.append(el('dt', null, s.label), el('dd', null, s.value));
  for (const t of o.toggles) dl.append(el('dt', null, t.label), el('dd', t.on ? 'game-info-on' : 'game-info-off', t.on ? 'On' : 'Off'));
  panel.append(dl);
}

/**
 * Draw the panel for `view` (`{ title, briefing, options, objectives }`) into
 * `c`, `tab` open; `onTab(id)` switches. Returns the tab shown.
 */
export function renderGameInfo(c, view, tab, onTab) {
  const tabs = infoTabs(view);
  const shown = tabs.some(([id]) => id === tab) ? tab : tabs[0][0];
  c.append(el('h1', null, view.title));
  const bar = el('div', 'stats-tabs');
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', 'Game info');
  for (const [id, label] of tabs) {
    const b = el('button', 'stats-tab', label);
    b.type = 'button';
    b.id = `game-info-tab-${id}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(id === shown));
    b.setAttribute('aria-controls', 'game-info-panel');
    b.tabIndex = id === shown ? 0 : -1;
    b.addEventListener('click', () => onTab(id));
    b.addEventListener('keydown', (e) => {
      const i = tabs.findIndex(([t]) => t === id);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      onTab(tabs[(next + tabs.length) % tabs.length][0], true);
    });
    bar.append(b);
  }
  const panel = el('div', 'game-menu-scroll game-info-panel');
  panel.id = 'game-info-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', `game-info-tab-${shown}`);
  if (shown === 'briefing') renderBriefing(panel, view.briefing);
  else if (shown === 'options') renderOptions(panel, view.options);
  else if (view.objectives?.kind === 'mission') renderMission(panel, view.objectives);
  else if (view.objectives) renderSkirmish(panel, view.objectives);
  c.append(bar, panel);
  return shown;
}
