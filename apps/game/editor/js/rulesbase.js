// Built-in actors and weapons keyed by id: the shape map rules overrides use
// (docs/contracts.md section 2). Built from the engine's own rules
// (`base_rules_json()` in the wasm package), so there is no copy to keep in sync.

/** @param rules parsed engine rules ({ armor_types, actors: [...], weapons: [...] }) */
export function rulesBaseFrom(rules) {
  return {
    armorTypes: rules.armor_types,
    weaponNames: rules.weapons.map((w) => w.name),
    actors: Object.fromEntries(rules.actors.map((a) => [a.id, a])),
    weapons: Object.fromEntries(rules.weapons.map((w) => [w.name, w])),
  };
}
