// Import an OpenRA .oramap package into a WebRA map, in the browser.
//
// Steps: read the ZIP (zip.js), parse map.yaml (miniyaml.js) and map.bin
// (mapbin.js), convert (convert.js), drop rules overrides the engine refuses,
// then validate the result like any other map file (packages/protocol, and
// the engine when the caller passes its validator). Nothing in the package is
// executed: Lua and unsupported rules are only listed in the report.

import { looksLikeZip, openZip, ZipError } from './zip.js';
import { MiniYamlError, parseMiniYaml } from './miniyaml.js';
import { MapBinError, readMapBin } from './mapbin.js';
import { convertOramap, OramapError, vetRules } from './convert.js';
import { validateMap as protocolValidateMap } from '../protocol.js';

export { OramapError } from './convert.js';

/** Largest .oramap file the importer opens (packages carry a PNG preview). */
export const ORAMAP_MAX_BYTES = 16 * 1024 * 1024;
/** Rules/Weapons files read from one package. */
const MAX_YAML_FILES = 16;

/** Whether a picked file should go through the .oramap importer. */
export function isOramapFile(name, bytes) {
  if (/\.oramap$/i.test(String(name ?? ''))) return true;
  return bytes instanceof Uint8Array && looksLikeZip(bytes);
}

/**
 * @param {Uint8Array} bytes the .oramap file
 * @param {object} opts
 * @param {{ actors: object[], weapons: object[] }} opts.baseRules engine rules (`base_rules_json()`)
 * @param {(json: string) => { ok: boolean, errors: string[], modded?: boolean }} [opts.validate] the engine's map validator
 * @param {string} [opts.fileName]
 * @returns {Promise<{ map: object, json: string, report: object }>} `report.validation` holds the final check
 * @throws {OramapError} when the package cannot be converted (message for the player, partial report)
 */
export async function importOramap(bytes, opts) {
  try {
    if (!(bytes instanceof Uint8Array)) throw new OramapError('The file could not be read.');
    if (bytes.length > ORAMAP_MAX_BYTES) throw new OramapError(`The file is larger than ${ORAMAP_MAX_BYTES / 1024 / 1024} MiB.`);
    const zip = openZip(bytes);
    // Maps zipped together with their folder: use that folder.
    let prefix = '';
    if (!zip.has('map.yaml')) {
      const nested = zip.names().filter((n) => /^[^/]+\/map\.yaml$/.test(n));
      if (nested.length !== 1) throw new OramapError('This is not an OpenRA map: map.yaml is missing.');
      prefix = nested[0].slice(0, -'map.yaml'.length);
    }
    if (!zip.has(`${prefix}map.bin`)) throw new OramapError('This is not an OpenRA map: map.bin is missing.');
    const yaml = parseMiniYaml(await zip.readText(`${prefix}map.yaml`), 'map.yaml');
    const bin = readMapBin(await zip.read(`${prefix}map.bin`));

    // Rules/Weapons files referenced by map.yaml, read up front (conversion is synchronous).
    const files = zip.names().filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length));
    const yamlFiles = new Map();
    for (const key of ['Rules', 'Weapons']) {
      const node = yaml.find((n) => n.key === key);
      for (const ref of String(node?.value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        if (ref.includes('|') || yamlFiles.has(ref) || !zip.has(prefix + ref)) continue;
        if (yamlFiles.size >= MAX_YAML_FILES) throw new OramapError(`The map references more than ${MAX_YAML_FILES} rules files.`);
        yamlFiles.set(ref, parseMiniYaml(await zip.readText(prefix + ref), ref));
      }
    }
    const { map, report } = convertOramap(
      { yaml, bin, files, yamlFile: (name) => yamlFiles.get(name) ?? null },
      { baseRules: opts.baseRules, fileName: opts.fileName },
    );
    const dups = zip.duplicateNames();
    if (dups.length) report.warnings.push(`The package lists ${dups.slice(0, 3).join(', ')} more than once; the first copy was used.`);
    const extra = files.filter((f) => !/^(map\.(yaml|bin|png)|.*\.lua)$/i.test(f) && !yamlFiles.has(f) && !f.endsWith('/'));
    if (extra.length) report.unsupported.push(`Other files in the package were ignored: ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ', ...' : ''}.`);

    vetRules(map, report, opts.validate);
    const json = JSON.stringify(map);
    const checked = protocolValidateMap(map);
    const errors = checked.ok ? [] : checked.errors;
    if (checked.ok && typeof opts.validate === 'function') {
      const v = opts.validate(json);
      if (!v.ok) errors.push(...(v.errors ?? ['The engine refused the map.']));
    }
    report.validation = { ok: errors.length === 0, errors };
    return { map, json, report };
  } catch (err) {
    if (err instanceof OramapError) throw err;
    if (err instanceof ZipError || err instanceof MiniYamlError || err instanceof MapBinError) {
      throw new OramapError(`The .oramap file is damaged or not supported: ${err.message}`);
    }
    throw err;
  }
}
