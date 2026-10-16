// Saves and replays in the UI: the start screen's Load game and Replays
// entries with their screens (the LoadGame board: tabs, a list of rows with
// a picture, the chosen one's details; Replays lists the replays kept in the
// signed-in account, js/account/replays.js, in the same rows, next to
// opening a file), the game menu's record actions, the replay viewer's
// control bar (the Replay board's transport: play, speed, the seek bar with
// marks, time, Download and Exit), and the progress overlay shown while a
// game fast-forwards (loading a save, rejoining an online game, seeking in a
// replay).
//
// Replay and save files are user files: every one goes through the
// protocol's parseReplay (size, schema, map hash) before anything uses it,
// and a modded map asks for the usual warning first (main.js acceptMap).

import { formatTicks, recordFileName, REPLAY_SPEEDS } from './replay.js';
import { downloadText, pickFile, readFileText, SaveStore, validThumb } from './saves.js';
import { encodeReplay, MODDED_WARNING, parseReplay } from './protocol.js';
import { badge, led, setLed, styleSlider, syncSliderFill, tabs } from './ui/controls.js';
import { blinkOn, completeText, replayStatus } from './gametimer.js';
import { durationText, MODE_LABELS, playersText, replayFacts, replayMeta, usageShare, usageText } from './account/replays.js';
import { MARK_KINDS, ReplayMarks } from './replaymarks.js';
import { controlOwnsKey } from './ownkeys.js';
import { attachTooltip } from './ui/tooltip.js';

export { ObserverPanel, OBSERVER_VIEW, viewOnly } from './observer.js';

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text, className, onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

let dialogs = 0;

/**
 * A modal dialog; `build(body, close, head)` fills it (`head`: the title's
 * row, where a screen puts its tabs). Resolves with what close() got (null on Esc).
 * `screen`: a screen card the size of the window (css/records.css .records-screen) instead of
 * a compact dialog, for lists such as Load game.
 */
export function dialog(title, build, { screen = false } = {}) {
  return new Promise((resolve) => {
    const d = el('dialog', screen ? 'records-dialog records-screen' : 'records-dialog');
    const head = el('div', 'records-dialog-head');
    const heading = el('h2', 'records-dialog-title', title);
    heading.id = `records-title-${++dialogs}`;
    d.setAttribute('aria-labelledby', heading.id);
    head.append(heading);
    d.append(head);
    const body = el('div', 'records-dialog-body');
    d.append(body);
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      d.close();
      d.remove();
      resolve(value);
    };
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      // Esc from inside an open select list is that list's (js/ownkeys.js).
      if (controlOwnsKey(document.activeElement)) return;
      close(null);
    });
    build(body, close, head);
    document.body.append(d);
    d.showModal();
  });
}

/**
 * The modded-map warning with what the map's rules change (`changes`, lines
 * of js/maprules.js); resolves true only when the player accepts.
 */
export function confirmModdedMap(mapName, changes = []) {
  return dialog('Modded map', (body, close) => {
    body.append(el('p', 'records-warning', MODDED_WARNING), el('p', 'records-muted', `Map: ${mapName}`));
    if (changes.length) {
      const list = el('ul', 'records-modded-rules');
      list.setAttribute('aria-label', 'Rules this map changes');
      for (const line of changes) list.append(el('li', null, line));
      body.append(list);
    }
    const row = el('div', 'records-actions');
    row.append(button('Decline', null, () => close(false)), button('Accept and play', 'records-danger', () => close(true)));
    body.append(row);
  }).then((v) => v === true);
}

/**
 * Read and validate a replay or save file. Resolves { ok, replay } or { ok: false, error }.
 * A file of another build (`version`) resolves with its header only and `foreign`
 * (js/replay.js engineMismatch then explains it).
 */
export async function openRecordFile(file, version = null) {
  try {
    const r = await parseReplay(await readFileText(file), { version });
    return r.ok ? r : { ok: false, error: `This file cannot be used: ${r.error}.` };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

/** The same check for a replay's text (a replay kept in the account). */
export async function openRecordText(textValue, version = null) {
  try {
    const r = await parseReplay(textValue, { version });
    return r.ok ? r : { ok: false, error: `This replay cannot be used: ${r.error}.` };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}


const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** "today 21:14", "yesterday", "12 Oct", "12 Oct 2025": when a save or replay was made, in local time. */
export function shortDate(ms, now = Date.now()) {
  const d = new Date(ms);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = new Date(ms);
  start.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - start.getTime()) / DAY_MS);
  if (days === 0) return `today ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (days === 1) return 'yesterday';
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === today.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "4 players" ("1 player"); '' without any (a campaign mission). */
export function playerCount(players) {
  const n = players?.length ?? 0;
  return n ? `${n} ${n === 1 ? 'player' : 'players'}` : '';
}

/**
 * The row line of a save: mode, map (a mission's title when `missionTitle`
 * knows it) and players or difficulty ("Skirmish · Ore Lord · 4 players",
 * "Mission · Tanya's Tale · Hard"). Saves of older versions have no summary: the mode only.
 */
export function saveMeta(save, missionTitle = null) {
  const mode = MODE_LABELS[save.mode] ?? save.mode;
  const s = save.summary;
  if (!s) return mode;
  if (s.mission) return [mode, missionTitle ?? s.mission.id, capital(s.mission.difficulty ?? '')].filter(Boolean).join(' · ');
  return [mode, s.mapName, playerCount(s.players)].filter(Boolean).join(' · ');
}

/** The facts the Load game screen lists for the chosen save, as `[label, value]` pairs. */
export function saveFacts(save, missionTitle = null) {
  const s = save.summary;
  const who = s ? playersText(s.players ?? []) : '';
  return [
    ...(s ? [[s.mission ? 'Mission' : 'Map', s.mission ? (missionTitle ?? s.mission.id) : s.mapName]] : []),
    ...(s?.mission?.difficulty ? [['Difficulty', capital(s.mission.difficulty)]] : []),
    ['Mode', MODE_LABELS[save.mode] ?? save.mode],
    ...(who ? [['Players', who]] : []),
    ['Game time', formatTicks(save.ticks)],
    ['Saved', new Date(save.createdAt).toLocaleString()],
    ['Version', save.engine],
  ];
}

/** A `<dl>` of `[label, value]` pairs. */
function facts(pairs) {
  const dl = el('dl', 'records-facts');
  for (const [k, v] of pairs) dl.append(el('dt', 'ui-caps', k), el('dd', null, v));
  return dl;
}

/** A picture of a record (a save's map: only a small image data URL, validThumb), or a plain plate that says there is none. */
function picture(thumb, className) {
  const url = validThumb(thumb);
  if (url) {
    const img = el('img', className);
    img.setAttribute('src', url);
    img.setAttribute('alt', '');
    return img;
  }
  const none = el('span', `${className} records-thumb-none`);
  none.setAttribute('aria-hidden', 'true');
  return none;
}

/**
 * Delete with a second step: the button turns into "Delete <what>?" with
 * Keep and Delete, so one slip never removes a save or a replay. `run()`
 * may be async: both buttons wait for it (no second delete), and when it
 * resolves false (it failed and said why) the question stays to try again.
 */
function deleteControl(what, run) {
  const box = el('span', 'records-delete');
  const ask = () => {
    const question = el('span', 'records-delete-question', `Delete ${what}?`);
    const keep = button('Keep', 'ui-btn ui-btn-sm', () => {
      reset();
      first.focus({ preventScroll: true });
    });
    const yes = button('Delete', 'ui-btn ui-btn-sm ui-btn-ghost records-delete-confirm', async () => {
      if (yes.disabled) return;
      yes.disabled = true;
      keep.disabled = true;
      const ok = await run();
      yes.disabled = false;
      keep.disabled = false;
      if (ok === false && yes.isConnected) yes.focus({ preventScroll: true });
    });
    box.replaceChildren(question, keep, yes);
    keep.focus({ preventScroll: true });
  };
  const first = button('Delete', 'ui-btn ui-btn-ghost records-delete-ask', ask);
  const reset = () => box.replaceChildren(first);
  reset();
  return box;
}

/**
 * The list of a records screen (Load game, Replays): rows on the left (a
 * picture when `pictures`, the name and a line about it, the game time and
 * the date), the chosen one's details on the right (below on a narrow card).
 * Arrows, Home and End move through the rows; a double click runs the row's
 * main action (Load, Watch).
 *
 * Items: `{ key, title, meta, time, date, thumb?, flags?: Node[], detail(): Node[], activate?() }`.
 */
export class RecordBrowser {
  constructor({ label, empty, pictures = false }) {
    this.label = label;
    this.emptyText = empty;
    this.pictures = pictures;
    this.items = [];
    this.selected = null;
    this.root = el('div', pictures ? 'records-browser records-pictures' : 'records-browser');
    this.list = el('ul', 'records-list');
    this.list.setAttribute('aria-label', label);
    this.empty = el('p', 'records-empty records-muted', empty);
    this.empty.hidden = true;
    this.empty.tabIndex = -1;
    /** After a delete: focus goes to the chosen row (or the empty list's text) once the list is redrawn. */
    this.refocus = false;
    this.detail = el('section', 'records-detail');
    this.detail.setAttribute('aria-label', 'Details');
    this.detail.hidden = true;
    const side = el('div', 'records-main');
    side.append(this.list, this.empty);
    this.root.append(side, this.detail);
    this.list.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** Show `items`, keeping the chosen one when it is still there (else the first). */
  set(items) {
    this.items = items;
    this.list.replaceChildren();
    for (const item of items) {
      const li = el('li');
      const row = button('', 'records-row', () => this.select(item.key, true));
      row.dataset.key = String(item.key);
      if (this.pictures) row.append(picture(item.thumb, 'records-thumb'));
      const info = el('span', 'records-info');
      info.append(el('strong', 'records-name', item.title), el('span', 'records-meta', item.meta));
      if (item.flags?.length) {
        const flags = el('span', 'records-flags');
        flags.append(...item.flags);
        info.append(flags);
      }
      const when = el('span', 'records-when');
      when.append(el('span', 'records-time ui-num', item.time), el('span', 'records-date', item.date));
      row.append(info, when);
      if (item.activate) row.addEventListener('dblclick', () => item.activate());
      li.append(row);
      this.list.append(li);
    }
    this.empty.hidden = items.length > 0;
    this.list.hidden = items.length === 0;
    const keep = items.some((i) => i.key === this.selected) ? this.selected : (items[0]?.key ?? null);
    this.select(keep, false);
    if (this.refocus) {
      this.refocus = false;
      const row = this.rows().find((r) => r.dataset.key === String(keep));
      (row ?? this.empty).focus({ preventScroll: true });
    }
  }

  /** Record `key` is being deleted: the row after it (else the one before) is chosen and focused when the list is redrawn. */
  forget(key) {
    const at = this.items.findIndex((i) => i.key === key);
    const next = this.items[at + 1] ?? this.items[at - 1] ?? null;
    this.selected = next?.key ?? null;
    this.refocus = true;
  }

  rows() {
    return [...this.list.querySelectorAll('.records-row')];
  }

  /** Choose row `key` (null: none). `user`: a click or a key, which brings the details into view. */
  select(key, user) {
    this.selected = key;
    const item = this.items.find((i) => i.key === key) ?? null;
    for (const row of this.rows()) row.setAttribute('aria-current', String(row.dataset.key === String(key)));
    this.detail.hidden = !item;
    if (!item) {
      this.detail.replaceChildren();
      return;
    }
    this.detail.replaceChildren(...item.detail());
    // On a narrow card the details are under the list.
    if (user) this.detail.scrollIntoView?.({ block: 'nearest' });
  }

  onKey(e) {
    const rows = this.rows();
    const at = rows.indexOf(e.target);
    if (at < 0) return;
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[e.key];
    if (to === undefined || to < 0 || to >= rows.length) return;
    e.preventDefault();
    rows[to].focus();
    this.select(this.items[to].key, true);
  }
}

/**
 * The start screen's Load game and Replays entries. With `accountReplays`
 * (the signed-in account keeps replays: `available()`, and its AccountApi
 * `api`) Replays opens the screen of the account's replays; otherwise it
 * picks a file.
 * @param {HTMLElement} root the #records-entry element
 * @param {{ version: string, canPlay(): boolean, showError(msg: string): void,
 *   onLoadSave(replay: object): void, onWatchReplay(replay: object): void, store?: SaveStore,
 *   accountReplays?: { available(): boolean, api: import('./account/api.js').AccountApi },
 *   missionTitle?(id: string): Promise<string | null> }} ctx
 *   missionTitle: a mission's title for the saves of missions (js/campaign: the mission index)
 */
export function mountRecordEntries(root, ctx) {
  if (!root) return;
  const store = ctx.store ?? SaveStore.browser();
  root.replaceChildren(
    button('Load game', 'records-entry-button', () => loadDialog(store, ctx)),
    button('Replays', 'records-entry-button', () => (ctx.accountReplays?.available() ? replaysDialog(ctx) : watchFile(ctx))),
  );
  root.hidden = false;
}

async function watchFile(ctx) {
  if (!ctx.canPlay()) return ctx.showError('WebGPU is not available.');
  const file = await pickFile();
  if (!file) return;
  const r = await openRecordFile(file, ctx.version);
  if (!r.ok) return ctx.showError(r.error);
  ctx.onWatchReplay(r.replay);
}

/**
 * Download a replay kept in the account and check it like a file; resolves
 * `{ ok, replay }` or `{ ok: false, error }`. A replay of another build
 * resolves with its header (`foreign`): watching it explains the version.
 */
export async function openAccountReplay(api, id, version) {
  try {
    const { text } = await api.downloadReplay(id);
    return await openRecordText(text, version);
  } catch (err) {
    return { ok: false, error: `The replay could not be loaded: ${err.message ?? err}` };
  }
}

/** The "From file" tab of a records screen: what it opens and the button. */
function filePanel(text, label, pick) {
  const panel = el('div', 'records-file');
  const b = button(label, 'ui-btn ui-btn-primary', pick);
  panel.append(el('p', 'records-muted', text), b);
  return panel;
}

/** The screen's tabs in its title row; the panels go in `body`. */
function screenTabs(head, label, list) {
  const t = tabs({ label, tabs: list });
  t.root.classList.add('records-tabs');
  head.append(t.root);
  return t;
}

/** Replays: the signed-in account's replays (Watch, Download, Delete) and opening a file. */
async function replaysDialog(ctx) {
  if (!ctx.canPlay()) return ctx.showError('WebGPU is not available.');
  const { api } = ctx.accountReplays;
  const chosen = await dialog(
    'Replays',
    (body, close, head) => {
      const status = el('p', 'records-status records-muted', 'Loading your replays...');
      status.setAttribute('role', 'status');
      const say = (text) => {
        status.textContent = text;
      };

      // Your account: storage used, then the replays.
      const account = el('div', 'records-panel');
      const usage = el('div', 'records-usage');
      usage.hidden = true;
      const usageLine = el('span', 'records-usage-text ui-num');
      const meter = el('div', 'records-usage-bar ui-progress');
      meter.setAttribute('role', 'progressbar');
      meter.setAttribute('aria-label', 'Replay storage used');
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', '100');
      const kept = el('span', 'records-usage-note records-muted');
      const usageHead = el('div', 'records-usage-head');
      usageHead.append(el('span', 'ui-caps', 'Storage'), usageLine);
      usage.append(usageHead, meter, kept);
      const browser = new RecordBrowser({ label: 'Replays in your account', empty: 'No replays in your account yet. Games you finish or leave are saved here while "Save replays to my account" is on (game menu, Settings).' });
      account.append(usage, browser.root);

      const watch = async (r, b) => {
        if (b) b.disabled = true;
        say('Loading the replay...');
        const o = await openAccountReplay(api, r.id, ctx.version);
        if (b) b.disabled = false;
        if (!o.ok) return say(o.error);
        close(o.replay);
      };
      const detail = (r) => {
        const out = [el('h3', 'records-detail-title', r.title), facts(replayFacts(r))];
        // Watching needs the version that recorded it (js/replay.js engineMismatch says why).
        if (r.engine !== ctx.version) out.push(el('p', 'records-warning', `Made with WebRA ${r.engine}: it plays only in that version.`));
        const row = el('div', 'records-detail-actions');
        const download = button('Download', 'ui-btn', async () => {
          try {
            const { text, name } = await api.downloadReplay(r.id);
            downloadText(name, text);
          } catch (err) {
            say(`The replay could not be downloaded: ${err.message ?? err}`);
          }
        });
        const play = button('Watch', 'ui-btn ui-btn-primary records-main-action', () => watch(r, play));
        row.append(
          deleteControl('this replay', async () => {
            try {
              await api.deleteReplay(r.id);
            } catch (err) {
              say(`The replay could not be deleted: ${err.message ?? err}`);
              return false;
            }
            browser.forget(r.id);
            await render();
            return true;
          }),
          download,
          play,
        );
        out.push(row);
        return out;
      };
      const render = async () => {
        let data;
        try {
          data = await api.replays();
        } catch (err) {
          say(`Your replays could not be loaded: ${err.message ?? err}`);
          return;
        }
        usage.hidden = false;
        usageLine.textContent = usageText(data.usage, data.limits);
        const share = Math.round(usageShare(data.usage, data.limits) * 100);
        meter.setAttribute('aria-valuenow', String(share));
        meter.setAttribute('aria-valuetext', usageText(data.usage, data.limits));
        meter.style.setProperty('--ui-progress', `${share}%`);
        // Nearly full: the oldest go first when a new one does not fit.
        meter.classList.toggle('records-usage-full', share >= 90);
        kept.textContent = `Each one is kept for ${Math.round(data.limits.retentionMs / 86400000)} days; when a new one does not fit, the oldest go first.`;
        say('');
        browser.set(
          data.replays.map((r) => ({
            key: r.id,
            title: r.title,
            meta: replayMeta(r),
            time: durationText(r.ticks),
            date: shortDate(r.playedAt),
            flags: r.engine !== ctx.version ? [badge('warn', `WebRA ${r.engine}`, { title: `Made with WebRA ${r.engine}` })] : [],
            detail: () => detail(r),
            activate: () => watch(r, null),
          })),
        );
      };

      const file = filePanel('Watch a replay file you downloaded (from the game menu, Download replay, or from this list).', 'Choose a replay file', async () => {
        const f = await pickFile();
        if (!f) return;
        const r = await openRecordFile(f, ctx.version);
        if (!r.ok) say(r.error);
        else if (r.replay.kind === 'save') say('That is a saved game. Open it with Load game.');
        else close(r.replay);
      });
      screenTabs(head, 'Replays', [
        { id: 'account', label: 'Your account', panel: account },
        { id: 'file', label: 'From file', panel: file },
      ]);
      const actions = el('div', 'records-actions');
      actions.append(button('Close', 'ui-btn', () => close(null)));
      body.append(account, file, status, actions);
      render();
      // A list like Load game: a screen card the size of the window (css/records.css .records-screen).
    },
    { screen: true },
  );
  if (chosen) ctx.onWatchReplay(chosen);
}

async function loadDialog(store, ctx) {
  if (!ctx.canPlay()) return ctx.showError('WebGPU is not available.');
  const chosen = await dialog(
    'Load game',
    (body, close, head) => {
      const status = el('p', 'records-status records-muted', 'Loading saves...');
      status.setAttribute('role', 'status');
      const say = (text) => {
        status.textContent = text;
      };
      const local = new RecordBrowser({ label: 'Saved games in this browser', empty: 'No saved games in this browser yet. Save one from the game menu.', pictures: true });
      // Online saves continue online with their players (Play online, Resume a saved game).
      const online = new RecordBrowser({ label: 'Saved online games', empty: 'No saved online games in this browser. The host saves an online game from the game menu; resume it from Play online.', pictures: true });
      const localPanel = el('div', 'records-panel');
      localPanel.append(local.root);
      const onlinePanel = el('div', 'records-panel');
      onlinePanel.append(el('p', 'records-muted records-panel-note', 'Online games are resumed with their players: host it again from Play online, Resume a saved game.'), online.root);

      const load = async (s, b) => {
        if (b) b.disabled = true;
        const r = await store.load(s.id, ctx.version);
        if (b) b.disabled = false;
        if (!r.ok) return say(`This save cannot be loaded: ${r.error}.`);
        if (r.replay.mode === 'online') return say('This is a saved online game: resume it with its players from Play online.');
        close(r.replay);
      };
      const detail = (s, title) => {
        const out = [el('h3', 'records-detail-title', s.title), picture(s.thumb, 'records-detail-thumb'), facts(saveFacts(s, title))];
        if (s.engine !== ctx.version) out.push(el('p', 'records-warning', `Made with WebRA ${s.engine}: saves load only in the version that made them.`));
        out.push(el('p', 'records-muted records-note', 'Loading plays the game again up to the save and checks its state hash, so a long game takes a moment.'));
        const row = el('div', 'records-detail-actions');
        const remove = deleteControl('this save', async () => {
          try {
            await store.remove(s.id);
          } catch (err) {
            say(`The save could not be deleted: ${err.message ?? err}`);
            return false;
          }
          (s.mode === 'online' ? online : local).forget(s.id);
          await render();
          return true;
        });
        if (s.mode === 'online') row.append(remove);
        else {
          const go = button('Load', 'ui-btn ui-btn-primary records-main-action', () => load(s, go));
          row.append(remove, go);
        }
        out.push(row);
        return out;
      };
      const item = (s, titles) => {
        const title = s.summary?.mission ? (titles.get(s.summary.mission.id) ?? null) : null;
        return {
          key: s.id,
          title: s.title,
          meta: saveMeta(s, title),
          time: formatTicks(s.ticks),
          date: shortDate(s.createdAt),
          thumb: s.thumb ?? null,
          flags: s.engine !== ctx.version ? [badge('warn', `WebRA ${s.engine}`, { title: `Made with WebRA ${s.engine}` })] : [],
          detail: () => detail(s, title),
          activate: s.mode === 'online' ? undefined : () => load(s, null),
        };
      };
      const render = async () => {
        let saves;
        try {
          saves = await store.list();
        } catch (err) {
          say(`Saved games are unavailable: ${err.message ?? err}`);
          return;
        }
        // The missions' titles from the campaign's index (the rows show the id until it is here).
        const ids = [...new Set(saves.map((s) => s.summary?.mission?.id).filter(Boolean))];
        const titles = new Map();
        if (ctx.missionTitle && ids.length) {
          await Promise.all(ids.map(async (id) => titles.set(id, await ctx.missionTitle(id).catch(() => null))));
        }
        say('');
        local.set(saves.filter((s) => s.mode !== 'online').map((s) => item(s, titles)));
        online.set(saves.filter((s) => s.mode === 'online').map((s) => item(s, titles)));
      };
      const file = filePanel('Load a save file you downloaded (game menu, Save to file).', 'Choose a save file', async () => {
        const f = await pickFile();
        if (!f) return;
        const r = await openRecordFile(f, ctx.version);
        if (!r.ok) say(r.error);
        else if (r.replay.kind !== 'save') say('That is a replay. Open it with the Replays button.');
        else if (r.replay.mode === 'online') say('This is a saved online game: resume it with its players from Play online.');
        else close(r.replay);
      });
      screenTabs(head, 'Where the saves are', [
        { id: 'browser', label: 'In this browser', panel: localPanel },
        { id: 'online', label: 'Online saves', panel: onlinePanel },
        { id: 'file', label: 'From file', panel: file },
      ]);
      const actions = el('div', 'records-actions');
      actions.append(button('Cancel', 'ui-btn', () => close(null)));
      body.append(localPanel, onlinePanel, file, status, actions);
      render();
    },
    { screen: true },
  );
  if (chosen) ctx.onLoadSave(chosen);
}

/**
 * Game menu actions for a recorded game: save (skirmish and missions, to the
 * browser or a file) and download the replay. Each `run()` resolves with the message to show.
 * `recorder` is the handle on the recorder that runs with the simulation
 * (js/sim/proxy.js RecorderHandle): `start`, `full`, and `encode(kind)`
 * resolving with `{ text, ticks, full }`; `ready()` is false while a save loads;
 * `onSaved()` runs after every save (OpenRA's GameSaved notification);
 * `thumbnail()` is the picture of the map kept with a save in the browser
 * (js/savethumb.js), or null.
 */
export function recordActions({ recorder, ready = () => true, stress = false, store = null, onSaved = () => {}, thumbnail = () => null }) {
  if (stress || !recorder) return [];
  const saves = store ?? SaveStore.browser();
  const fail = (err) => err?.message ?? String(err);
  const actions = [];
  // Single player games: skirmish and campaign missions.
  if ((recorder.start.mode === 'skirmish' || recorder.start.mode === 'mission') && recorder.start.player !== null) {
    actions.push({
      id: 'save',
      label: 'Save game',
      run: async () => {
        if (!ready()) return 'Wait until the game has loaded.';
        if (recorder.full) return 'This game is too long to save.';
        try {
          const { text, ticks } = await recorder.encode('save');
          await saves.add(text, { thumbnail: thumbnail() });
          onSaved();
          return `Saved at ${formatTicks(ticks)}. Load it from the lobby (Load game).`;
        } catch (err) {
          return `Could not save: ${fail(err)}`;
        }
      },
    });
    actions.push({
      id: 'savefile',
      label: 'Save to file',
      run: async () => {
        if (!ready()) return 'Wait until the game has loaded.';
        if (recorder.full) return 'This game is too long to save.';
        try {
          const { text } = await recorder.encode('save');
          downloadText(recordFileName({ ...recorder.start }, 'save'), text);
          onSaved();
          return 'Save file downloaded.';
        } catch (err) {
          return `Could not save: ${fail(err)}`;
        }
      },
    });
  }
  actions.push({
    id: 'replay',
    label: 'Download replay',
    run: async () => {
      if (!ready()) return 'Wait until the game has loaded.';
      try {
        const { text, full } = await recorder.encode('replay');
        downloadText(recordFileName({ ...recorder.start }, 'replay'), text);
        return full ? 'Replay downloaded (the game was too long: it stops early).' : 'Replay downloaded.';
      } catch (err) {
        return `Could not download the replay: ${fail(err)}`;
      }
    },
  });
  return actions;
}

/**
 * Download the replay being watched (the replay bar's Download): the file as
 * it was opened. Returns the message to show.
 */
export function downloadReplayFile(replay) {
  try {
    downloadText(recordFileName(replay, 'replay'), encodeReplay(replay));
    return 'Replay downloaded.';
  } catch (err) {
    return `Could not download the replay: ${err?.message ?? err}`;
  }
}

let replayBars = 0;

/** The play button's word for the screen reader and its icon: Pause while playing, Restart at the end, else Play. */
function playState(c) {
  return c.ended ? 'restart' : c.playing ? 'pause' : 'play';
}
const PLAY_LABELS = { play: 'Play', pause: 'Pause', restart: 'Restart' };
const PLAY_HELP = { play: 'Go on watching the replay.', pause: 'Stop the replay here.', restart: 'Watch the replay again from the start.' };

/** Tooltip of the replay bar's play button in state `state` (playState). */
export function playTip(state) {
  return { title: PLAY_LABELS[state] ?? PLAY_LABELS.play, desc: PLAY_HELP[state] ?? PLAY_HELP.play };
}

/** Tooltip of the replay bar's time (OpenRA label-replay-complete): how much of the replay is watched. */
export function replayTimeTip(ticks, length) {
  const complete = completeText(ticks, length);
  return complete ? { title: complete, desc: `${formatTicks(Math.max(0, Math.min(ticks, length)))} of ${formatTicks(length)} watched.` } : null;
}

/**
 * Replay viewer controls (the Replay board's transport bar): play / pause,
 * the speeds, the seek bar with marks of what happened in the part already
 * watched (js/replaymarks.js), the time, the blinking status, and Download
 * and Exit when the viewer passes them (`onDownload`, `onExit`).
 */
export class ReplayBar {
  /**
   * `now`: wall clock in ms (the status blinks every other second, OpenRA GameTimerLogic).
   * @param {HTMLElement} parent
   * @param {object} controller js/sim/proxy.js ReplayHandle
   * @param {{ now?: () => number, onDownload?: (() => void) | null, onExit?: (() => void) | null }} [o]
   */
  constructor(parent, controller, { now = () => Date.now(), onDownload = null, onExit = null } = {}) {
    this.c = controller;
    this.now = now;
    this.start = now();
    this.marks = new ReplayMarks(controller.length);
    this.root = el('div', 'replay-bar');
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'Replay');
    this.playIcon = el('span', 'replay-icon');
    this.playIcon.setAttribute('aria-hidden', 'true');
    this.play = button('', 'ui-btn ui-btn-primary ui-btn-icon replay-play', () => {
      this.c.togglePlay();
      this.update();
    });
    this.play.append(this.playIcon);
    this.speeds = REPLAY_SPEEDS.map((s) => {
      const b = button('', 'replay-speed', () => {
        this.c.setSpeed(s);
        this.update();
      });
      b.append(led('off'), el('span', null, `${s}x`));
      b.setAttribute('aria-label', `Speed ${s}x`);
      return [s, b];
    });
    const speeds = el('div', 'replay-speeds');
    speeds.setAttribute('role', 'group');
    speeds.setAttribute('aria-label', 'Speed');
    speeds.append(...this.speeds.map(([, b]) => b));

    this.seek = el('input', 'replay-seek');
    this.seek.type = 'range';
    this.seek.min = '0';
    this.seek.max = String(controller.length);
    this.seek.step = '25';
    this.seek.setAttribute('aria-label', 'Position');
    styleSlider(this.seek);
    this.seek.addEventListener('input', () => {
      this.dragging = true;
      this.showTime(Number(this.seek.value));
    });
    this.seek.addEventListener('change', () => {
      this.dragging = false;
      this.c.seek(Number(this.seek.value));
      this.update();
    });
    // The marks over the track, and the same list in words for screen readers.
    this.markLayer = el('div', 'replay-marks');
    this.markLayer.setAttribute('aria-hidden', 'true');
    this.markList = el('span', 'ui-sr-only');
    this.markList.id = `replay-marks-${++replayBars}`;
    this.seek.setAttribute('aria-describedby', this.markList.id);
    const track = el('div', 'replay-track');
    track.append(this.markLayer, this.seek);

    this.time = el('span', 'replay-time ui-num');
    this.lengthText = el('span', 'replay-length ui-num');
    // GAME_TIMER_STATUS: "Paused", "Max Speed" or "N% Speed", blinking.
    this.status = el('span', 'replay-status');
    this.status.setAttribute('aria-hidden', 'true');
    const times = el('div', 'replay-times');
    times.append(this.time, this.status, this.lengthText);
    const seekBox = el('div', 'replay-seekbox');
    seekBox.append(track, times, this.markList);

    this.note = el('span', 'replay-note');
    this.note.setAttribute('role', 'status');
    const end = el('div', 'replay-end');
    if (onDownload) end.append(button('Download', 'ui-btn ui-btn-sm replay-download', () => onDownload()));
    if (onExit) end.append(button('Exit', 'ui-btn ui-btn-sm ui-btn-ghost replay-exit', () => onExit()));
    this.root.append(this.play, speeds, seekBox, ...(onDownload || onExit ? [end] : []), this.note);
    parent.append(this.root);
    // The game's tooltips (js/ui/tooltip.js), not the browser's title.
    this.tips = [
      attachTooltip(this.play, () => playTip(this.play.dataset.state), { side: 'top' }),
      attachTooltip(this.time, () => replayTimeTip(this.c.ticks, this.c.length), { side: 'top' }),
    ];
    this.dragging = false;
    this.update();
  }

  /** The viewer is going: the controls leave the battlefield. */
  dispose() {
    for (const tip of this.tips) tip.detach();
    this.root.remove();
  }

  /** The replay speed hotkeys (js/gamekeys.js): a speed of REPLAY_SPEEDS, or 'max' for the highest. */
  setSpeed(speed) {
    this.c.setSpeed(speed === 'max' ? REPLAY_SPEEDS[REPLAY_SPEEDS.length - 1] : speed);
    this.update();
  }

  /**
   * One frame's observer statistics (Game.observer_stats) at `tick`: the
   * seek bar's marks (js/replaymarks.js). Not while a seek re-simulates.
   */
  observe(players, tick) {
    if (this.c.seeking) {
      this.marks.jump();
      return;
    }
    if (this.marks.observe(players, tick)) this.drawMarks();
  }

  drawMarks() {
    const spans = this.marks.marks.map((m) => {
      const s = el('span', `replay-mark replay-mark-${m.kind}`);
      s.style.setProperty('--at', `${(this.marks.at(m) * 100).toFixed(2)}%`);
      return s;
    });
    this.markLayer.replaceChildren(...spans);
    const words = this.marks.marks.map((m) => `${formatTicks(m.tick)} ${MARK_KINDS[m.kind].toLowerCase()}`);
    this.markList.textContent = words.length ? `Marked: ${words.join('; ')}.` : '';
  }

  showTime(ticks) {
    const now = formatTicks(ticks);
    const length = formatTicks(this.c.length);
    if (this.time.textContent !== now) this.time.textContent = now;
    if (this.lengthText.textContent !== length) this.lengthText.textContent = length;
    this.seek.setAttribute('aria-valuetext', `${now} of ${length}`);
  }

  update() {
    const c = this.c;
    // A seek (also one keyboard step of 25 ticks): what it skips was not watched.
    if (c.seeking) this.marks.jump();
    if (this.marks.length !== Math.max(1, c.length)) {
      this.marks.length = Math.max(1, c.length);
      this.seek.max = String(c.length);
      if (this.marks.marks.length) this.drawMarks();
    }
    const state = playState(c);
    if (this.play.dataset.state !== state) {
      this.play.dataset.state = state;
      this.playIcon.dataset.icon = state;
      this.play.setAttribute('aria-label', PLAY_LABELS[state]);
      this.tips[0].refresh();
    }
    for (const [s, b] of this.speeds) {
      const on = s === c.speed;
      if (b.getAttribute('aria-pressed') !== String(on)) {
        b.setAttribute('aria-pressed', String(on));
        setLed(b.querySelector('.ui-led'), on ? 'on' : 'off');
      }
    }
    if (!this.dragging) {
      this.seek.value = String(c.seeking ? c.target : c.ticks);
      syncSliderFill(this.seek);
      this.showTime(c.ticks);
    }
    // The observer timer's tooltip (OpenRA label-replay-complete) follows the replay while it shows.
    const complete = completeText(c.ticks, c.length);
    if (complete !== this.complete) {
      this.complete = complete;
      this.tips[1].refresh();
    }
    const status = c.ended ? null : replayStatus({ playing: c.playing, speed: c.speed, maxSpeed: REPLAY_SPEEDS[REPLAY_SPEEDS.length - 1] });
    const shown = status && blinkOn(this.now(), this.start) ? status : '';
    if (this.status.textContent !== shown) this.status.textContent = shown;
    const note = c.diverged !== null ? `This replay no longer matches the game from ${formatTicks(c.diverged)} on.` : c.ended ? 'End of the replay.' : '';
    if (this.note.textContent !== note) this.note.textContent = note;
  }
}
/** A centred message with progress over the battlefield. */
export class ProgressOverlay {
  constructor(parent) {
    this.root = el('div', 'records-progress');
    this.root.setAttribute('role', 'status');
    this.root.hidden = true;
    parent.append(this.root);
  }

  /** The game is going (a restart in place). */
  dispose() {
    this.root.remove();
  }

  show(text) {
    if (text === null) {
      if (!this.root.hidden) this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    if (this.root.textContent !== text) this.root.textContent = text;
  }
}
