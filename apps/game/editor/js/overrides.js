// Rules overrides (the rules.ini story): validation against the built-in rules
// and the deep merge the engine applies before a game starts. Pure module, no DOM.
//
// Overrides have the shape `{ actors: { ID: {...} }, weapons: { NAME: {...} } }`
// (docs/contracts.md section 2). The base rules are the same shape, keyed by id.
//
// Rules match the engine (engine/src/rules.rs apply_overrides): ids match
// case-insensitively, only existing fields, same JSON type, integers only, and
// id/name/kind/queue cannot change. Merge semantics: objects merge
// recursively; arrays and scalars replace the built-in value wholesale (so
// overriding one warhead's damage means sending the whole `warheads` array).

/** Fields that identify an entry; changing them would rename it, so they are rejected. */
const IDENTITY = { actors: 'id', weapons: 'name' };
/** Fields the engine never lets a map change (they decide which code runs). */
const LOCKED = new Set(['kind', 'queue']);

/** Find a built-in entry; ids match case-insensitively, like the engine. */
export function findEntry(base, section, id) {
  const entries = base?.[section];
  if (!entries) return undefined;
  if (entries[id]) return entries[id];
  const lower = String(id).toLowerCase();
  const key = Object.keys(entries).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : entries[key];
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/**
 * Check one override value against the built-in value at the same path.
 * Pushes human-readable errors into `errors`.
 */
function checkValue(path, value, base, errors) {
  if (base === undefined) {
    errors.push(`${path}: unknown field`);
    return;
  }
  if (base === null) {
    // The engine only accepts a value of the same JSON type as the built-in one,
    // so optional fields that are unset (null) cannot be overridden.
    errors.push(`${path}: has no built-in value and cannot be overridden`);
    return;
  }
  if (value === null) {
    errors.push(`${path}: expected ${typeName(base) === 'integer' ? 'a number' : typeName(base)}, got null`);
    return;
  }
  if (isObject(base)) {
    if (!isObject(value)) {
      errors.push(`${path}: expected an object, got ${typeName(value)}`);
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (LOCKED.has(k)) errors.push(`${path}.${k}: cannot be overridden`);
      else checkValue(`${path}.${k}`, v, base[k], errors);
    }
    return;
  }
  if (Array.isArray(base)) {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected an array, got ${typeName(value)}`);
      return;
    }
    // Arrays replace wholesale; check elements against the first built-in element
    // (all built-in arrays are homogeneous).
    if (base.length > 0) {
      value.forEach((v, i) => checkValue(`${path}[${i}]`, v, base[0], errors));
    }
    return;
  }
  if (typeof base === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${path}: expected a number, got ${typeName(value)}`);
      return;
    }
    if (!Number.isInteger(value)) {
      errors.push(`${path}: expected an integer, got ${value}`);
      return;
    }
    if (base >= 0 && value < 0) errors.push(`${path}: must not be negative`);
    return;
  }
  if (typeof value !== typeof base) {
    errors.push(`${path}: expected ${typeName(base)}, got ${typeName(value)}`);
  }
}

/**
 * Validate a `rules` overrides object. `base` is `{ actors: {id: obj}, weapons: {name: obj} }`.
 * Returns a list of error strings (empty when valid). `null` is valid (no overrides).
 */
export function validateOverrides(rules, base) {
  const errors = [];
  if (rules === null || rules === undefined) return errors;
  if (!isObject(rules)) return [`rules: expected an object or null, got ${typeName(rules)}`];
  for (const [section, entries] of Object.entries(rules)) {
    if (!(section in IDENTITY)) {
      errors.push(`rules.${section}: unknown section (expected actors or weapons)`);
      continue;
    }
    if (!isObject(entries)) {
      errors.push(`rules.${section}: expected an object keyed by id, got ${typeName(entries)}`);
      continue;
    }
    for (const [id, fields] of Object.entries(entries)) {
      const path = `rules.${section}.${id}`;
      const builtIn = findEntry(base, section, id);
      if (!builtIn) {
        errors.push(`${path}: unknown ${section === 'actors' ? 'actor' : 'weapon'} id`);
        continue;
      }
      if (!isObject(fields)) {
        errors.push(`${path}: expected an object, got ${typeName(fields)}`);
        continue;
      }
      for (const [k, v] of Object.entries(fields)) {
        if (k === IDENTITY[section] || LOCKED.has(k)) {
          errors.push(`${path}.${k}: cannot be overridden`);
          continue;
        }
        checkValue(`${path}.${k}`, v, builtIn[k], errors);
      }
      if (fields.hp !== undefined && typeof fields.hp === 'number' && fields.hp < 1) {
        errors.push(`${path}.hp: must be at least 1`);
      }
    }
  }
  return errors;
}

/** Deep merge: objects recurse, everything else replaces. Returns a new value. */
export function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return structuredCloneJson(over);
  const out = structuredCloneJson(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out ? deepMerge(out[k], v) : structuredCloneJson(v);
  }
  return out;
}

function structuredCloneJson(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Remove empty objects so `{ actors: { E1: {} } }` collapses to null. */
export function pruneOverrides(rules) {
  if (!isObject(rules)) return null;
  const prune = (v) => {
    if (!isObject(v)) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x);
      if (isObject(p) && Object.keys(p).length === 0) continue;
      out[k] = p;
    }
    return out;
  };
  const out = prune(rules);
  return Object.keys(out).length === 0 ? null : out;
}

/** Number of overridden fields over all actors and weapons (for the "N changes" badge). */
export function countOverrides(rules) {
  if (!isObject(rules)) return 0;
  let n = 0;
  for (const section of Object.values(rules)) {
    if (!isObject(section)) continue;
    for (const fields of Object.values(section)) {
      if (isObject(fields)) n += Object.keys(fields).length;
    }
  }
  return n;
}

/** Read a value at a dotted path such as `unit.speed` or `warheads.0.damage`. */
export function getPath(obj, path) {
  let v = obj;
  for (const k of path.split('.')) {
    if (v === null || v === undefined) return undefined;
    v = v[k];
  }
  return v;
}
