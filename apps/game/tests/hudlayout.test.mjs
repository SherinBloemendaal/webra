// The top-left HUD (index.html #hud-stack, css/style.css): the status line,
// the weather badge, the mission objectives, the support power bar and the
// support power timers sit in one column that grows downwards, so none of
// them can overlap another at any viewport size. There is no layout engine
// here: the test checks the markup, that only the column itself is
// positioned (everything inside flows), that the parts may shrink to the
// column's width, and where the game mounts each part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PowerBar } from '../js/powers.js';
import { PowerTimers } from '../js/powertimers.js';
import { MissionView } from '../js/campaign/view.js';
import { MissionFeed } from '../js/sim/proxy.js';
import { installDom, uninstallDom } from './dom-fixtures.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const HTML = read('../index.html');
const CSS_DIR = fileURLToPath(new URL('../css/', import.meta.url));
const CSS = readdirSync(CSS_DIR)
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(CSS_DIR + f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
  .join('\n');

/** Every innermost rule as [selector, declarations] (rules inside @media too). */
function rules(css) {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = Object.fromEntries(
      m[2]
        .split(';')
        .map((d) => d.split(':'))
        .filter((d) => d.length >= 2)
        .map(([k, ...v]) => [k.trim(), v.join(':').trim()]),
    );
    for (const sel of m[1].split(',')) out.push([sel.trim(), decls]);
  }
  return out;
}
const RULES = rules(CSS);
/** The declarations of rules whose selector ends with `target` (a descendant or compound of it). */
const declsFor = (target) => RULES.filter(([sel]) => sel === target || sel.endsWith(` ${target}`) || sel.endsWith(`>${target}`) || sel.endsWith(`> ${target}`));

test('the top-left HUD is one column inside the battlefield: status, weather, then the power row', () => {
  const field = HTML.slice(HTML.indexOf('<main id="field">'), HTML.indexOf('</main>'));
  const stack = field.slice(field.indexOf('<div id="hud-stack">'));
  const at = (id) => stack.indexOf(`id="${id}"`);
  assert.ok(at('hud') > 0 && at('weather') > at('hud') && at('hud-row') > at('weather'), 'hud, weather, hud-row in this order');
  assert.ok(stack.indexOf('</div>\n        </div>') > at('hud-row'), 'all three inside #hud-stack');
});

test('only the column is positioned; what is in it flows and may shrink to its width', () => {
  const position = (id) => declsFor(id).map(([, d]) => d.position).filter(Boolean);
  assert.deepEqual(position('#hud-stack'), ['absolute']);
  for (const id of ['#hud', '#weather', '#hud-row', '#powers', '#power-timers']) {
    assert.deepEqual(position(id), [], `${id} is not positioned on its own`);
  }
  // The objectives panel floats elsewhere (the editor's test play) but flows in the column.
  assert.equal(declsFor('.mission-panel').find(([sel]) => sel === '#hud-stack > .mission-panel')?.[1].position, 'static');

  const stack = declsFor('#hud-stack')[0][1];
  assert.equal(stack['flex-direction'], 'column');
  assert.match(stack['max-width'], /100% -/, 'the column stays inside the battlefield');
  assert.equal(stack['pointer-events'], 'none', 'clicks between the parts reach the map');
  assert.match(declsFor('#weather')[0][1]['max-width'], /100%/, 'the badge shrinks with the column');
  const row = declsFor('#hud-row')[0][1];
  assert.equal(row.display, 'flex');
  assert.equal(row['min-width'], '0');
  const timers = declsFor('#power-timers').find(([sel]) => sel === '#power-timers')[1];
  assert.equal(timers['min-width'], '0', 'the timers shrink next to the bar');
  const line = declsFor('.power-timer').find(([sel]) => sel === '#power-timers .power-timer')[1];
  assert.equal(line['text-overflow'], 'ellipsis', 'a long line is cut, not pushed off the screen');
  // A hidden power bar takes no room (its display: flex would beat the hidden attribute).
  assert.equal(declsFor('#powers[hidden]')[0]?.[1].display, 'none');
  assert.equal(declsFor('#power-timers[hidden]')[0]?.[1].display, 'none');
});

test('the game mounts the power bar, then the timers in the row, and the objectives above the row', () => {
  // js/main.js puts them there.
  const main = read('../js/main.js');
  const barAt = main.indexOf("new PowerBar($('hud-row')");
  const timersAt = main.indexOf("new PowerTimers($('hud-row'))");
  assert.ok(barAt > 0 && timersAt > barAt, 'the bar first, then the timers, both in #hud-row');
  assert.ok(main.includes("panelBefore: $('hud-row')"), 'the objectives above the power row');
  installDom();
  try {
    const doc = globalThis.document;
    const field = doc.createElement('main');
    const stack = doc.createElement('div');
    const hud = doc.createElement('div');
    const weather = doc.createElement('div');
    const row = doc.createElement('div');
    const buttons = doc.createElement('div');
    stack.append(hud, weather, row);
    field.append(stack, buttons);
    const bar = new PowerBar(row, { ticksPerSecond: 25, onSelect() {} });
    const timers = new PowerTimers(row);
    assert.deepEqual([...row.children], [bar.root, timers.root]);
    const view = new MissionView({
      field,
      hudButtons: buttons,
      panelBefore: row,
      feed: new MissionFeed(),
      audio: null,
      centerOn() {},
      ping() {},
      toScreen: () => null,
      pxPerCell: 24,
      tickMs: 40,
      onRestart() {},
      onLeave() {},
    });
    assert.deepEqual([...stack.children], [hud, weather, view.panel, row]);
    assert.ok(![...stack.children].includes(view.messages), 'the message lines stay at the bottom of the field');
  } finally {
    uninstallDom();
  }
});
