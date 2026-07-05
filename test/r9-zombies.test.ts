declare const process: any;
/**
 * test/r9-zombies.test.ts - Playtest R9 zombie rework:
 *
 *  1. SIGHT MEANDER - sightPullX(z, survivors): pure pull toward the nearest
 *     VISIBLE survivor within ZOMBIE_SIGHT_RADIUS (capped/scaled, skips the
 *     infected/prone/turned, 0 when nothing is in sight). driveIdle no longer
 *     carries the fixed colony-ward ADVANCE_DIR march: a lone idle zombie with
 *     nothing to see just meanders locally, while one that can see a distant
 *     figure drifts toward it and eventually locks + attacks.
 *  2. INTERMITTENT SPAWNS - a wave's roster drips with RANDOMISED gaps
 *     (0.5x..1.5x spawnGapBase, spreading over ~ZOMBIE_SPAWN_SPREAD_FRAC of
 *     the interval), not the old fixed 30-tick stagger block.
 *  3. BURROW EMERGENCE - with a burrowCenterX passed, spawns can surface from
 *     the ground near the colony: created buried (clipBelowY set, feet a body
 *     height below the surface), rising over ZOMBIE_EMERGE_TICKS to stand ON
 *     the surface with the clip dropped, doing nothing else while emerging.
 *
 * Headless Node test over the REAL zombie/waves/locomotion/grid modules.
 * Math.random is stubbed with a seeded LCG (body/AI-layer RNG only). tsc -> node.
 */

import {
  createZombie,
  createBurrowedZombie,
  updateZombie,
  sightPullX,
} from '../src/characters/zombie';
import type { Zombie } from '../src/characters/zombie';
import { createWaveState, updateWaves } from '../src/game/waves';
import { createSurvivor } from '../src/characters/survivor';
import { material, set } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { STONE } from '../src/engine/materials';
import {
  WORLD_W,
  BODY_H,
  SENSE_RADIUS,
  ZOMBIE_SIGHT_RADIUS,
  ZOMBIE_SIGHT_BIAS,
  ZOMBIE_SIGHT_PULL_MAX,
  ZOMBIE_EMERGE_TICKS,
  ZOMBIE_BURROW_MIN_DIST,
  ZOMBIE_BURROW_SPREAD,
  ZOMBIE_SPAWN_GAP_MIN,
  WAVE_INTERVAL,
} from '../src/config';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

/** Seeded LCG stub for Math.random - deterministic runs. */
function seedRandom(seed: number): void {
  let s = seed >>> 0;
  Math.random = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const FLOOR = 150;
function flatWorld(): void {
  material.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  rebuildNavgrid();
}

function bodyInStone(b: any): boolean {
  for (const bone of b.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const wx = Math.round(b.x) + bone.offset.dx + p.dx;
      const wy = Math.round(b.y) + bone.offset.dy + p.dy;
      if (material[wy * WORLD_W + wx] === STONE) return true;
    }
  }
  return false;
}

// ===========================================================================
// 1a. SIGHT PULL - pure arithmetic, range, exclusions.
// ===========================================================================
flatWorld();
{
  const z = createZombie(400, FLOOR - 1);

  check(sightPullX(z, []) === 0, 'sight: nothing to see pulls 0');

  // Survivor 100 cells right, inside sight (140) but outside sense (60):
  // pull = min(100, PULL_MAX) * BIAS.
  const far = createSurvivor(500, FLOOR - 1);
  check(
    sightPullX(z, [far]) === Math.min(100, ZOMBIE_SIGHT_PULL_MAX) * ZOMBIE_SIGHT_BIAS,
    'sight: visible survivor at +100 pulls +min(100,cap)*bias',
  );

  // Beyond sight radius -> 0.
  const beyond = createSurvivor(400 + ZOMBIE_SIGHT_RADIUS + 20, FLOOR - 1);
  check(sightPullX(z, [beyond]) === 0, 'sight: survivor beyond ZOMBIE_SIGHT_RADIUS pulls 0');

  // Infected (doomed) survivor is skipped.
  const doomed = createSurvivor(480, FLOOR - 1);
  doomed.body.infected = true;
  check(sightPullX(z, [doomed]) === 0, 'sight: infected survivor pulls 0');

  // Nearest of two wins (and the cap engages: |-40| > PULL_MAX 30).
  const near = createSurvivor(360, FLOOR - 1); // 40 left
  check(
    sightPullX(z, [far, near]) ===
      Math.max(-ZOMBIE_SIGHT_PULL_MAX, -40) * ZOMBIE_SIGHT_BIAS,
    'sight: nearest visible survivor wins (capped pull toward -40)',
  );
}

// ===========================================================================
// 1b. NO FIXED MARCH - a lone zombie with nothing to see stays local; one
//     that can SEE a figure drifts to it and ends up locking + biting.
// ===========================================================================
{
  flatWorld();
  seedRandom(777);
  const drifter = createZombie(600, FLOOR - 1);
  for (let t = 0; t < 3000; t++) updateZombie(drifter, []);
  const drift = Math.abs(drifter.body.x - 600);
  console.log('  lone idle drift over 3000t:', Math.round(drift), 'cells');
  check(
    drift < 100,
    'meander: lone zombie stays local (old ADVANCE_DIR march would travel far one-way)',
  );

  flatWorld();
  seedRandom(777);
  const stalker = createZombie(600, FLOOR - 1);
  // Inside sight (140), outside sense (60): only the sight pull can start this.
  const prey = createSurvivor(600 + ZOMBIE_SIGHT_RADIUS - 20, FLOOR - 1);
  let everAttacked = false;
  for (let t = 0; t < 4000 && !everAttacked; t++) {
    updateZombie(stalker, [prey]);
    if (stalker.state === 'attack') everAttacked = true;
  }
  check(
    everAttacked,
    'meander: a SEEN survivor outside sense range draws the zombie in until pursuit locks',
  );
}

// ===========================================================================
// 2. INTERMITTENT SPAWNS - randomised, spread-out gaps (edge path only).
// ===========================================================================
{
  flatWorld();
  seedRandom(0xbeef);
  const state = createWaveState();
  const spawnTicks: number[] = [];
  let collected = 0;
  for (let t = 0; t < WAVE_INTERVAL * 3 && collected < 3; t++) {
    const batch = updateWaves(state, collected); // no burrowCenterX -> edge spawns
    for (const _z of batch) {
      spawnTicks.push(t);
      collected++;
    }
  }
  check(collected === 3, `drip: wave 1 fully spawned (${collected}/3)`);
  const gaps: number[] = [];
  for (let i = 1; i < spawnTicks.length; i++) gaps.push(spawnTicks[i] - spawnTicks[i - 1]);
  console.log('  spawn ticks:', spawnTicks, 'gaps:', gaps, 'gapBase:', state.spawnGapBase);
  check(
    gaps.every((g) => g >= Math.floor(0.5 * state.spawnGapBase)),
    'drip: every gap >= 0.5x the per-wave base gap',
  );
  check(
    gaps.every((g) => g <= Math.ceil(1.5 * state.spawnGapBase) + 1),
    'drip: every gap <= 1.5x the per-wave base gap',
  );
  check(
    state.spawnGapBase >= ZOMBIE_SPAWN_GAP_MIN,
    'drip: base gap floored at ZOMBIE_SPAWN_GAP_MIN',
  );
  check(new Set(gaps).size > 1 || gaps.length < 2, 'drip: gaps are randomised, not metronomic');
}

// ===========================================================================
// 3a. BURROW SPAWN - forced roll surfaces a buried zombie near the centre.
// ===========================================================================
{
  flatWorld();
  const state = createWaveState();
  // Fast-forward to the wave launch with no RNG involvement (between waves).
  seedRandom(1);
  for (let t = 0; t < WAVE_INTERVAL; t++) updateWaves(state, 0, 640);
  // Force the burrow roll: first random() = 0 (< chance), then side/dist/gap draws.
  const rolls = [0.0, 0.9, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  let ri = 0;
  Math.random = () => rolls[Math.min(ri++, rolls.length - 1)];
  let burrowed: Zombie | null = null;
  for (let t = 0; t < 10 && !burrowed; t++) {
    const batch = updateWaves(state, 0, 640);
    if (batch.length > 0) burrowed = batch[0];
  }
  check(burrowed !== null, 'burrow: forced roll produced a spawn');
  if (burrowed) {
    const dist = Math.abs(burrowed.body.x - 640);
    check(
      dist >= ZOMBIE_BURROW_MIN_DIST && dist <= ZOMBIE_BURROW_SPREAD,
      `burrow: surfaced ${Math.round(dist)} cells from centre (in [${ZOMBIE_BURROW_MIN_DIST}, ${ZOMBIE_BURROW_SPREAD}])`,
    );
    check(burrowed.emergeTicks === ZOMBIE_EMERGE_TICKS, 'burrow: emergence clock armed');
    check(burrowed.body.clipBelowY === FLOOR, 'burrow: render clip set at the surface row');
    check(
      burrowed.body.y === FLOOR - 1 + BODY_H,
      'burrow: body starts a full body-height below its standing row',
    );
  }
}

// ===========================================================================
// 3b. EMERGENCE E2E - rises over ZOMBIE_EMERGE_TICKS, then stands clean.
// ===========================================================================
{
  flatWorld();
  seedRandom(99);
  const z = createBurrowedZombie(700, FLOOR);
  check(bodyInStone(z.body), 'emerge: starts overlapping the soil (hidden by the clip)');
  const yStart = z.body.y;
  // Half-way: partially risen, still clipped, still emerging.
  for (let t = 0; t < ZOMBIE_EMERGE_TICKS / 2; t++) updateZombie(z, []);
  check(z.body.y < yStart && z.body.y > FLOOR - 1, 'emerge: half-way up at half time');
  check(z.body.clipBelowY === FLOOR, 'emerge: clip still active while rising');
  // Finish.
  for (let t = 0; t < ZOMBIE_EMERGE_TICKS; t++) updateZombie(z, []);
  check(z.emergeTicks === 0, 'emerge: emergence complete');
  check(z.body.y === FLOOR - 1, 'emerge: feet stand on the surface row');
  check(z.body.clipBelowY === undefined, 'emerge: render clip dropped');
  check(!bodyInStone(z.body), 'emerge: fully-emerged body overlaps no terrain (no tunnel)');
  // And it behaves like a normal zombie afterwards (locks a nearby survivor).
  const prey = createSurvivor(700 + SENSE_RADIUS - 10, FLOOR - 1);
  let locked = false;
  for (let t = 0; t < 200 && !locked; t++) {
    updateZombie(z, [prey]);
    if (z.state === 'attack') locked = true;
  }
  check(locked, 'emerge: post-emergence zombie detects and pursues normally');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
