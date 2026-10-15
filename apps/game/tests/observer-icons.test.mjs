// The observer's icon panels (js/observer-icons.js, js/observer.js): the
// production, support power and army icons, their tooltips, the Vision and
// Derricks columns, team headers and faction flags, and that updates reuse
// the rows and icons instead of rebuilding them. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, uninstallDom } from './dom-fixtures.mjs';
import { armyIcons, armyIconTip, iconTime, IconStrip, powerIcons, powerIconTip, productionIcons, productionIconTip } from '../js/observer-icons.js';
import { ObserverPanel, PANELS, teamGroups } from '../js/observer.js';
import { drawPowerIcon, hasPowerEmblem } from '../js/art/powericons.js';
import { originalCameoPixels, originalPowerIconPixels } from '../js/content/cameos.js';
import { SEQUENCES } from '../js/content/tables.js';

const ACTORS = [
  {
    id: 'E1',
    name: 'Rifle Infantry',
    description: 'General-purpose infantry.',
    kind: 'infantry',
    queue: 2,
    order: 10,
    cost: 100,
    power: 0,
  },
  {
    id: 'DOG',
    name: 'Attack Dog',
    description: 'Anti-infantry.',
    kind: 'infantry',
    queue: 2,
    order: 50,
    cost: 200,
    power: 0,
  },
  {
    id: '1TNK',
    name: 'Light Tank',
    description: 'Fast tank.',
    kind: 'vehicle',
    queue: 3,
    order: 10,
    cost: 700,
    power: 0,
  },
  {
    id: 'POWR',
    name: 'Power Plant',
    description: 'Makes power.',
    kind: 'building',
    queue: 0,
    order: 10,
    cost: 300,
    power: 100,
  },
];
const BY_ID = new Map(ACTORS.map((a) => [a.id, a]));

const item = (o) => ({
  queue: 0,
  id: 'POWR',
  progress: 0,
  done: false,
  paused: false,
  remainingTicks: 0,
  buildTicks: 300,
  ...o,
});

test('iconTime is OpenRA FormatTime: whole seconds rounded up', () => {
  assert.equal(iconTime(0), '00:00');
  assert.equal(iconTime(1), '00:01');
  assert.equal(iconTime(25), '00:01');
  assert.equal(iconTime(26), '00:02');
  assert.equal(iconTime(25 * 75), '01:15');
  assert.equal(iconTime(25 * 3600), '1:00:00');
});

test('production icons: current items by tab and palette order, with the overlay text', () => {
  const prod = {
    queues: [
      item({ queue: 0, id: 'POWR', progress: 0.5, remainingTicks: 100 }),
      item({ queue: 2, id: 'E1', progress: 1, done: true }),
      item({
        queue: 3,
        id: '1TNK',
        progress: 0.2,
        paused: true,
        remainingTicks: 400,
      }),
    ],
  };
  const icons = productionIcons(prod, BY_ID);
  assert.deepEqual(
    icons.map((i) => [i.key, i.text, i.count, i.progress]),
    [
      ['POWR', '00:04', 1, 0.5],
      ['E1', 'Ready', 1, 1],
      ['1TNK', 'On hold', 1, 0.2],
    ],
  );
  // Unknown types are skipped; no data, no icons.
  assert.deepEqual(productionIcons({ queues: [item({ id: 'NOPE' })] }, BY_ID), []);
  assert.deepEqual(productionIcons(null, BY_ID), []);
});

test('production icons group one type built in several tabs: ready first, then the least time left', () => {
  const prod = {
    queues: [
      item({ queue: 3, id: '1TNK', remainingTicks: 300, progress: 0.1 }),
      item({ queue: 4, id: '1TNK', remainingTicks: 50, progress: 0.8 }),
      item({ queue: 2, id: 'DOG', paused: true }),
    ],
  };
  const icons = productionIcons(prod, BY_ID);
  assert.deepEqual(
    icons.map((i) => [i.key, i.count, i.text]),
    [
      ['DOG', 1, 'On hold'],
      ['1TNK', 2, '00:02'],
    ],
  );
  const withReady = productionIcons({ queues: [...prod.queues, item({ queue: 5, id: '1TNK', done: true })] }, BY_ID);
  assert.equal(withReady[1].text, 'Ready');
  assert.equal(withReady[1].count, 3);
});

test('support power icons: Ready only when charged with a powered provider, else the time left', () => {
  const prod = {
    powers: [
      {
        key: 'NukePower',
        icon: 'abomb',
        name: 'Atom Bomb',
        description: 'Boom.',
        progress: 0.25,
        ready: false,
        charging: true,
        remainingTicks: 250,
        totalTicks: 1000,
      },
      {
        key: 'GpsPower',
        icon: 'gps',
        name: 'GPS',
        description: 'Map.',
        progress: 1,
        ready: true,
        charging: true,
        remainingTicks: 0,
        totalTicks: 500,
      },
      {
        key: 'Chrono',
        icon: 'chrono',
        name: 'Chronoshift',
        description: 'Shift.',
        progress: 0.5,
        ready: false,
        charging: false,
        remainingTicks: 50,
        totalTicks: 100,
      },
      // Charged, but every provider is without power: not Ready in OpenRA (Active is false).
      {
        key: 'IronCurtain',
        icon: 'invuln',
        name: 'Iron Curtain',
        description: 'Shield.',
        progress: 1,
        ready: false,
        charging: false,
        remainingTicks: 0,
        totalTicks: 100,
      },
    ],
  };
  const icons = powerIcons(prod);
  assert.deepEqual(
    icons.map((i) => [i.key, i.text, i.progress, i.paused]),
    [
      ['NukePower', '00:10', 0.25, false],
      ['GpsPower', 'Ready', 1, false],
      ['Chrono', '00:02', 0.5, true],
      ['IronCurtain', '00:00', 1, true],
    ],
  );
  // Even if a client got ready without charging, it is not Ready.
  assert.equal(powerIcons({ powers: [{ ...prod.powers[3], ready: true }] })[0].text, '00:00');
  assert.equal(powerIconTip(icons[3]).stats[0].bad, true, 'red like OpenRA');
  const tip = powerIconTip(icons[0]);
  assert.equal(tip.title, 'Atom Bomb');
  assert.equal(tip.desc, 'Boom.');
  assert.deepEqual(tip.stats, [{ kind: 'time', label: 'charge time', text: '00:10 / 00:40', bad: false }]);
  // OpenRA turns the time red while the power is not active (paused without power).
  assert.equal(powerIconTip(icons[2]).stats[0].bad, true);
});

test('army icons and their tooltip', () => {
  const icons = armyIcons([0, 3, 2, 1, 99, 4], ACTORS);
  assert.deepEqual(
    icons.map((i) => [i.key, i.count]),
    [
      ['E1', 3],
      ['1TNK', 1],
    ],
  );
  assert.deepEqual(armyIconTip(icons[1]), {
    title: 'Light Tank',
    desc: 'Fast tank.',
  });
  assert.deepEqual(armyIcons(new Uint32Array(0), ACTORS), []);
});

test('production icon tooltip: cost, build time and power without hotkey or click hints', () => {
  const [icon] = productionIcons({ queues: [item({ remainingTicks: 10 })] }, BY_ID);
  const tip = productionIconTip(icon, {
    funds: 100,
    powerGenerated: 0,
    powerUsed: 0,
    lowPower: false,
  });
  assert.equal(tip.title, 'Power Plant');
  assert.equal(tip.hotkey, null);
  assert.deepEqual(tip.notes, []);
  const cost = tip.stats.find((s) => s.kind === 'cost');
  assert.equal(cost.bad, true, 'cannot afford it');
  assert.equal(tip.stats.find((s) => s.kind === 'time').text, '00:12');
  const slow = productionIconTip(icon, { funds: 1000, lowPower: true }, { lowPowerModifier: 200 });
  assert.deepEqual(
    slow.stats.find((s) => s.kind === 'time'),
    { kind: 'time', label: 'build time', text: '00:24', bad: true },
  );
});

test('team groups: ascending teams with headers, none without teams', () => {
  const s = (player, team) => ({ player, team });
  assert.deepEqual(
    teamGroups([s(0, 0), s(1, 0)]).map((g) => g.label),
    [null],
  );
  const groups = teamGroups([s(0, 2), s(1, 1), s(2, 0), s(3, 2)]);
  assert.deepEqual(
    groups.map((g) => [g.label, g.stats.map((x) => x.player)]),
    [
      ['No team', [2]],
      ['Team 1', [1]],
      ['Team 2', [0, 3]],
    ],
  );
});

test('the economy panel has Derricks and the combat panel Vision', () => {
  const col = (panel, name) => PANELS[panel].columns.find(([h]) => h === name)[1];
  assert.equal(col('economy', 'Derricks')({ derricks: 3 }, {}), '3');
  assert.equal(col('combat', 'Vision')({ vision: 42 }, {}), '42%');
  assert.equal(col('combat', 'Vision')({}, {}), '0%');
  for (const p of ['production', 'supportPowers', 'army']) assert.ok(PANELS[p].icons, p);
});

function statsOf(players) {
  return players.map(([player, team, faction]) => ({
    player,
    team,
    faction,
    funds: 1000,
    earned: 0,
    spent: 0,
    armyValue: 0,
    unitsKilled: 0,
    unitsLost: 0,
    buildingsKilled: 0,
    buildingsLost: 0,
    powerGenerated: 0,
    powerUsed: 0,
    vision: 12,
    derricks: 1,
  }));
}

function panel(opts = {}) {
  const doc = installDom();
  const parent = doc.createElement('div');
  doc.body.append(parent);
  const painted = [];
  const players = [
    { name: 'Ann', color: [1, 0, 0] },
    { name: 'Bob', color: [0, 0, 1] },
    { name: 'Cy', color: [0, 1, 0] },
  ];
  const p = new ObserverPanel(parent, {
    players,
    onView() {},
    actors: ACTORS,
    paintCameo: (canvas, actor, team) => painted.push(['cameo', actor.id, team]),
    paintPower: (canvas, icon) => painted.push(['power', icon]),
    ...opts,
  });
  return { doc, p, painted };
}

test('statistics rows: team headers, flags, and updates that only change text', () => {
  const { p } = panel({ panel: 'combat' });
  try {
    const stats = statsOf([
      [0, 1, 'england'],
      [1, 2, 'russia'],
      [2, 1, 'france'],
    ]);
    p.update(stats, 100);
    const teams = [...p.table.querySelectorAll('.observer-team')].map((t) => t.textContent);
    assert.deepEqual(teams, ['Team 1', 'Team 2']);
    const rows = [...p.table.querySelectorAll('.observer-row')].filter((r) => !r.classList.contains('observer-row-head') && !r.classList.contains('observer-team'));
    assert.deepEqual(
      rows.map((r) => r.querySelector('.observer-player').textContent),
      ['Ann', 'Cy', 'Bob'],
    );
    assert.deepEqual(
      rows.map((r) => r.querySelector('.observer-flag').dataset.faction),
      ['england', 'france', 'russia'],
    );
    const cells = [...rows[0].querySelectorAll('.observer-cell')];
    assert.equal(cells.at(-1).textContent, '12%', 'Vision');
    // The next update keeps the same elements and writes the new number.
    stats[0].vision = 30;
    p.update(stats, 125);
    const again = p.table.querySelectorAll('.observer-row')[2];
    assert.equal(again, rows[0], 'row reused');
    assert.equal([...again.querySelectorAll('.observer-cell')].at(-1).textContent, '30%');
    // Defeat only toggles a class.
    stats[0].defeated = true;
    p.update(stats, 150);
    assert.ok(rows[0].classList.contains('observer-defeated'));
  } finally {
    p.remove();
    uninstallDom();
  }
});

test('production panel: a strip of icons per player, painted once and reused', () => {
  const { p, painted } = panel({ panel: 'production' });
  try {
    assert.equal(p.needs(), 'production');
    const stats = statsOf([
      [0, 0, 'england'],
      [1, 0, 'russia'],
    ]);
    let prod = {
      funds: 500,
      queues: [item({ queue: 0, id: 'POWR', progress: 0.5, remainingTicks: 50 }), item({ queue: 3, id: '1TNK', remainingTicks: 100 })],
    };
    const extra = (player) => (player === 0 ? { production: prod } : { production: { queues: [] } });
    p.update(stats, 10, extra);
    assert.equal(p.table.querySelectorAll('.observer-team').length, 0, 'no teams, no headers');
    // The head lines up with the icon rows: the same column template class.
    const head = p.table.querySelector('.observer-row-head');
    const rows = [...p.table.querySelectorAll('.observer-row')].filter((r) => r !== head);
    assert.equal(rows.length, 2);
    for (const r of [head, ...rows]) assert.ok(r.classList.contains('observer-row-icons'), r.className);
    assert.equal(head.querySelectorAll('.observer-cell').length, 2, 'Player and the panel heading');
    const strip = p.table.querySelectorAll('.observer-icons')[0];
    const icons = [...strip.querySelectorAll('.observer-icon')];
    assert.equal(icons.length, 2);
    assert.deepEqual(
      icons.map((i) => i.querySelector('.observer-icon-text').textContent),
      ['00:02', '00:04'],
    );
    assert.equal(icons[0].getAttribute('aria-label'), 'Power Plant, 00:02');
    assert.deepEqual(painted, [
      ['cameo', 'POWR', [1, 0, 0]],
      ['cameo', '1TNK', [1, 0, 0]],
    ]);
    // Next update: the tank is ready, the plant is gone, a dog starts.
    prod = {
      queues: [item({ queue: 2, id: 'DOG', remainingTicks: 25 }), item({ queue: 3, id: '1TNK', done: true, progress: 1 })],
    };
    p.update(stats, 35, extra);
    const now = [...strip.querySelectorAll('.observer-icon')];
    assert.equal(now.length, 2);
    assert.equal(now[1], icons[1], 'the tank keeps its element');
    assert.equal(now[1].querySelector('.observer-icon-text').textContent, 'Ready');
    assert.ok(now[1].classList.contains('observer-icon-ready'));
    assert.equal(now[1].querySelector('.observer-icon-clock').hidden, true, 'no shade when done');
    assert.equal(painted.length, 3, 'only the new dog was painted');
    p.repaintIcons();
    assert.equal(painted.length, 5);
  } finally {
    p.remove();
    uninstallDom();
  }
});

test('a column panel head and rows do not use the icon template', () => {
  const { p } = panel({ panel: 'combat' });
  try {
    p.update(statsOf([[0, 0, 'england']]), 10);
    const rows = [...p.table.querySelectorAll('.observer-row')];
    assert.equal(rows.length, 2);
    for (const r of rows) assert.ok(!r.classList.contains('observer-row-icons'), r.className);
  } finally {
    p.remove();
    uninstallDom();
  }
});

test('support power and army panels', () => {
  const { p, painted } = panel({ panel: 'supportPowers' });
  try {
    const stats = statsOf([[0, 0, 'germany']]);
    const prod = {
      powers: [
        {
          key: 'GpsPower',
          icon: 'gps',
          name: 'GPS',
          description: '',
          progress: 1,
          ready: true,
          charging: true,
          remainingTicks: 0,
          totalTicks: 500,
        },
      ],
    };
    p.update(stats, 10, () => ({ production: prod }));
    const icon = p.table.querySelector('.observer-icon');
    assert.equal(icon.querySelector('.observer-icon-text').textContent, 'Ready');
    assert.deepEqual(painted.at(-1), ['power', 'gps']);
    p.showPanel('army');
    assert.equal(p.needs(), 'army');
    p.update(stats, 20, () => ({ army: [0, 5, 2, 1] }));
    const army = [...p.table.querySelectorAll('.observer-icons-army .observer-icon')];
    assert.deepEqual(
      army.map((i) => i.querySelector('.observer-icon-count').textContent),
      ['5', '1'],
    );
    assert.equal(army[0].querySelector('.observer-icon-text'), null, 'no clock text on army icons');
  } finally {
    p.remove();
    uninstallDom();
  }
});

test('IconStrip removes icons that went away and detaches their tooltips', () => {
  installDom();
  try {
    const strip = new IconStrip({ kind: 'army', paint() {}, tip: armyIconTip });
    strip.update(armyIcons([0, 1, 2, 2], ACTORS));
    assert.equal(strip.root.childNodes.length, 2);
    strip.update(armyIcons([2, 3], ACTORS));
    assert.equal(strip.root.childNodes.length, 1);
    assert.equal(strip.icons.size, 1);
    assert.equal(strip.root.childNodes[0].querySelector('.observer-icon-count').textContent, '3');
  } finally {
    uninstallDom();
  }
});

test('every support power icon of the rules has WebRA art and an original sequence', () => {
  const rules = JSON.parse(readFileSync(new URL('../../../engine/rules.json', import.meta.url), 'utf8'));
  const icons = new Set();
  for (const a of rules.actors) for (const pw of a.abilities?.support_powers ?? []) icons.add(pw.icon);
  assert.ok(icons.size >= 8, [...icons].join());
  for (const icon of icons) {
    assert.ok(hasPowerEmblem(icon), `WebRA emblem for ${icon}`);
    assert.ok(SEQUENCES.icon?.[icon]?.file, `original sequence for ${icon}`);
  }
});

test('power icon art draws on a 2D context; without content files there is no original picture', () => {
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return (...args) => {
          calls.push(prop);
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return { addColorStop() {} };
          return undefined;
        };
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
  for (const icon of ['abomb', 'invuln', 'chrono', 'spyplane', 'paratroopers', 'parabombs', 'gps', 'sonar', 'unknown']) drawPowerIcon(ctx, icon, 40, 30);
  assert.ok(calls.includes('fill') && calls.includes('fillRect'));
  assert.equal(
    originalPowerIconPixels('abomb', () => null),
    null,
  );
  assert.equal(
    originalCameoPixels('icon:abomb', () => null),
    null,
  );
});
