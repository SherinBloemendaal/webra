// Settings forms generated from the settings registry schema (js/registry.js
// GROUPS): one fieldset per group, one control per setting, for the admin's
// settings editor (apps/website/assets/admin.js). Values are checked with the
// registry's strict rules (checkValue), so what the form gives is what the
// account accepts. DOM only through createElement and textContent.

import { GROUPS, checkValue, specOf } from '../registry.js';
import { switchInput } from '../ui/controls.js';

/** How a setting is edited: the control kind and its attributes. */
export function controlFor(spec) {
  switch (spec.type) {
    case 'number':
      return { kind: 'number', attrs: { type: 'number', min: String(spec.min), max: String(spec.max), step: String(spec.step ?? 'any'), inputmode: 'decimal' } };
    case 'integer':
      return { kind: 'number', attrs: { type: 'number', min: String(spec.min), max: String(spec.max), step: '1', inputmode: 'numeric' } };
    case 'scale':
      return {
        kind: 'text',
        attrs: { type: 'text', spellcheck: 'false', autocapitalize: 'off' },
        hint: `"auto", or a number from ${spec.min} to ${spec.max} (1 = 100%).`,
      };
    case 'boolean':
      return { kind: 'checkbox', attrs: { type: 'checkbox' } };
    case 'choice':
      return { kind: 'select', options: spec.options.map((o) => ({ value: String(o), label: spec.labels?.[o] ?? String(o) })) };
    case 'string':
      return { kind: 'text', attrs: { type: 'text', maxlength: String(spec.maxLength), spellcheck: 'false' } };
    case 'keymap':
      return { kind: 'textarea', rows: 4, hint: 'One action per line: name: Key, Other+Key. Nothing after the colon leaves it without a key.' };
    case 'packs':
      return { kind: 'textarea', rows: 3, hint: 'One pack per line, highest priority first: on or off, then the pack id ("on desert tiles|someone").' };
    case 'json':
      return { kind: 'textarea', rows: 5, hint: 'A JSON object.' };
    case 'presets':
      return { kind: 'textarea', rows: 5, hint: 'A JSON list of saved game modes: [{ "name": ..., "options": { every mode option } }].' };
    default:
      return { kind: 'text', attrs: { type: 'text' } };
  }
}

/** The text a control shows for a value. */
export function formatValue(spec, value) {
  switch (spec.type) {
    case 'boolean':
      return !!value;
    case 'keymap':
      return Object.entries(value ?? {})
        .map(([action, keys]) => `${action}: ${keys.join(', ')}`)
        .join('\n');
    case 'packs':
      return (value ?? []).map((p) => `${p.enabled ? 'on' : 'off'} ${p.id}`).join('\n');
    case 'json':
    case 'presets':
      return value === null || value === undefined ? '' : JSON.stringify(value, null, 2);
    default:
      return value === null || value === undefined ? '' : String(value);
  }
}

/**
 * A value from a control's text (or checked state for booleans), checked
 * with the account's rules. Returns `{ value }` or `{ error }`.
 */
export function parseValue(spec, input) {
  let value;
  switch (spec.type) {
    case 'number':
    case 'integer': {
      if (String(input).trim() === '') return { error: 'needs a number' };
      value = Number(input);
      break;
    }
    case 'scale': {
      const text = String(input).trim();
      if (text === '') return { error: 'needs "auto" or a number' };
      value = text.toLowerCase() === 'auto' ? 'auto' : Number(text);
      break;
    }
    case 'boolean':
      value = !!input;
      break;
    case 'choice': {
      value = spec.options.find((o) => String(o) === String(input));
      if (value === undefined) return { error: 'is not one of the choices' };
      break;
    }
    case 'string':
      value = String(input).trim();
      if (value === '' && spec.nullable) value = null;
      break;
    case 'keymap': {
      value = {};
      for (const line of String(input).split('\n')) {
        if (!line.trim()) continue;
        const m = /^\s*([^:\s]+)\s*:(.*)$/.exec(line);
        if (!m) return { error: `line "${line.trim().slice(0, 40)}" needs "name: keys"` };
        value[m[1]] = m[2].split(',').map((k) => k.trim()).filter(Boolean);
      }
      break;
    }
    case 'packs': {
      value = [];
      for (const line of String(input).split('\n')) {
        if (!line.trim()) continue;
        const m = /^\s*(on|off)\s+(.+?)\s*$/i.exec(line);
        if (!m) return { error: `line "${line.trim().slice(0, 40)}" needs "on" or "off" and a pack id` };
        value.push({ id: m[2], enabled: m[1].toLowerCase() === 'on' });
      }
      break;
    }
    case 'json':
    case 'presets': {
      const text = String(input).trim();
      if (!text) value = spec.type === 'presets' ? [] : spec.nullable ? null : {};
      else {
        try {
          value = JSON.parse(text);
        } catch (err) {
          return { error: `is not valid JSON (${err.message})` };
        }
      }
      break;
    }
    default:
      value = input;
  }
  const problem = checkValue(spec, value);
  return problem ? { error: problem } : { value };
}

const mk = (tag, attrs = {}, text) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
};

let uid = 0;

/**
 * The structured settings form for a document (`{ group: { key: value } }`,
 * missing values shown as defaults). `read()` gives `{ document, errors }`
 * (errors as `{ path, message }`); `onInput` is called on every edit.
 * @param {object} doc
 * @param {{ onInput?: () => void, groups?: string[], readOnly?: boolean }} [o]
 */
export function buildSettingsForm(doc, { onInput = () => {}, groups = Object.keys(GROUPS), readOnly = false } = {}) {
  const root = mk('div', { class: 'settings-form' });
  const controls = [];
  for (const group of groups) {
    const g = GROUPS[group];
    const fs = mk('fieldset', { class: 'settings-group' });
    fs.append(mk('legend', {}, g.label));
    if (g.description) fs.append(mk('p', { class: 'form-help' }, g.description));
    for (const [key, spec] of Object.entries(g.settings)) {
      const id = `setting-${group}-${key}-${++uid}`;
      const c = controlFor(spec);
      const current = doc?.[group]?.[key] ?? spec.default;
      let input;
      if (c.kind === 'select') {
        input = mk('select', { id });
        for (const o of c.options) {
          const opt = mk('option', { value: o.value }, o.label);
          input.append(opt);
        }
        input.value = String(current);
      } else if (c.kind === 'textarea') {
        input = mk('textarea', { id, rows: String(c.rows), spellcheck: 'false' });
        input.value = formatValue(spec, current);
      } else if (c.kind === 'checkbox') {
        input = switchInput({ id, checked: formatValue(spec, current) });
      } else {
        input = mk('input', { id, ...c.attrs });
        input.value = formatValue(spec, current);
      }
      if (readOnly) input.setAttribute('disabled', '');
      const error = mk('p', { class: 'form-status form-status-error', id: `${id}-error`, hidden: '' });
      const hintText = [spec.help, c.hint].filter(Boolean).join(' ');
      const hint = hintText ? mk('p', { class: 'form-help', id: `${id}-hint` }, hintText) : null;
      input.setAttribute('aria-describedby', [hint ? `${id}-hint` : null, `${id}-error`].filter(Boolean).join(' '));
      const row = mk('div', { class: c.kind === 'checkbox' ? 'check setting-row' : 'field setting-row' });
      const label = mk('label', { for: id }, spec.label);
      if (c.kind === 'checkbox') row.append(input, label);
      else row.append(label, input);
      if (hint) row.append(hint);
      row.append(error);
      input.addEventListener(c.kind === 'checkbox' || c.kind === 'select' ? 'change' : 'input', () => {
        validate(entry);
        onInput();
      });
      const entry = { group, key, spec, input, error, kind: c.kind };
      controls.push(entry);
      fs.append(row);
    }
    root.append(fs);
  }

  function validate(entry) {
    const r = parseValue(entry.spec, entry.kind === 'checkbox' ? entry.input.checked : entry.input.value);
    entry.error.textContent = r.error ? `${entry.spec.label} ${r.error}.` : '';
    entry.error.hidden = !r.error;
    if (r.error) entry.input.setAttribute('aria-invalid', 'true');
    else entry.input.removeAttribute('aria-invalid');
    return r;
  }

  return {
    node: root,
    controls,
    /** The edited document (unknown parts of `doc`, such as extra keys of other builds, are kept). */
    read() {
      const out = structuredClone(doc ?? {});
      const errors = [];
      for (const entry of controls) {
        const r = validate(entry);
        if (r.error) errors.push({ path: `${entry.group}.${entry.key}`, message: r.error });
        else (out[entry.group] ??= {})[entry.key] = r.value;
      }
      out.schema = 1;
      for (const g of Object.keys(out)) {
        if (g === 'schema' || !out[g] || typeof out[g] !== 'object') continue;
        for (const [k, v] of Object.entries(out[g])) if (v === null && specOf(g, k)?.nullable) delete out[g][k];
      }
      return { document: out, errors };
    },
  };
}
