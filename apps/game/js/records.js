// Saves and replays in the UI: the lobby's Load game and Replays buttons
// with their dialogs, the game menu's record actions, the replay viewer's
// control bar, and the progress overlay shown while a game fast-forwards
// (loading a save, rejoining an online game, seeking in a replay).
//
// Replay and save files are user files: every one goes through the
// protocol's parseReplay (size, schema, map hash) before anything uses it,
// and a modded map asks for the usual warning first (main.js acceptMap).

import { formatTicks, recordFileName, REPLAY_SPEEDS } from './replay.js';
import { downloadText, pickFile, readFileText, SaveStore } from './saves.js';
import { MODDED_WARNING, parseReplay } from './protocol.js';

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

/** A modal dialog; `build(body, close)` fills it. Resolves with what close() got (null on Esc). */
export function dialog(title, build) {
  return new Promise((resolve) => {
    const d = el('dialog', 'records-dialog');
    d.append(el('h2', 'records-dialog-title', title));
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
      close(null);
    });
    build(body, close);
    document.body.append(d);
    d.showModal();
  });
}

/** The modded-map warning; resolves true only when the player accepts. */
export function confirmModdedMap(mapName) {
  return dialog('Modded map', (body, close) => {
    body.append(el('p', 'records-warning', MODDED_WARNING), el('p', 'records-muted', `Map: ${mapName}`));
    const row = el('div', 'records-actions');
    row.append(button('Decline', null, () => close(false)), button('Accept and play', 'records-danger', () => close(true)));
    body.append(row);
  }).then((v) => v === true);
}

/** Read and validate a replay or save file. Resolves { ok, replay } or { ok: false, error }. */
export async function openRecordFile(file) {
  try {
    const r = await parseReplay(await readFileText(file));
    return r.ok ? r : { ok: false, error: `This file cannot be used: ${r.error}.` };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

/**
 * The lobby's Load game and Replays buttons.
 * @param {HTMLElement} root the #records-entry element
 * @param {{ version: string, canPlay(): boolean, showError(msg: string): void,
 *   onLoadSave(replay: object): void, onWatchReplay(replay: object): void, store?: SaveStore }} ctx
 */
export function mountRecordEntries(root, ctx) {
  if (!root) return;
  const store = ctx.store ?? SaveStore.browser();
  root.replaceChildren(
    button('Load game', 'records-entry-button', () => loadDialog(store, ctx)),
    button('Replays', 'records-entry-button', () => watchFile(ctx)),
  );
  root.hidden = false;
}

async function watchFile(ctx) {
  if (!ctx.canPlay()) return ctx.showError('WebGPU is not available.');
  const file = await pickFile();
  if (!file) return;
  const r = await openRecordFile(file);
  if (!r.ok) return ctx.showError(r.error);
  ctx.onWatchReplay(r.replay);
}

async function loadDialog(store, ctx) {
  if (!ctx.canPlay()) return ctx.showError('WebGPU is not available.');
  const chosen = await dialog('Load game', (body, close) => {
    const list = el('div', 'records-list');
    list.setAttribute('role', 'list');
    const status = el('p', 'records-muted', 'Loading saves...');
    const render = async () => {
      let saves;
      try {
        saves = await store.list();
      } catch (err) {
        status.textContent = `Saved games are unavailable: ${err.message ?? err}`;
        return;
      }
      list.replaceChildren();
      status.textContent = saves.length ? '' : 'No saved games in this browser yet. Save one from the game menu.';
      for (const s of saves) {
        const row = el('div', 'records-row');
        row.setAttribute('role', 'listitem');
        const info = el('div', 'records-info');
        info.append(el('strong', null, s.title), el('span', 'records-muted', `${formatTicks(s.ticks)} played, saved ${new Date(s.createdAt).toLocaleString()}`));
        if (s.engine !== ctx.version) info.append(el('span', 'records-warning', `Made with WebRA ${s.engine}`));
        const load = button('Load', 'records-primary', async () => {
          const r = await store.load(s.id);
          if (!r.ok) {
            status.textContent = `This save cannot be loaded: ${r.error}.`;
            return;
          }
          close(r.replay);
        });
        const del = button('Delete', null, async () => {
          await store.remove(s.id);
          render();
        });
        row.append(info, load, del);
        list.append(row);
      }
    };
    const actions = el('div', 'records-actions');
    actions.append(
      button('Load from file', null, async () => {
        const file = await pickFile();
        if (!file) return;
        const r = await openRecordFile(file);
        if (!r.ok) status.textContent = r.error;
        else if (r.replay.kind !== 'save') status.textContent = 'That is a replay. Open it with the Replays button.';
        else close(r.replay);
      }),
      button('Cancel', null, () => close(null)),
    );
    body.append(list, status, actions);
    render();
  });
  if (chosen) ctx.onLoadSave(chosen);
}

/**
 * Game menu actions for a recorded game: save (skirmish, to the browser or a
 * file) and download the replay. Each `run()` resolves with the message to show.
 * `recorder` is the handle on the recorder that runs with the simulation
 * (js/sim/proxy.js RecorderHandle): `start`, `full`, and `encode(kind)`
 * resolving with `{ text, ticks, full }`; `ready()` is false while a save loads.
 */
export function recordActions({ recorder, ready = () => true, stress = false, store = null }) {
  if (stress || !recorder) return [];
  const saves = store ?? SaveStore.browser();
  const fail = (err) => err?.message ?? String(err);
  const actions = [];
  if (recorder.start.mode === 'skirmish' && recorder.start.player !== null) {
    actions.push({
      id: 'save',
      label: 'Save game',
      run: async () => {
        if (!ready()) return 'Wait until the game has loaded.';
        if (recorder.full) return 'This game is too long to save.';
        try {
          const { text, ticks } = await recorder.encode('save');
          await saves.add(text);
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

/** Replay viewer controls: play / pause, speed, seek bar, time. */
export class ReplayBar {
  constructor(parent, controller) {
    this.c = controller;
    this.root = el('div', 'replay-bar');
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'Replay');
    this.play = button('Pause', 'replay-play', () => {
      this.c.togglePlay();
      this.update();
    });
    this.speeds = REPLAY_SPEEDS.map((s) => {
      const b = button(`${s}x`, 'replay-speed', () => {
        this.c.setSpeed(s);
        this.update();
      });
      b.setAttribute('aria-label', `Speed ${s}x`);
      return [s, b];
    });
    this.seek = el('input', 'replay-seek');
    this.seek.type = 'range';
    this.seek.min = '0';
    this.seek.max = String(controller.length);
    this.seek.step = '25';
    this.seek.setAttribute('aria-label', 'Position');
    this.seek.addEventListener('input', () => {
      this.dragging = true;
      this.time.textContent = `${formatTicks(Number(this.seek.value))} / ${formatTicks(this.c.length)}`;
    });
    this.seek.addEventListener('change', () => {
      this.dragging = false;
      this.c.seek(Number(this.seek.value));
      this.update();
    });
    this.time = el('span', 'replay-time');
    this.note = el('span', 'replay-note');
    this.note.setAttribute('role', 'status');
    const speeds = el('span', 'replay-speeds');
    speeds.append(...this.speeds.map(([, b]) => b));
    this.root.append(this.play, speeds, this.seek, this.time, this.note);
    parent.append(this.root);
    this.dragging = false;
    this.update();
  }

  update() {
    const c = this.c;
    this.play.textContent = c.ended ? 'Restart' : c.playing ? 'Pause' : 'Play';
    for (const [s, b] of this.speeds) b.setAttribute('aria-pressed', String(s === c.speed));
    if (!this.dragging) {
      this.seek.value = String(c.seeking ? c.target : c.ticks);
      this.time.textContent = `${formatTicks(c.ticks)} / ${formatTicks(c.length)}`;
    }
    this.note.textContent =
      c.diverged !== null ? `This replay no longer matches the game from ${formatTicks(c.diverged)} on.` : c.ended ? 'End of the replay.' : '';
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

  show(text) {
    if (text === null) {
      if (!this.root.hidden) this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    if (this.root.textContent !== text) this.root.textContent = text;
  }
}
