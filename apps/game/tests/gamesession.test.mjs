// js/gamesession.js: Restart and the next mission replace the game in the
// page. The loading screen shows first, the left game's replay goes to the
// account as "left", the game comes down, then the same game starts; a
// failed teardown falls back to the reload with the restart record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSession } from '../js/gamesession.js';
import { GameReplay, replayResult } from '../js/account/replays.js';
import { EndGameFlow } from '../js/endgame.js';
import { restartRecord } from '../js/restart.js';

const skirmishRecord = restartRecord({ seed: 7, players: [{ type: 'human', faction: 'england' }] });

function setup({ saved = true } = {}) {
  const log = [];
  const loading = {
    begin: (plan) => log.push(['begin', plan.title]),
    fail: (message, o = {}) => {
      log.push(['fail', message, o.label ?? null]);
      loading.run = o.run;
    },
  };
  const session = new GameSession({
    loading,
    reload: () => log.push(['reload']),
    saveRecord: (record) => {
      log.push(['save', record.kind]);
      return saved;
    },
  });
  return { log, loading, session };
}

/** A running single player game whose replay goes to the signed-in account (js/account/replays.js GameReplay). */
function runningGame(log, { flow = new EndGameFlow(), teardown = () => log.push(['teardown']) } = {}) {
  const queued = [];
  const recorder = { start: { createdAt: 1700000000000, title: 'England vs 1 opponent' }, encode: async () => ({ text: '{"replay":1}' }) };
  const uploads = { add: async (item) => queued.push(item) };
  const accountReplay = new GameReplay({
    recorder,
    uploads,
    account: () => ({ user: { id: 'u1', status: 'active' }, site: { services: { replays: true } } }),
    enabled: () => true,
  });
  const game = {
    leaving: async () => {
      log.push(['leaving']);
      await accountReplay.leaving(replayResult(flow));
    },
    teardown,
  };
  return { game, queued, accountReplay };
}

test('restart: the loading screen, the left game\'s replay, the teardown, then the same game again, in that order', async () => {
  const { log, session } = setup();
  const { game, queued } = runningGame(log);
  session.attach(game);
  const replaced = await session.replace({
    plan: { title: 'Restarting: Skirmish', steps: [] },
    relaunch: async () => log.push(['relaunch']),
    record: skirmishRecord,
  });
  assert.equal(replaced, true);
  assert.deepEqual(log, [['begin', 'Restarting: Skirmish'], ['leaving'], ['teardown'], ['relaunch']]);
  // The replays-in-account feature: a game left by a restart is kept as "left".
  assert.equal(queued.length, 1);
  assert.equal(queued[0].result, 'left');
  assert.equal(queued[0].userId, 'u1');
  assert.equal(session.current, null, 'the new game attaches itself when it starts');
  assert.equal(session.busy, false);
});

test('a game that was already won keeps its "won" replay: leaving queues nothing twice', async () => {
  const { log, session } = setup();
  const flow = new EndGameFlow();
  flow.phase = 'won';
  const { game, queued, accountReplay } = runningGame(log, { flow });
  await accountReplay.ended(replayResult(flow));
  session.attach(game);
  await session.replace({ plan: { title: 'x', steps: [] }, relaunch: async () => {} });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].result, 'won');
});

test('a second Restart while one runs is ignored, and nothing happens without a game', async () => {
  const { log, session } = setup();
  assert.equal(await session.replace({ plan: { title: 'x', steps: [] }, relaunch: async () => log.push(['relaunch']) }), false);
  assert.deepEqual(log, []);
  let release;
  const slow = { leaving: () => new Promise((r) => (release = r)), teardown: () => log.push(['teardown']) };
  session.attach(slow);
  const first = session.replace({ plan: { title: 'one', steps: [] }, relaunch: async () => log.push(['relaunch']) });
  assert.equal(session.busy, true);
  assert.equal(await session.replace({ plan: { title: 'two', steps: [] }, relaunch: async () => log.push(['relaunch twice']) }), false);
  release();
  await first;
  assert.deepEqual(log, [['begin', 'one'], ['teardown'], ['relaunch']]);
});

test('a teardown that fails part way reloads into the restart record (the old way); without storage it says so', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { log, session } = setup();
    const { game } = runningGame(log, {
      teardown: () => {
        throw new AggregateError([new Error('renderer')], '1 part(s) of the game could not be taken down');
      },
    });
    session.attach(game);
    const replaced = await session.replace({ plan: { title: 'x', steps: [] }, relaunch: async () => log.push(['relaunch']), record: skirmishRecord });
    assert.equal(replaced, false);
    assert.deepEqual(log.slice(-2), [['save', 'skirmish'], ['reload']]);
    assert.ok(!log.some((e) => e[0] === 'relaunch'), 'no second game on top of a half taken down one');

    const blocked = setup({ saved: false });
    const other = runningGame(blocked.log, {
      teardown: () => {
        throw new Error('broken');
      },
    });
    blocked.session.attach(other.game);
    await blocked.session.replace({ plan: { title: 'x', steps: [] }, relaunch: async () => {}, record: skirmishRecord });
    const fail = blocked.log.find((e) => e[0] === 'fail');
    assert.deepEqual(fail, ['fail', 'Could not restart the game here. Start it again from the menu.', 'Back to the menu']);
    blocked.loading.run();
    assert.deepEqual(blocked.log.at(-1), ['reload']);
  } finally {
    console.warn = warn;
  }
});

test('leaving that fails still restarts; a relaunch that throws shows the error with the way back to the menu', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { log, loading, session } = setup();
    session.attach({
      leaving: async () => {
        throw new Error('upload queue broken');
      },
      teardown: () => log.push(['teardown']),
    });
    await session.replace({
      plan: { title: 'x', steps: [] },
      relaunch: async () => {
        throw new Error('worker did not start');
      },
    });
    assert.deepEqual(log.slice(1), [['teardown'], ['fail', 'Could not start the game: worker did not start', 'Back to the menu']]);
    loading.run();
    assert.deepEqual(log.at(-1), ['reload']);
    assert.equal(session.busy, false);
  } finally {
    console.warn = warn;
  }
});

test('detach: a game that goes for good is no longer the one a restart replaces', () => {
  const { session } = setup();
  const a = { leaving: async () => {}, teardown() {} };
  const b = { leaving: async () => {}, teardown() {} };
  session.attach(a);
  session.detach(b);
  assert.equal(session.current, a);
  session.detach(a);
  assert.equal(session.current, null);
});
