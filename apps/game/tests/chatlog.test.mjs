// The in-game chat and system lines (js/chatlog.js, js/chatpanel.js), the
// game clock's pause and replay status (js/gametimer.js), the audio mute
// indicator (js/muteindicator.js) and the cameo's veteran overlay
// (js/sidebar.js): OpenRA's IngameChatLogic, TextNotificationsManager,
// CommandHistory, GameTimerLogic, MuteIndicatorLogic and
// ProductionIconOverlayManager. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, FakeEvent } from './dom-fixtures.mjs';
import {
  chatPrefix,
  CommandHistory,
  formatLineTime,
  HISTORY_SIZE,
  OVERLAY_LINES,
  OVERLAY_MS,
  ReplayChat,
  SYSTEM_CLIENT,
  SYSTEM_COLOR,
  SYSTEM_LABEL,
  TextLog,
} from '../js/chatlog.js';
import { blinkOn, clockText, completeText, MAX_SPEED_TEXT, PAUSED_TEXT, replayStatus } from '../js/gametimer.js';
import { CHAT_HOTKEYS } from '../js/chatkeys.js';

test('system lines carry the Battlefield Control prefix in yellow, chat lines the player colour', () => {
  let now = 1000;
  const log = new TextLog({ now: () => now });
  const seen = [];
  log.onLine((l) => seen.push(l));
  const sys = log.system('P1 is defeated.');
  assert.equal(sys.prefix, SYSTEM_LABEL);
  assert.equal(SYSTEM_LABEL, 'Battlefield Control');
  assert.equal(sys.prefixColor, SYSTEM_COLOR);
  assert.equal(sys.textColor, SYSTEM_COLOR);
  assert.equal(sys.clientId, SYSTEM_CLIENT);
  now = 2000;
  const chat = log.chat(3, 'Alice', 'hello', 'rgb(1, 2, 3)');
  assert.equal(chat.prefixColor, 'rgb(1, 2, 3)');
  assert.equal(chat.textColor, '#ffffff');
  assert.equal(chat.time, 2000);
  const mission = log.mission('Tanya', 'Shake it baby!', '#ff0000');
  assert.equal(mission.pool, 'mission');
  assert.deepEqual(seen.map((l) => l.text), ['P1 is defeated.', 'hello', 'Shake it baby!']);
  assert.equal(log.lines.length, 3, 'every line is kept');
  assert.equal(log.add({ text: '' }), null);
});

test('chat prefixes follow OpenRA UnitOrders', () => {
  assert.equal(chatPrefix({ name: 'Alice' }), 'Alice');
  assert.equal(chatPrefix({ name: 'Alice', dead: true }), 'Alice (Dead)');
  assert.equal(chatPrefix({ name: 'Bob', spectator: true }), 'Bob (Spectator)');
  assert.equal(chatPrefix({ name: 'Alice', ally: true }), 'Alice (Ally)');
  assert.equal(chatPrefix({ name: 'Alice', dead: true, ally: true }), 'Alice (Dead) (Ally)');
  assert.equal(chatPrefix({ name: 'Alice', team: true }), '[Team] Alice');
  assert.equal(chatPrefix({ name: 'Bob', team: true, spectators: true, spectator: true }), '[Spectators] Bob');
  // The channel decides, not the sender: a defeated player's team chat is the spectators'.
  assert.equal(chatPrefix({ name: 'Alice', team: true, spectators: true, dead: true }), '[Spectators] Alice');
  assert.equal(chatPrefix({ name: 'Alice', team: true, dead: true }), '[Team] Alice', 'sent before the server knew of the defeat');
  assert.equal(chatPrefix({ name: 'Alice', team: true, replay: true, teamNumber: 2 }), '[Team 2] Alice');
});

test('muted players: their new lines are dropped, unmuting brings the next ones back', () => {
  const log = new TextLog();
  const changes = [];
  log.onMute((c, m) => changes.push([c, m]));
  assert.equal(log.isMuted(4), false);
  assert.equal(log.toggleMuted(4), true);
  assert.equal(log.chat(4, 'Eve', 'spam'), null);
  assert.ok(log.system('system lines are never muted'));
  log.setMuted(SYSTEM_CLIENT, true);
  assert.equal(log.isMuted(SYSTEM_CLIENT), false);
  log.setMuted(4, false);
  assert.ok(log.chat(4, 'Eve', 'sorry'));
  assert.deepEqual(changes, [[4, true], [4, false]]);
  assert.deepEqual(log.lines.map((l) => l.text), ['system lines are never muted', 'sorry']);
});

test('Hide chat in replays: replay chat is quiet, system lines are not', () => {
  let hide = true;
  const log = new TextLog({ replay: true, hideReplayChat: () => hide });
  assert.equal(log.chat(1, 'A', 'gg').quiet, true);
  assert.equal(log.system('A is victorious.').quiet, false);
  hide = false;
  assert.equal(log.chat(1, 'A', 'gg').quiet, false);
  assert.equal(new TextLog({ hideReplayChat: () => true }).chat(1, 'A', 'live game').quiet, false);
});

test('the chat line history works like OpenRA CommandHistory', () => {
  const h = new CommandHistory();
  assert.equal(h.previous(), null);
  assert.equal(h.next(), null);
  h.add('first');
  h.add('second');
  h.add('  ');
  h.add('first');
  assert.deepEqual(h.history, ['first', 'second'], 'newest first, repeats move to the front');
  assert.equal(h.previous(), 'first');
  assert.equal(h.previous(), 'second');
  assert.equal(h.previous(), 'second', 'stays at the oldest');
  assert.equal(h.next(), 'first');
  assert.equal(h.next(), null, 'past the newest: an empty line');
  assert.equal(h.previous(), 'first');
  h.reset();
  assert.equal(h.previous(), 'first');
  for (let i = 0; i < HISTORY_SIZE + 5; i++) h.add(`line ${i}`);
  assert.equal(h.history.length, HISTORY_SIZE);
});

test('line times are local HH:MM', () => {
  assert.equal(formatLineTime(new Date(2026, 0, 2, 7, 5).getTime()), '07:05');
});

test('replay chat appears as the replay passes it, not while seeking', () => {
  const log = new TextLog({ replay: true });
  const lines = [
    [10, 0, 'Alice', 'hi', 0],
    [20, 1, 'Bob', 'team plan', 1],
    [30, -1, 'Watcher', 'nice', 2],
    [40, 0, 'Alice', 'gg', 0],
  ];
  const rc = new ReplayChat(lines, log, { teamOf: (p) => p + 1, colorOf: (p) => `c${p}`, dead: (p) => p === 0 });
  rc.advance(5);
  assert.equal(log.lines.length, 0);
  rc.advance(25);
  assert.deepEqual(log.lines.map((l) => [l.prefix, l.text, l.prefixColor]), [
    ['Alice (Dead)', 'hi', 'c0'],
    ['[Team 2] Bob', 'team plan', 'c1'],
  ]);
  // A seek forward skips the lines it jumps over.
  rc.advance(35, true);
  rc.advance(36);
  assert.equal(log.lines.length, 2);
  rc.advance(40);
  assert.equal(log.lines.at(-1).text, 'gg');
  // Back to the start: lines come again as the replay passes them.
  rc.advance(0);
  rc.advance(31);
  assert.deepEqual(log.lines.slice(-3).map((l) => l.prefix), ['Alice (Dead)', '[Team 2] Bob', '[Spectators] Watcher']);
});

// ---- The panel -------------------------------------------------------------------------

function keydown(target, key, init = {}) {
  const e = new FakeEvent('keydown', { key, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

async function panel(opts = {}) {
  const doc = installDom({ windowEvents: true });
  const { ChatPanel } = await import('../js/chatpanel.js');
  const field = doc.createElement('div');
  doc.body.append(field);
  let now = opts.start ?? 100_000;
  const log = opts.log ?? new TextLog({ now: () => now });
  const sounds = [];
  const sent = [];
  const registered = [];
  const hotkeys = {
    registerAction(name, keys, handler, o) {
      registered.push({ name, handler, o });
      return () => {};
    },
  };
  const p = new ChatPanel(field, {
    log,
    hotkeys,
    send: opts.offline ? null : (text, team) => sent.push([text, team]),
    teamChat: opts.teamChat ?? false,
    names: ['Alice', 'Bob'],
    mutable: opts.mutable ?? (() => []),
    sound: () => sounds.push(1),
    withTime: opts.withTime ?? true,
    now: () => now,
    autoPrune: false,
  });
  return { doc, p, log, sounds, sent, registered, setNow: (v) => (now = v), byName: (n) => registered.find((r) => r.name === n) };
}

test('overlay: the newest eight lines, each for OpenRA\'s ten seconds; connection lines stay', async () => {
  const { p, log, sounds, setNow } = await panel();
  for (let i = 0; i < OVERLAY_LINES + 2; i++) log.system(`line ${i}`);
  assert.equal(p.overlay.children.length, OVERLAY_LINES);
  assert.equal(p.overlay.children[0].textContent, `${SYSTEM_LABEL}:line 2`);
  assert.equal(sounds.length, OVERLAY_LINES + 2, 'ChatLine for each line');
  assert.equal(p.scroll.children.length, OVERLAY_LINES + 2, 'the scrollback keeps every line');
  log.system('Connection lost.', { important: true });
  setNow(100_000 + OVERLAY_MS - 1);
  p.prune();
  assert.equal(p.overlay.children.length, OVERLAY_LINES);
  setNow(100_000 + OVERLAY_MS);
  p.prune();
  assert.deepEqual(p.overlay.children.map((c) => c.textContent), [`${SYSTEM_LABEL}:Connection lost.`]);
  uninstallDom();
});

test('a line shows the TIME label in the scrollback only, and the prefix in its colour', async () => {
  const { p, log } = await panel();
  log.chat(2, '[Team] Alice', 'go', 'rgb(9, 8, 7)');
  const row = p.scroll.children[0];
  assert.equal(row.querySelector('.chat-time').textContent, formatLineTime(100_000));
  assert.equal(row.querySelector('.chat-prefix').textContent, '[Team] Alice:');
  assert.equal(p.overlay.children[0].querySelector('.chat-time'), null);
  uninstallDom();
  const replay = await panel({ withTime: false });
  replay.log.system('x');
  assert.equal(replay.p.scroll.children[0].querySelector('.chat-time'), null, 'no TIME in replays');
  uninstallDom();
});

test('the chat keys open the panel; Enter sends, Esc closes, Up and Down recall sent lines', async () => {
  const { doc, p, sent, byName, registered } = await panel({ teamChat: true });
  assert.deepEqual(registered.map((r) => r.name), CHAT_HOTKEYS.map((h) => h.name));
  assert.equal(byName('openTeamChat').o.openra, 'OpenTeamChat');
  byName('openTeamChat').handler();
  assert.equal(p.isOpen, true);
  assert.equal(p.overlay.hidden, true, 'the overlay hides while the panel is open');
  assert.equal(doc.activeElement, p.input);
  assert.equal(p.mode, 'team');
  assert.equal(p.modeButton.textContent, 'Team');
  p.input.value = 'attack north';
  keydown(p.input, 'Enter');
  assert.deepEqual(sent, [['attack north', true]]);
  assert.equal(p.isOpen, false);
  byName('openGeneralChat').handler();
  assert.equal(p.mode, 'all');
  keydown(p.input, 'Tab', { shiftKey: true });
  assert.equal(p.mode, 'team', 'Shift+Tab switches');
  p.modeButton.click();
  assert.equal(p.mode, 'all', 'so does the mode button');
  keydown(p.input, 'ArrowUp');
  assert.equal(p.input.value, 'attack north');
  keydown(p.input, 'ArrowDown');
  assert.equal(p.input.value, '');
  p.input.value = 'Al';
  keydown(p.input, 'Tab');
  assert.equal(p.input.value, 'Alice', 'Tab completes a name');
  keydown(p.input, 'Escape');
  assert.equal(p.isOpen, false);
  assert.equal(sent.length, 1);
  uninstallDom();
});

test('without anyone to talk to the panel shows the history with the line off; Enter or Esc closes it', async () => {
  const { doc, p, log, byName } = await panel({ offline: true });
  log.system('P2 is defeated.');
  byName('openTeamChat').handler();
  assert.equal(p.isOpen, true);
  assert.equal(p.input.disabled, true);
  assert.equal(p.modeButton.disabled, true);
  assert.equal(doc.activeElement, p.scroll);
  assert.equal(p.scroll.children.length, 1);
  keydown(p.scroll, 'Enter');
  assert.equal(p.isOpen, false);
  byName('openGeneralChat').handler();
  keydown(p.scroll, 'Escape');
  assert.equal(p.isOpen, false);
  uninstallDom();
});

test('Esc closes the open panel wherever the focus is, before the game sees it', async () => {
  const { doc, p, byName } = await panel();
  const game = [];
  // js/input.js listens on the window: Esc cancels a mode or opens the menu.
  window.addEventListener('keydown', (e) => game.push(e.key));
  byName('openGeneralChat').handler();
  // A click on the battlefield took the focus from the chat line.
  p.input.blur();
  const canvas = doc.createElement('canvas');
  doc.body.append(canvas);
  const esc = keydown(canvas, 'Escape');
  assert.equal(p.isOpen, false, 'the panel closed');
  assert.ok(esc.defaultPrevented);
  assert.deepEqual(game, [], 'the game did not get it (no menu)');
  // Closed: Esc is the game's again (cancel a mode, the menu, its mouse capture setting).
  keydown(canvas, 'Escape');
  assert.deepEqual(game, ['Escape']);
  // Typing in the chat line: its own Esc closes, nothing reaches the game either.
  byName('openGeneralChat').handler();
  keydown(p.input, 'Escape');
  assert.equal(p.isOpen, false);
  assert.deepEqual(game, ['Escape']);
  // Other keys go on to the game while the panel is open.
  byName('openGeneralChat').handler();
  p.input.blur();
  keydown(canvas, 'a');
  assert.equal(p.isOpen, true);
  assert.deepEqual(game, ['Escape', 'a']);
  p.dispose();
  keydown(canvas, 'Escape');
  assert.deepEqual(game, ['Escape', 'a', 'Escape'], 'no listener left after dispose');
  uninstallDom();
});

test('a defeated player chats with the spectators; nobody has team chat once the game is over', async () => {
  const { p, byName } = await panel({ teamChat: false });
  byName('openTeamChat').handler();
  assert.equal(p.mode, 'all', 'no team mate: all chat');
  keydown(p.input, 'Escape');
  p.setTeamChat(true, true);
  byName('openTeamChat').handler();
  assert.equal(p.mode, 'team');
  assert.match(p.input.placeholder, /^Spectators:/);
  assert.equal(p.modeButton.disabled, false);
  p.setTeamChat(false, true);
  assert.equal(p.mode, 'all', 'the game is over: back to all chat');
  assert.equal(p.modeButton.disabled, true);
  uninstallDom();
});

test('replay chat hidden by the setting stays off the overlay and silent', async () => {
  const log = new TextLog({ replay: true, hideReplayChat: () => true });
  const { p, sounds } = await panel({ log });
  log.chat('player:0', 'Alice', 'hi');
  assert.equal(p.overlay.children.length, 0);
  assert.equal(sounds.length, 0);
  assert.equal(p.scroll.children.length, 1);
  log.system('Alice is victorious.');
  assert.equal(p.overlay.children.length, 1);
  assert.equal(sounds.length, 1);
  uninstallDom();
});

test('the open panel lists the other people with a mute toggle', async () => {
  const people = [
    { client: 2, name: 'Bob' },
    { client: 7, name: 'Watcher' },
  ];
  const { p, log, byName } = await panel({ mutable: () => people });
  byName('openGeneralChat').handler();
  assert.equal(p.muteBar.hidden, false);
  const buttons = () => [...p.muteBar.querySelectorAll('.chat-mute-button')];
  assert.deepEqual(buttons().map((b) => b.textContent), ['Mute Bob', 'Mute Watcher']);
  buttons()[0].click();
  assert.equal(log.isMuted(2), true);
  assert.equal(buttons()[0].textContent, 'Unmute Bob');
  assert.equal(buttons()[0].getAttribute('aria-pressed'), 'true');
  assert.equal(log.chat(2, 'Bob', 'ignored'), null);
  assert.equal(p.scroll.children.length, 0);
  // The API other panels use (the game info player list) updates the toggles too.
  log.setMuted(2, false);
  assert.equal(buttons()[0].textContent, 'Mute Bob');
  uninstallDom();
  const alone = await panel();
  alone.byName('openGeneralChat').handler();
  assert.equal(alone.p.muteBar.hidden, true);
  uninstallDom();
});

test('lines from before the panel: all in the scrollback, the recent ones on the overlay', async () => {
  let now = 0;
  const log = new TextLog({ now: () => now });
  log.system('old');
  now = 50_000;
  log.system('fresh');
  const { p } = await panel({ log, start: 55_000 });
  assert.equal(p.scroll.children.length, 2);
  assert.deepEqual(p.overlay.children.map((c) => c.textContent), [`${SYSTEM_LABEL}:fresh`]);
  uninstallDom();
});

// ---- Game clock (GameTimerLogic) ----------------------------------------------------------

test('the clock blinks Paused every other second; replays show their speed', () => {
  assert.equal(blinkOn(1000, 1000), true);
  assert.equal(blinkOn(1999, 1000), true);
  assert.equal(blinkOn(2000, 1000), false);
  assert.equal(blinkOn(3000, 1000), true);
  assert.equal(clockText('1:05', true, true), PAUSED_TEXT);
  assert.equal(clockText('1:05', true, false), '1:05');
  assert.equal(clockText('1:05', false, true), '1:05');
  assert.equal(replayStatus({ playing: false, speed: 2, maxSpeed: 8 }), 'Paused');
  assert.equal(replayStatus({ playing: true, speed: 1, maxSpeed: 8 }), null);
  assert.equal(replayStatus({ playing: true, speed: 0.5, maxSpeed: 8 }), '50% Speed');
  assert.equal(replayStatus({ playing: true, speed: 2, maxSpeed: 8 }), '200% Speed');
  assert.equal(replayStatus({ playing: true, speed: 8, maxSpeed: 8 }), MAX_SPEED_TEXT);
  assert.equal(completeText(250, 1000), '25% complete');
  assert.equal(completeText(999, 1000), '99% complete');
  assert.equal(completeText(5, 0), null);
});

test('the replay bar shows the blinking status and the completion tooltip', async () => {
  installDom();
  const { ReplayBar } = await import('../js/records.js');
  let now = 0;
  const c = { ticks: 300, length: 1200, playing: true, speed: 4, ended: false, seeking: false, target: null, diverged: null, setSpeed() {}, togglePlay() {}, seek() {} };
  const bar = new ReplayBar(document.createElement('div'), c, { now: () => now });
  assert.equal(bar.status.textContent, '400% Speed');
  assert.equal(bar.time.title, '25% complete');
  now = 1000;
  bar.update();
  assert.equal(bar.status.textContent, '', 'blinks off');
  now = 2000;
  c.playing = false;
  bar.update();
  assert.equal(bar.status.textContent, 'Paused');
  c.ended = true;
  bar.update();
  assert.equal(bar.status.textContent, '');
  uninstallDom();
});

test('the sidebar clock says Paused in the blink while the game is paused', async () => {
  installDom();
  const { Sidebar } = await import('../js/sidebar.js');
  let now = 0;
  const fake = { state: { tick: 25 * 65 }, ticksPerSecond: 25, now: () => now, clockStart: 0, paused: false, clockEl: document.createElement('time') };
  Sidebar.prototype.updateClock.call(fake);
  assert.equal(fake.clockEl.textContent, '01:05');
  Sidebar.prototype.setPaused.call(Object.assign(fake, { updateClock: Sidebar.prototype.updateClock }), true);
  assert.equal(fake.clockEl.textContent, 'Paused');
  now = 1500;
  fake.updateClock();
  assert.equal(fake.clockEl.textContent, '01:05');
  uninstallDom();
});

// ---- Production cameo overlay (ProductionIconOverlayManager) ---------------------------------

test('a cameo shows the veteran chevron while its unit comes out with a level', async () => {
  installDom();
  const { Sidebar } = await import('../js/sidebar.js');
  const btn = document.createElement('button');
  const c = { btn, veteran: document.createElement('span'), overlays: '', req: document.createElement('span'), slot: document.createElement('span'), reqText: '', slotText: '' };
  const self = { slotKey: () => '' };
  Sidebar.prototype.updateRequirements.call(self, c, { enabled: true, requires: [], overlays: ['Veterancy'] }, 0);
  assert.equal(c.veteran.hidden, false);
  assert.ok(btn.classList.contains('veteran'));
  Sidebar.prototype.updateRequirements.call(self, c, { enabled: true, requires: [], overlays: [] }, 0);
  assert.equal(c.veteran.hidden, true);
  assert.equal(btn.classList.contains('veteran'), false);
  uninstallDom();
});

// ---- Audio Muted (MUTE_INDICATOR) ----------------------------------------------------------

test('the mute indicator shows while all sound is off', async () => {
  installDom();
  const { MuteIndicator, MUTE_TEXT } = await import('../js/muteindicator.js');
  let muted = false;
  const listeners = new Set();
  const row = document.createElement('div');
  const ind = new MuteIndicator(row, {
    muted: () => muted,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
  assert.equal(MUTE_TEXT, 'Audio Muted');
  assert.equal(ind.root.hidden, true);
  assert.equal(row.children[0], ind.root, 'first in the HUD row');
  muted = true;
  for (const fn of listeners) fn();
  assert.equal(ind.root.hidden, false);
  assert.match(ind.root.textContent, /Audio Muted/);
  ind.dispose();
  assert.equal(listeners.size, 0);
  uninstallDom();
});
