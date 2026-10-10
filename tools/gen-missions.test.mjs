// tools/gen_missions.py --lint: the co-op lint refuses game changes that only
// one client makes (code under IsLocalPlayer), and passes OpenRA's co-op missions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lint = (...files) => spawnSync('python3', [join(root, 'tools/gen_missions.py'), '--lint', ...files], { encoding: 'utf8' });

test('the co-op lint passes presentation and refuses game changes under IsLocalPlayer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webra-lint-'));
  const good = join(dir, 'good.lua');
  writeFileSync(
    good,
    `WorldLoaded = function()
  if Allies1.IsLocalPlayer then
    Media.DisplayMessage(UserInterface.GetFluentMessage("hi"), "Tanya") -- a comment with Actor.Create("x")
    local t = Utils.FormatTime(DateTime.Seconds(5))
    Trigger.AfterDelay(25, function() Media.PlaySpeechNotification(Allies1, "MissionAccomplished") end)
    TextColor = Allies1.Color
  else
    Camera.Position = Entry.CenterPosition
  end
  Actor.Create("e1", true, { Owner = Allies1 })
end
`,
  );
  const ok = lint(good);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = join(dir, 'bad.lua');
  writeFileSync(
    bad,
    `Tick = function()
  if not Allies2 or Allies2.IsLocalPlayer then
    Reinforcements.Reinforce(Allies2, { "e1" }, { Entry.Location })
    Trigger.AfterDelay(25, function() Allies1.Cash = 5 end)
  else
    Score = 3
  end
end
`,
  );
  const r = lint(bad);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /bad\.lua:3: Reinforcements\.Reinforce\(\.\.\.\) runs only where IsLocalPlayer is true/);
  assert.match(r.stdout, /bad\.lua:4: Allies1\.Cash is set only where IsLocalPlayer is true/);
  assert.match(r.stdout, /bad\.lua:6: Score is set only where IsLocalPlayer is true/);
});

test("OpenRA's co-op missions pass the lint", () => {
  const maps = join(root, 'data/source/missions/maps');
  const r = lint(...['evacuation/evacuation.lua', 'exodus/exodus.lua', 'infiltration/infiltration.lua'].map((f) => join(maps, f)), join(root, 'data/source/missions/scripts/campaign.lua'));
  assert.equal(r.status, 0, r.stdout);
});
