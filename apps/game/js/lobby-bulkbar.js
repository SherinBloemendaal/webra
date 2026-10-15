// The bulk edit bar of the skirmish and online lobbies (js/lobby-bulk.js
// plans the actions). "Bulk edit" turns it on: every slot row gets a
// checkbox, a click on a row (outside its controls) selects it, Ctrl or Cmd
// adds or removes one row and Shift selects the range from the last clicked
// row, top to bottom; Shift on a checkbox sets that range like the box.
// One action list (grouped) and Apply act on the selection, or on every
// slot when nothing is selected. Keyboard: Tab reaches the checkboxes,
// Space ticks one (Shift+Space a range); the action list is a select plate
// (js/ui/controls.js): Enter in it chooses, Enter on it applies the choice.
// DOM through createElement and textContent only (strict CSP).

import { RowSelection, bulkActions } from './lobby-bulk.js';
import { infoTip } from './infotip.js';
import { selectPlate } from './ui/controls.js';

let uid = 0;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Clicks on these act on the control, not on the row's selection. */
const CONTROLS = 'input, select, button, a, label, textarea, [role="listbox"], [role="option"]';

export class BulkBar {
  /**
   * @param {{
   *   context: 'skirmish' | 'online',
   *   selectClass?: string,  (unused: the action list is a select plate)
   *   buttonClass: string,
   *   onApply: (id: string, selected: number[]) => { summary?: string, error?: string, pending?: boolean },
   *   note?: string,  a line under the actions (what they cannot change)
   * }} o
   */
  constructor(o) {
    this.o = o;
    this.selection = new RowSelection();
    this.active = false;
    this.available = true;
    this.rows = [];
    this.count = 0;
    this.actionOpts = { context: o.context };
    const id = `bulk-${++uid}`;

    this.toggle = el('button', `${o.buttonClass} bulk-toggle`, 'Bulk edit');
    this.toggle.type = 'button';
    this.toggle.setAttribute('aria-pressed', 'false');
    this.toggle.setAttribute('aria-controls', id);
    this.toggle.addEventListener('click', () => this.setActive(!this.active));
    this.help = infoTip('bulk', { label: 'Bulk edit', describes: this.toggle });
    this.toggleBox = el('span', 'bulk-toggle-box');
    this.toggleBox.append(this.toggle, this.help.root);

    this.root = el('div', 'bulk-bar');
    this.root.id = id;
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Bulk edit');
    this.root.hidden = true;

    const head = el('div', 'bulk-row');
    const allLabel = el('label', 'bulk-all');
    this.all = el('input', 'bulk-pick');
    this.all.type = 'checkbox';
    this.all.addEventListener('click', () => {
      if (this.selection.size === this.count) this.selection.clear();
      else this.selection.selectAll(Array.from({ length: this.count }, (_, i) => i));
      this.sync();
    });
    allLabel.append(this.all, el('span', null, 'All'));
    this.countText = el('span', 'bulk-count');
    this.countText.setAttribute('aria-live', 'polite');
    this.clearBtn = el('button', o.buttonClass, 'Clear selection');
    this.clearBtn.type = 'button';
    this.clearBtn.addEventListener('click', () => {
      this.selection.clear();
      this.sync();
    });
    head.append(allLabel, this.countText, this.clearBtn);

    const act = el('div', 'bulk-row');
    const selectId = `${id}-action`;
    const label = el('label', 'bulk-label', 'Action');
    label.htmlFor = selectId;
    this.select = selectPlate({
      id: selectId,
      label: 'Action',
      options: [],
      placeholder: 'Choose an action',
      className: 'bulk-action',
      onChange: () => (this.applyBtn.disabled = this.action() === null),
    });
    // Enter on the chosen action applies it (and must not start the game, like Enter elsewhere in
    // the lobby); Space and the arrow keys open the list again.
    this.select.button.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || this.action() === null) return;
      e.preventDefault();
      e.stopPropagation();
      this.apply();
    });
    this.applyBtn = el('button', `${o.buttonClass} bulk-apply`, 'Apply');
    this.applyBtn.type = 'button';
    this.applyBtn.disabled = true;
    this.applyBtn.addEventListener('click', () => this.apply());
    act.append(label, this.select.root, this.applyBtn);

    this.status = el('p', 'bulk-status');
    this.status.setAttribute('role', 'status');
    this.root.append(head, act);
    if (o.note) this.root.append(el('p', 'bulk-note', o.note));
    this.root.append(this.status);
  }

  /** Turn bulk editing on or off (off forgets the selection). */
  setActive(on) {
    this.active = on && this.available;
    this.toggle.setAttribute('aria-pressed', String(this.active));
    this.root.hidden = !this.active;
    if (!this.active) this.selection.clear();
    this.status.textContent = '';
    this.sync();
  }

  /**
   * Before the rows are rebuilt: how many rows there are, whether bulk
   * editing is possible (`available`: the online host, not in a resumed
   * save) and the options of the action list (lobby-bulk.js bulkActions).
   */
  begin(count, { available = true, ...actionOpts } = {}) {
    this.rows = [];
    this.count = count;
    this.available = available;
    this.toggleBox.hidden = !available;
    if (!available && this.active) this.setActive(false);
    this.selection.prune(count);
    const key = JSON.stringify(actionOpts);
    if (key !== this.actionKey) {
      this.actionKey = key;
      this.actionOpts = { context: this.o.context, ...actionOpts };
      this.fillActions();
    }
  }

  /** The chosen action's id, or null. */
  action() {
    return this.select.get() ?? null;
  }

  fillActions() {
    // The chosen action stays when the new list still has it.
    this.select.setOptions(bulkActions(this.actionOpts).map((g) => ({ label: g.label, options: g.items.map((item) => ({ value: item.id, label: item.label })) })));
    this.applyBtn.disabled = this.action() === null;
  }

  /**
   * Give row `i` its checkbox (in `cell`, first) and row selection. `name`
   * names the row for screen readers ("Player 3").
   */
  decorate(row, cell, i, name) {
    const box = el('input', 'bulk-pick');
    box.type = 'checkbox';
    box.setAttribute('aria-label', `Select ${name}`);
    box.addEventListener('click', (e) => {
      this.selection.click(i, { range: e.shiftKey, additive: true });
      this.sync();
    });
    row.addEventListener('click', (e) => {
      if (!this.active || e.target?.closest?.(CONTROLS)) return;
      this.selection.click(i, { range: e.shiftKey, additive: e.ctrlKey || e.metaKey });
      this.sync();
    });
    cell.prepend(box);
    this.rows[i] = { row, box };
    this.syncRow(i);
  }

  syncRow(i) {
    const r = this.rows[i];
    if (!r) return;
    const on = this.active && this.selection.has(i);
    r.box.hidden = !this.active;
    r.box.checked = on;
    r.row.classList.toggle('bulk-selected', on);
    r.row.classList.toggle('bulk-active', this.active);
    if (this.active) r.row.setAttribute('aria-selected', String(on));
    else r.row.removeAttribute('aria-selected');
  }

  /** Show the selection on the rows, the All box and the count. */
  sync() {
    this.rows.forEach((_, i) => this.syncRow(i));
    const n = this.selection.size;
    this.all.checked = n > 0 && n === this.count;
    this.all.indeterminate = n > 0 && n < this.count;
    this.all.setAttribute('aria-checked', n === 0 ? 'false' : n === this.count ? 'true' : 'mixed');
    this.countText.textContent = n ? `${n} of ${this.count} selected` : 'Nothing selected: actions apply to every slot';
    this.clearBtn.disabled = n === 0;
  }

  apply() {
    const id = this.action();
    if (!id || !this.active) return;
    const out = this.o.onApply(id, this.selection.list()) ?? {};
    // Online the server answers later (report): until then the bar says so.
    if (out.pending) this.report('Sent to the server...');
    else this.report(out.error ?? out.summary ?? '', Boolean(out.error));
  }

  /** Show how an action went (the online lobby, once the server answered). */
  report(text, error = false) {
    this.status.textContent = text;
    this.status.classList.toggle('bulk-error', error);
  }
}
