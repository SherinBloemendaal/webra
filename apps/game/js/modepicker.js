// The "Game mode" row of the skirmish and online lobbies: a list of the
// built-in and saved modes (js/modes.js) plus Custom, a line about the
// current mode, and Save as / Delete for the player's own modes, which live
// in the settings registry (`lobby.presets`) and so follow the account.
// Picking a mode hands its bundle to `onApply`; the lobby applies it like any
// option change. Read only (online guests) it only shows the mode.
// DOM through createElement and textContent only (strict CSP).

import { CUSTOM, PRESET_NAME_MAX, currentMode, deletePreset, isSavedId, modeList, savePreset, savedId } from './modes.js';
import { infoTip } from './infotip.js';
import { selectPlate } from './ui/controls.js';

let uid = 0;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class ModePicker {
  /**
   * @param {{
   *   context: 'skirmish' | 'online',
   *   registry: ReturnType<import('./registry.js').createRegistry>,
   *   onApply: (mode: { id: string, name: string, options: object }) => void,
   *   onCustom?: () => void,
   *   selectClass?: string,  (unused: the list is a select plate, js/ui/controls.js)
   *   buttonClass: string,
   *   inputClass: string,
   *   preferred?: string | null,
   * }} o
   */
  constructor(o) {
    this.o = o;
    this.preferred = o.preferred ?? null;
    this.options = null;
    this.editable = true;
    this.confirming = null;
    const id = `mode-select-${++uid}`;

    this.root = el('div', 'mode-picker');
    const head = el('div', 'mode-head');
    const label = el('label', 'mode-label', 'Game mode');
    label.htmlFor = id;
    // The list of modes: a select plate (js/ui/controls.js), `id` is its button.
    this.select = selectPlate({ id, label: 'Game mode', options: [], block: true, className: 'mode-select', onChange: (v) => this.pick(v) });
    this.help = infoTip(o.context === 'online' ? 'modeOnline' : 'mode', { label: 'Game mode', describes: this.select.button });
    head.append(label, this.help.root);

    this.desc = el('p', 'mode-desc');
    this.desc.setAttribute('aria-live', 'polite');

    this.tools = el('div', 'mode-tools');
    this.saveBtn = el('button', o.buttonClass, 'Save as...');
    this.saveBtn.type = 'button';
    this.saveBtn.addEventListener('click', () => this.openSave());
    this.deleteBtn = el('button', o.buttonClass, 'Delete');
    this.deleteBtn.type = 'button';
    this.deleteBtn.addEventListener('click', () => this.remove());
    this.tools.append(this.saveBtn, this.deleteBtn);

    this.form = el('div', 'mode-save');
    this.form.hidden = true;
    const nameId = `mode-name-${++uid}`;
    const nameLabel = el('label', 'mode-label', 'Name');
    nameLabel.htmlFor = nameId;
    this.nameInput = el('input', `${o.inputClass} mode-name`);
    this.nameInput.id = nameId;
    this.nameInput.type = 'text';
    this.nameInput.maxLength = PRESET_NAME_MAX;
    this.nameInput.autocomplete = 'off';
    this.nameInput.spellcheck = false;
    this.nameInput.placeholder = 'My mode';
    this.nameInput.addEventListener('keydown', (e) => {
      // Enter saves (and must not start the game); Esc cancels.
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        this.save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeSave(true);
      }
    });
    const ok = el('button', o.buttonClass, 'Save');
    ok.type = 'button';
    ok.addEventListener('click', () => this.save());
    const cancel = el('button', o.buttonClass, 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.closeSave(true));
    this.form.append(nameLabel, this.nameInput, ok, cancel);

    this.status = el('p', 'mode-status');
    this.status.setAttribute('role', 'status');

    this.root.append(head, this.select.root, this.desc, this.tools, this.form, this.status);

    // Saved modes can change in another tab or from the account: redraw, and
    // stop listening once this picker has left the page.
    this.unsubscribe = o.registry.subscribe('lobby', (_values, changes) => {
      if (!changes.some((c) => c.key === 'presets')) return;
      if (!this.root.isConnected && this.options) {
        this.unsubscribe();
        return;
      }
      if (this.options) this.render(this.options, { editable: this.editable });
    });
  }

  get saved() {
    return this.o.registry.get('lobby', 'presets');
  }

  get modes() {
    return modeList(this.o.context, this.saved);
  }

  /** The id of the mode the current options are (CUSTOM when none). */
  get currentId() {
    return this.options ? currentMode(this.options, this.modes, this.preferred) : CUSTOM;
  }

  /**
   * Show the mode of `options`. `editable` false: the list is read only and
   * saving and deleting are hidden (online guests).
   */
  render(options, { editable = true } = {}) {
    this.options = options;
    this.editable = editable;
    const modes = this.modes;
    const id = currentMode(options, modes, this.preferred);
    if (this.confirming !== id) this.confirming = null;

    const builtin = modes.filter((m) => !m.saved).map((m) => ({ value: m.id, label: m.name }));
    const own = modes.filter((m) => m.saved).map((m) => ({ value: m.id, label: m.name }));
    this.select.setOptions(
      [{ label: 'Modes', options: builtin }, ...(own.length ? [{ label: 'Your modes', options: own }] : []), { value: CUSTOM, label: 'Custom' }],
      id,
    );
    this.select.setDisabled(!editable);

    const mode = modes.find((m) => m.id === id);
    this.desc.textContent = mode ? mode.description : 'Options set by hand.';

    this.tools.hidden = !editable;
    if (!editable) this.closeSave(false);
    this.deleteBtn.hidden = !isSavedId(id);
    this.deleteBtn.textContent = this.confirming === id ? `Delete "${mode?.name}"?` : 'Delete';
    this.deleteBtn.classList.toggle('mode-confirm', this.confirming === id);
  }

  pick(id) {
    this.status.textContent = '';
    this.closeSave(false);
    if (id === CUSTOM) {
      this.preferred = CUSTOM;
      this.o.onCustom?.();
      this.render(this.options, { editable: this.editable });
      return;
    }
    const mode = this.modes.find((m) => m.id === id);
    if (!mode) return;
    this.preferred = id;
    this.o.onApply(mode);
  }

  /** The player changed an option by hand: forget a Custom choice so a matching mode shows again. */
  optionChanged() {
    if (this.preferred === CUSTOM) this.preferred = null;
  }

  openSave() {
    if (!this.editable) return;
    const id = this.currentId;
    this.nameInput.value = isSavedId(id) ? this.modes.find((m) => m.id === id)?.name ?? '' : '';
    this.form.hidden = false;
    this.saveBtn.hidden = true;
    this.status.textContent = '';
    this.nameInput.focus();
  }

  closeSave(refocus) {
    if (this.form.hidden) return;
    this.form.hidden = true;
    this.saveBtn.hidden = false;
    if (refocus) this.saveBtn.focus();
  }

  save() {
    const result = savePreset(this.saved, this.nameInput.value, this.options);
    if (result.error) {
      this.status.textContent = result.error;
      this.nameInput.focus();
      return;
    }
    this.o.registry.set('lobby', 'presets', result.list);
    this.preferred = savedId(result.name);
    this.closeSave(true);
    this.render(this.options, { editable: this.editable });
    this.status.textContent = result.replaced ? `Mode "${result.name}" updated.` : `Mode "${result.name}" saved.`;
  }

  remove() {
    const id = this.currentId;
    if (!this.editable || !isSavedId(id)) return;
    const mode = this.modes.find((m) => m.id === id);
    if (this.confirming !== id) {
      // Two steps: the first press asks, the second deletes.
      this.confirming = id;
      this.render(this.options, { editable: this.editable });
      this.deleteBtn.focus();
      return;
    }
    this.confirming = null;
    this.preferred = null;
    this.o.registry.set('lobby', 'presets', deletePreset(this.saved, mode.name));
    this.render(this.options, { editable: this.editable });
    this.status.textContent = `Mode "${mode.name}" deleted.`;
    this.select.button.focus();
  }
}
