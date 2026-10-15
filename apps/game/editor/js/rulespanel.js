// Rules overrides tab: a structured editor for common actor and weapon values,
// and a raw JSON view. Every change is an undoable document edit.

import { base_rules_json } from '../../pkg/webra_sim.js';
import { rulesBaseFrom } from './rulesbase.js';
import { SELL_VALUE, countOverrides, getPath, pruneOverrides, validateOverrides } from './overrides.js';
import { el } from './ui.js';
import { nextControlId, selectPlate } from '../../js/ui/controls.js';

export const MODDED_WARNING = 'This map changes game rules (costs, damage, speed...). It can be unfair or act as a cheat.';

const TICKS_PER_SECOND = 25;
const WU_PER_CELL = 1024;

const cells = (v) => `${(v / WU_PER_CELL).toFixed(2)} cells`;
const seconds = (v) => `${(v / TICKS_PER_SECOND).toFixed(1)} s`;

const ACTOR_FIELDS = [
  { path: 'cost', label: 'Cost', min: 0 },
  // OpenRA CustomSellValue: sell, repair and bounty value instead of the cost (pillboxes, refineries,
  // walls). Every actor can get one; its default is the built-in one, else the cost (see renderForm).
  { path: SELL_VALUE, label: 'Sell value', min: 0, max: 1_000_000, sellValue: true },
  { path: 'build_ticks', label: 'Build time (ticks)', min: 0, hint: seconds },
  { path: 'hp', label: 'Hit points', min: 1 },
  { path: 'armor', label: 'Armor', kind: 'armor' },
  { path: 'sight', label: 'Sight', min: 0, hint: cells },
  { path: 'turret_turn_speed', label: 'Turret turn speed', min: 0 },
  { path: 'reload_override', label: 'Reload (ticks)', min: 0, hint: seconds },
  { path: 'unit.speed', label: 'Speed', min: 0 },
  { path: 'unit.turn_speed', label: 'Turn speed', min: 0 },
  { path: 'building.power', label: 'Power (+ makes, - uses)' },
  { path: 'building.storage', label: 'Ore storage', min: 0 },
  { path: 'building.sell_refund', label: 'Sell refund (%)', min: 0 },
];

const WEAPON_FIELDS = [
  { path: 'range', label: 'Range', min: 0, hint: cells },
  { path: 'min_range', label: 'Minimum range', min: 0, hint: cells },
  { path: 'reload', label: 'Reload (ticks)', min: 0, hint: seconds },
  { path: 'burst', label: 'Burst', min: 1 },
  { path: 'speed', label: 'Projectile speed', min: 0 },
  { path: 'inaccuracy', label: 'Inaccuracy', min: 0, hint: cells },
];

const WARHEAD_FIELDS = [
  { key: 'damage', label: 'Damage', min: 0 },
  { key: 'spread', label: 'Spread', min: 0, hint: cells },
];

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export class RulesPanel {
  /**
   * @param root container element
   * @param doc MapDoc
   * @param base built-in rules keyed by id ({ armorTypes, weaponNames, actors, weapons }), see rulesbase.js
   */
  constructor(root, doc, base) {
    this.root = root;
    this.doc = doc;
    this.base = base;
    this.section = 'actors';
    this.selected = { actors: 'FACT', weapons: Object.keys(base.weapons)[0] };
    this.filter = '';
    this.rawMode = false;
    this.build();
    doc.onChange((c) => c.meta && this.refresh());
    this.refresh();
  }

  build() {
    this.banner = el('div', { class: 'modded-banner' }, [el('strong', {}, 'MODDED MAP. '), MODDED_WARNING]);
    this.badge = el('span', { class: 'badge' });
    this.sectionButtons = ['actors', 'weapons'].map((s) =>
      el('button', { type: 'button', class: 'seg', onclick: () => this.setSection(s) }, s === 'actors' ? 'Actors' : 'Weapons'),
    );
    this.rawButton = el('button', { type: 'button', class: 'seg', onclick: () => this.setRaw(!this.rawMode) }, 'Raw JSON');
    this.clearButton = el('button', { type: 'button', class: 'danger-link', onclick: () => this.clearAll() }, 'Clear all');
    this.search = el('input', { type: 'search', placeholder: 'Filter', oninput: () => ((this.filter = this.search.value.trim().toLowerCase()), this.renderList()) });
    this.list = el('div', { class: 'rules-list' });
    this.form = el('div', { class: 'rules-form' });
    this.structured = el('div', { class: 'rules-structured' }, [el('div', { class: 'rules-left' }, [this.search, this.list]), this.form]);
    this.rawText = el('textarea', { class: 'rules-raw', spellcheck: 'false', rows: 16 });
    this.rawErrors = el('ul', { class: 'issues' });
    this.raw = el('div', { class: 'rules-rawview', hidden: true }, [
      el('p', { class: 'hint' }, 'A partial copy of engine/rules.json keyed by id: { "actors": { "1TNK": { "cost": 400 } }, "weapons": { "25mm": { "range": 6000 } } }. Use null or {} for no overrides.'),
      this.rawText,
      el('div', { class: 'row' }, [
        el('button', { type: 'button', class: 'primary', onclick: () => this.applyRaw() }, 'Apply JSON'),
        el('button', { type: 'button', onclick: () => this.refreshRaw(true) }, 'Revert'),
      ]),
      this.rawErrors,
    ]);
    this.root.append(
      el('p', { class: 'hint' }, 'Overrides change unit and weapon values for games on this map (the rules.ini of the original). Any override marks the map as MODDED; players must accept a warning before playing it.'),
      this.banner,
      el('div', { class: 'row rules-bar' }, [...this.sectionButtons, this.rawButton, this.badge, this.clearButton]),
      this.structured,
      this.raw,
    );
  }

  get overrides() {
    return this.doc.rules ?? {};
  }

  /** The key an override uses for a built-in id (existing keys match case-insensitively). */
  overrideKey(section, id) {
    const entries = this.overrides[section] ?? {};
    return Object.keys(entries).find((k) => k.toLowerCase() === id.toLowerCase()) ?? id;
  }

  entryOverride(section, id) {
    return this.overrides[section]?.[this.overrideKey(section, id)] ?? {};
  }

  setSection(s) {
    this.section = s;
    this.rawMode = false;
    this.refresh();
  }

  setRaw(on) {
    this.rawMode = on;
    this.refresh();
  }

  refresh() {
    const n = countOverrides(this.doc.rules);
    this.banner.hidden = !pruneOverrides(this.doc.rules);
    this.badge.textContent = n ? `${n} override${n === 1 ? '' : 's'}` : 'No overrides';
    this.badge.classList.toggle('on', n > 0);
    this.clearButton.disabled = n === 0;
    this.sectionButtons.forEach((b, i) => b.classList.toggle('active', !this.rawMode && ['actors', 'weapons'][i] === this.section));
    this.rawButton.classList.toggle('active', this.rawMode);
    this.structured.hidden = this.rawMode;
    this.raw.hidden = !this.rawMode;
    if (this.rawMode) this.refreshRaw(false);
    else {
      this.renderList();
      this.renderForm();
    }
  }

  renderList() {
    const section = this.section;
    const entries = Object.entries(this.base[section]);
    const items = entries
      .filter(([id, e]) => !this.filter || id.toLowerCase().includes(this.filter) || (e.name ?? '').toLowerCase().includes(this.filter))
      .map(([id, e]) => {
        const changed = Object.keys(this.entryOverride(section, id)).length > 0;
        return el(
          'button',
          {
            type: 'button',
            class: `rules-item${id === this.selected[section] ? ' active' : ''}${changed ? ' changed' : ''}`,
            title: changed ? 'Has overrides' : '',
            onclick: () => {
              this.selected[section] = id;
              this.renderList();
              this.renderForm();
            },
          },
          [el('span', { class: 'id' }, id), section === 'actors' ? el('span', { class: 'name' }, e.name) : null],
        );
      });
    this.list.replaceChildren(...items);
  }

  renderForm() {
    const section = this.section;
    const id = this.selected[section];
    const base = this.base[section][id];
    if (!base) {
      this.form.replaceChildren();
      return;
    }
    const over = this.entryOverride(section, id);
    const rows = [];
    const fields = section === 'actors' ? ACTOR_FIELDS : WEAPON_FIELDS;
    for (const f of fields) {
      if (f.sellValue) {
        rows.push(...this.sellValueRows(f, id, base, over));
        continue;
      }
      const b = getPath(base, f.path);
      if (typeof b !== 'number') continue; // unset optional fields cannot be overridden
      rows.push(this.fieldRow(f, b, getPath(over, f.path), (v) => this.setField(section, id, f.path, v)));
    }
    if (section === 'weapons') {
      const warheads = over.warheads ?? base.warheads;
      base.warheads.forEach((wh, i) => {
        for (const f of WARHEAD_FIELDS) {
          if (typeof wh[f.key] !== 'number') continue;
          const label = base.warheads.length > 1 ? `${f.label} (warhead ${i + 1})` : f.label;
          const cur = over.warheads ? warheads[i]?.[f.key] : undefined;
          rows.push(this.fieldRow({ ...f, label }, wh[f.key], cur === wh[f.key] ? undefined : cur, (v) => this.setWarhead(id, i, f.key, v)));
        }
      });
    } else if (base.weapons?.length) {
      rows.push(
        el('p', { class: 'hint' }, [
          'Weapons: ',
          ...base.weapons.flatMap((w, i) => {
            const name = this.base.weaponNames[w];
            return [i ? ', ' : '', el('a', { href: '#', onclick: (e) => (e.preventDefault(), this.jumpWeapon(name)) }, name)];
          }),
        ]),
      );
    }
    const others = Object.keys(over).filter(
      (k) => !(section === 'actors' ? ACTOR_FIELDS : WEAPON_FIELDS).some((f) => f.path.split('.')[0] === k) && k !== 'warheads',
    );
    if (others.length) rows.push(el('p', { class: 'hint' }, `Also overridden (edit in Raw JSON): ${others.join(', ')}`));
    this.form.replaceChildren(
      el('h3', {}, [id, base.name && section === 'actors' ? el('span', { class: 'muted' }, ` ${base.name}`) : null]),
      ...rows,
      el('div', { class: 'row' }, [
        el('button', { type: 'button', disabled: !Object.keys(over).length, onclick: () => this.resetEntry(section, id) }, `Reset ${id}`),
      ]),
    );
  }

  fieldRow(f, baseValue, value, onSet) {
    const changed = value !== undefined && value !== baseValue;
    let input;
    // A select plate is a button: its row is a div named by the label (a <label> around it would open the list).
    const nameId = f.kind === 'armor' ? nextControlId('rules-armor') : null;
    if (f.kind === 'armor') {
      input = selectPlate({
        label: f.label,
        labelledBy: nameId,
        options: this.base.armorTypes.map((name, i) => ({ value: i, label: name })),
        value: value ?? baseValue,
        block: true,
        small: true,
        onChange: (v) => onSet(Number(v)),
      }).root;
    } else {
      input = el('input', {
        type: 'number',
        step: '1',
        min: f.min !== undefined ? String(f.min) : undefined,
        value: changed ? String(value) : '',
        placeholder: String(baseValue),
        onchange: () => {
          const raw = input.value.trim();
          if (raw === '') return onSet(undefined);
          const n = Number(raw);
          if (!Number.isInteger(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
            const range = [f.min !== undefined ? ` of at least ${f.min}` : '', f.max !== undefined ? ` and at most ${f.max}` : ''].join('');
            input.setCustomValidity(`Whole number${range}`);
            input.reportValidity();
            return;
          }
          input.setCustomValidity('');
          onSet(n);
        },
      });
    }
    const shown = value ?? baseValue;
    return el(nameId ? 'div' : 'label', { class: `field${changed ? ' changed' : ''}` }, [
      el('span', { class: 'label', id: nameId }, f.label),
      input,
      el('span', { class: 'default' }, [
        el('span', {}, [
          changed ? `was ${f.kind === 'armor' ? this.base.armorTypes[baseValue] : baseValue}` : 'default',
          f.hint && typeof shown === 'number' ? ` (${f.hint(shown)})` : '',
        ]),
        changed ? el('button', { type: 'button', class: 'link', title: 'Reset to default', onclick: (e) => (e.preventDefault(), onSet(undefined)) }, 'reset') : null,
      ]),
    ]);
  }

  /**
   * The sell value (OpenRA GetSellValue): a number for any actor, and for one
   * with a built-in CustomSellValue a switch that takes it away (null, OpenRA
   * `-CustomSellValue`), so the cost counts again.
   */
  sellValueRows(f, id, base, over) {
    const builtIn = typeof base[SELL_VALUE] === 'number';
    const removed = builtIn && over[SELL_VALUE] === null;
    const cost = typeof over.cost === 'number' ? over.cost : base.cost;
    const rows = [];
    if (!removed) {
      const value = typeof over[SELL_VALUE] === 'number' ? over[SELL_VALUE] : undefined;
      rows.push(this.fieldRow(f, builtIn ? base[SELL_VALUE] : cost, value, (v) => this.setField('actors', id, f.path, v)));
    }
    if (builtIn) {
      const box = el('input', { type: 'checkbox', checked: removed, onchange: () => this.setField('actors', id, f.path, box.checked ? null : undefined) });
      rows.push(el('label', { class: `field${removed ? ' changed' : ''}` }, [box, ` Sell for the cost (${cost}), not the built-in sell value ${base[SELL_VALUE]}`]));
    }
    return rows;
  }

  jumpWeapon(name) {
    this.section = 'weapons';
    this.rawMode = false;
    this.selected.weapons = name;
    this.refresh();
  }

  /** Apply a new overrides object as one undoable step. */
  commit(rules, label, key) {
    this.doc.begin(label, key);
    this.doc.touchMeta();
    this.doc.rules = pruneOverrides(rules);
    this.doc.commit();
  }

  setField(section, id, path, value) {
    const base = this.base[section][id];
    const rules = clone(this.overrides);
    const key = this.overrideKey(section, id);
    rules[section] ??= {};
    rules[section][key] ??= {};
    const parts = path.split('.');
    let obj = rules[section][key];
    for (const p of parts.slice(0, -1)) obj = obj[p] ??= {};
    const last = parts[parts.length - 1];
    if (value === undefined || (value !== null && value === getPath(base, path))) delete obj[last];
    else obj[last] = value;
    this.commit(rules, `Override ${id} ${path}`, `rules.${section}.${id}.${path}`);
  }

  setWarhead(id, i, key, value) {
    const base = this.base.weapons[id];
    const rules = clone(this.overrides);
    const k = this.overrideKey('weapons', id);
    rules.weapons ??= {};
    rules.weapons[k] ??= {};
    const warheads = clone(rules.weapons[k].warheads ?? base.warheads);
    warheads[i][key] = value === undefined ? base.warheads[i][key] : value;
    if (JSON.stringify(warheads) === JSON.stringify(base.warheads)) delete rules.weapons[k].warheads;
    else rules.weapons[k].warheads = warheads;
    this.commit(rules, `Override ${id} warhead`, `rules.weapons.${id}.warheads.${i}.${key}`);
  }

  resetEntry(section, id) {
    const rules = clone(this.overrides);
    delete rules[section]?.[this.overrideKey(section, id)];
    this.commit(rules, `Reset ${id}`);
  }

  clearAll() {
    if (!confirm('Remove all rules overrides? The map will no longer be modded.')) return;
    this.commit(null, 'Clear overrides');
  }

  refreshRaw(force) {
    // Keep the user's unapplied text unless asked to revert.
    if (!force && this.rawDirty) return;
    this.rawText.value = JSON.stringify(pruneOverrides(this.doc.rules), null, 2);
    this.rawDirty = false;
    this.rawErrors.replaceChildren();
    this.rawText.oninput = () => (this.rawDirty = true);
  }

  applyRaw() {
    let value;
    try {
      value = JSON.parse(this.rawText.value.trim() || 'null');
    } catch (err) {
      this.showRawErrors([`Not valid JSON: ${err.message}`]);
      return;
    }
    if (value !== null && !isObject(value)) {
      this.showRawErrors(['Overrides must be an object or null.']);
      return;
    }
    const errors = validateOverrides(value, this.base);
    if (errors.length) {
      this.showRawErrors(errors);
      return;
    }
    this.rawDirty = false;
    this.commit(value, 'Edit rules JSON');
    this.showRawErrors([]);
    this.refreshRaw(true);
  }

  showRawErrors(errors) {
    this.rawErrors.replaceChildren(...errors.map((e) => el('li', { class: 'error' }, e)));
    if (!errors.length) this.rawErrors.append(el('li', { class: 'ok' }, 'Overrides are valid.'));
  }
}

/** Built-in actors and weapons keyed by id, from the engine (the wasm package must be initialised). */
export async function loadRulesBase() {
  return rulesBaseFrom(JSON.parse(base_rules_json()));
}

