// tools/gen_rules.py: OpenRA CustomSellValue as the actor's custom_sell_value,
// read from MiniYaml the way the generator reads data/source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** custom_sell_value of an actor with these MiniYaml traits (null: none). */
function sellValue(yaml) {
  const script = `
import json, sys
sys.path[:0] = [${JSON.stringify(join(root, 'tools'))}, ${JSON.stringify(join(root, 'data', 'source'))}]
import gen_rules, parse
defs = parse.parse_miniyaml(sys.stdin.read())
t = parse.to_json(parse.resolve_all(defs)['ACTOR'])
print(json.dumps(gen_rules.custom_sell_value(t)))
`;
  const r = spawnSync('python3', ['-I', '-B', '-c', script], { input: yaml, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('CustomSellValue: its Value, 0 by default (CustomSellValue.cs), none without the trait', () => {
  assert.equal(sellValue('ACTOR:\n\tValued:\n\t\tCost: 600\n\tCustomSellValue:\n\t\tValue: 400\n'), 400);
  assert.equal(sellValue('ACTOR:\n\tValued:\n\t\tCost: 600\n\tCustomSellValue:\n'), 0, 'a bare node');
  assert.equal(sellValue('ACTOR:\n\tCustomSellValue:\n\t\tValue:\n'), 0, 'an empty Value');
  assert.equal(sellValue('ACTOR:\n\tValued:\n\t\tCost: 600\n'), null);
  // -CustomSellValue removes an inherited one (the cost counts again).
  assert.equal(sellValue('^Base:\n\tCustomSellValue:\n\t\tValue: 0\nACTOR:\n\tInherits: ^Base\n\t-CustomSellValue:\n'), null);
  assert.equal(sellValue('^Base:\n\tCustomSellValue:\n\t\tValue: 0\nACTOR:\n\tInherits: ^Base\n'), 0);
});
