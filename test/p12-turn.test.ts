/**
 * p12-turn — Revised death model Task 4: infection → prone → TURN, counterplay,
 * counts/lose, THE GATE on a reanimated zombie, prone no-op (GDD §5.1 / §7.2 /
 * §11). Real modules, no mocks.
 *
 * 1. Turn      : bite → updateInfection over ticks: prone at INFECTION_ACTING_TICKS,
 *                turn at TURN_DELAY_TICKS — a NEW zombie wraps the SAME Body
 *                (identity), body stays alive.
 * 2. Counts/lose: survivorsAlive drops by 1 on turn; all turned/dead → 'lost'.
 * 3. Counterplay: an extreme hit (head→dissolve) before the timer → no reanimate.
 * 4. GATE      : a headshot on the reanimated zombie releases real cells.
 * 5. Prone     : a downed (pre-turn) survivor's updateSurvivor no-ops its drive.
 */
import { createSurvivor, updateSurvivor } from '../src/characters/survivor';
import { createZombie, updateZombie, reanimateAsZombie } from '../src/characters/zombie';
import { updateInfection } from '../src/characters/infection';
import { biteAttack } from '../src/game/combat';
import { applyDamage } from '../src/characters/damage';
import { createGameState, updateGameState } from '../src/game/state';
import type { WaveState } from '../src/game/waves';
import { material, set } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { STONE, FLESH, BONE } from '../src/engine/materials';
import { WORLD_W, INFECTION_ACTING_TICKS, TURN_DELAY_TICKS, WIN_WAVES } from '../src/config';

declare const process: any;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log('  PASS:', msg);
  else { console.error('  FAIL:', msg); failed++; }
}
function clearGrid() { material.fill(0); }
function floor(row: number) { for (let x = 0; x < WORLD_W; x++) set(x, row, STONE); }
function goreCells(): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === FLESH || material[i] === BONE) n++;
  return n;
}
function playingWaveState(): WaveState {
  return { waveNumber: 1, ticksToNextWave: 999, pendingThisWave: 0, ticksToNextSpawn: 0, spawnGapBase: 0 };
}
function clearedWaveState(): WaveState {
  return { waveNumber: WIN_WAVES, ticksToNextWave: 0, pendingThisWave: 0, ticksToNextSpawn: 0, spawnGapBase: 0 };
}

const FLOOR = 150;

// =====================================================================
// [1] Turn progression + identity
// =====================================================================
console.log('\n[1] Turn: act → prone → reanimate');
clearGrid(); floor(FLOOR); rebuildNavgrid();
const surv = createSurvivor(300, FLOOR - 1);
const zombies: any[] = [];
biteAttack(surv.body); // infect directly
assert(surv.body.infected === true && surv.body.infectionTicks === 0, 'bite infected, clock 0');

// Tick up to (but not at) the prone threshold.
for (let t = 1; t < INFECTION_ACTING_TICKS; t++) updateInfection([surv], zombies, t);
assert(surv.body.prone === false, `not prone before INFECTION_ACTING_TICKS (ticks=${surv.body.infectionTicks})`);
updateInfection([surv], zombies, INFECTION_ACTING_TICKS); // the prone tick
assert(surv.body.prone === true, `prone at INFECTION_ACTING_TICKS (ticks=${surv.body.infectionTicks})`);
assert(surv.turned === false && zombies.length === 0, 'not yet turned at prone');

// Tick on to the turn threshold.
for (let t = INFECTION_ACTING_TICKS + 1; t < TURN_DELAY_TICKS; t++) updateInfection([surv], zombies, t);
assert(surv.turned === false && zombies.length === 0, `not turned before TURN_DELAY_TICKS (ticks=${surv.body.infectionTicks})`);
updateInfection([surv], zombies, TURN_DELAY_TICKS); // the turn tick
assert(surv.turned === true, 'survivor.turned === true at TURN_DELAY_TICKS');
assert(zombies.length === 1, 'one new zombie pushed onto the horde');
assert(zombies[zombies.length - 1].body === surv.body, 'reanimated zombie wraps the SAME Body (identity)');
assert(surv.body.alive === true, 'body stays alive (zombie controller now drives it)');
assert(surv.body.infected === false && surv.body.prone === false, 'infection consumed, prone cleared');

// =====================================================================
// [2] Counts + lose
// =====================================================================
console.log('\n[2] Counts + lose');
{
  const gs = createGameState();
  const ws = playingWaveState();
  // s0 turned (from [1] above we reuse a fresh pair), plus an alive ally.
  const turnedS = createSurvivor(300, FLOOR - 1);
  const ally = createSurvivor(320, FLOOR - 1);
  const horde: any[] = [];
  // Register both alive (tick 0).
  updateGameState(gs, { survivors: [turnedS, ally], waveState: ws, aliveZombieCount: 1, tick: 0 });
  assert(gs.survivorsAlive === 2, 'two alive before any turn');
  // Turn turnedS.
  biteAttack(turnedS.body);
  for (let t = 1; t <= TURN_DELAY_TICKS; t++) updateInfection([turnedS, ally], horde, t);
  assert(turnedS.turned === true, 'first survivor turned');
  updateGameState(gs, { survivors: [turnedS, ally], waveState: ws, aliveZombieCount: 1, tick: 1 });
  assert(gs.survivorsAlive === 1, `survivorsAlive dropped by 1 (got ${gs.survivorsAlive})`);
  assert(gs.status === 'playing', 'still playing (ally alive)');
  // Turn the ally too → all turned → lost.
  biteAttack(ally.body);
  for (let t = 1; t <= TURN_DELAY_TICKS; t++) updateInfection([turnedS, ally], horde, t);
  updateGameState(gs, { survivors: [turnedS, ally], waveState: ws, aliveZombieCount: 1, tick: 2 });
  assert(gs.survivorsAlive === 0, 'survivorsAlive === 0 when all turned');
  assert(gs.status === 'lost', `status 'lost' when all turned (got '${gs.status}')`);
}

// =====================================================================
// [3] Counterplay — extreme hit before the timer prevents reanimation
// =====================================================================
console.log('\n[3] Counterplay (extreme hit pre-turn)');
{
  clearGrid(); floor(FLOOR); rebuildNavgrid();
  const victim = createSurvivor(300, FLOOR - 1);
  const horde: any[] = [];
  biteAttack(victim.body);
  for (let t = 1; t < 50; t++) updateInfection([victim], horde, t); // partway in
  assert(victim.body.infected === true, 'infected mid-progression');
  applyDamage(victim.body, 'head'); // extreme → dissolveBody
  assert(victim.body.alive === false, 'head hit dissolved the body (alive=false)');
  assert(victim.body.infected === false, 'dissolve cleared infection');
  const hordeBefore = horde.length;
  for (let t = 50; t <= TURN_DELAY_TICKS + 10; t++) updateInfection([victim], horde, t);
  assert(horde.length === hordeBefore, 'no new zombie — dissolved body never reanimates');
  assert(victim.turned === false, 'survivor not marked turned (killed for good)');
}

// =====================================================================
// [4] THE GATE intact on a reanimated zombie
// =====================================================================
console.log('\n[4] GATE on reanimated zombie');
{
  clearGrid(); floor(FLOOR); rebuildNavgrid();
  const v = createSurvivor(300, FLOOR - 1);
  const horde: any[] = [];
  biteAttack(v.body);
  for (let t = 1; t <= TURN_DELAY_TICKS; t++) updateInfection([v], horde, t);
  assert(horde.length === 1, 'reanimated zombie exists');
  const z = horde[0];
  const before = goreCells();
  applyDamage(z.body, 'head'); // headshot → dissolveBody → releases cells
  const after = goreCells();
  assert(z.body.alive === false, 'reanimated zombie killed by headshot');
  assert(after > before, `headshot released real cells (${before} → ${after})`);
}

// =====================================================================
// [5] Prone downed survivor — updateSurvivor no-ops its drive
// =====================================================================
console.log('\n[5] Prone no-op');
{
  clearGrid(); floor(FLOOR); rebuildNavgrid();
  const p = createSurvivor(300, FLOOR - 1);
  const horde: any[] = [];
  biteAttack(p.body);
  for (let t = 1; t <= INFECTION_ACTING_TICKS; t++) updateInfection([p], horde, t);
  assert(p.body.prone === true && p.turned === false, 'downed (prone, not yet turned)');
  const xBefore = Math.round(p.body.x);
  p.body.moveDir = 1; // pretend something set a drive
  updateSurvivor(p, []);
  assert((p.body.moveDir as number) === 0, 'prone updateSurvivor forces moveDir 0 (no drive)');
  assert(Math.round(p.body.x) === xBefore, 'prone survivor did not move/seek');
}

// =====================================================================
// [6] nearestSurvivor skips infected/prone/turned; reanimateAsZombie reuse
// =====================================================================
console.log('\n[6] target skipping');
{
  clearGrid(); floor(FLOOR); rebuildNavgrid();
  const z = createZombie(306, FLOOR - 1);
  const inf = createSurvivor(300, FLOOR - 1);
  inf.body.infected = true; // infected → should be skipped as a target
  z.target = null; z.state = 'idle';
  updateZombie(z, [inf]);
  assert(z.target === null && z.state === 'idle', 'zombie ignores an infected survivor');

  const body = createSurvivor(10, 10).body;
  const zz = reanimateAsZombie(body);
  assert(zz.body === body && zz.state === 'idle' && zz.target === null, 'reanimateAsZombie reuses body, idle');
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
