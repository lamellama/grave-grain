declare const process: any;
/**
 * test/herd.test.ts - Herd dynamics (GDD 7.1, Beyond item 3 of the
 * user-prioritized order): "a zombie near others biases its drift toward the
 * herd -> natural clumping and follow-the-crowd".
 *
 * New behaviour under test:
 *  - herdPullX(z, herd): pure helper - the horizontal bias a new idle goal
 *    receives from OTHER alive zombies within ZOMBIE_HERD_RADIUS (2D anchor
 *    distance): centroid offset, capped at ZOMBIE_HERD_PULL_MAX, scaled by
 *    ZOMBIE_HERD_BIAS. Zero when alone / all allies out of range / dead.
 *  - driveIdle mixes the pull into each retarget goal; updateZombie takes the
 *    zombie list as an optional third arg (default [] = exact old behaviour).
 *  - Herding NEVER touches the attack state, the grid, or the RNG stream
 *    (herdPullX draws no randomness), so pursuit and chunk/replay determinism
 *    are untouched by construction.
 *
 * Done-when:
 *   1. PURE PULL - lone zombie pulls 0; an in-range clump pulls toward its
 *      centroid by bias*min(|centroid-x|, PULL_MAX); out-of-range allies and
 *      dead allies pull 0; self is excluded; the cap engages.
 *   2. GOAL BIAS - with an identical seeded RNG stream, the FIRST idle goal
 *      with a clump behind the zombie is exactly round(pull) cells behind the
 *      lone-zombie goal (the pull is additive, consuming no RNG).
 *   3. CLUMPING E2E - four spread idle zombies on a flat floor, same seed,
 *      run 6000 ticks with and without the herd arg: the herded pack's final
 *      spread is well below both its starting spread and the herd-less
 *      control's final spread; everyone stays idle; no tunnelling.
 *   4. ATTACK UNTOUCHED - a survivor inside SENSE_RADIUS flips the zombie to
 *      attack and it closes the gap even with a herd pulling the other way.
 *
 * Headless Node test over the REAL zombie/locomotion/grid modules. Math.random
 * is stubbed with a seeded LCG for determinism (body/AI-layer RNG only - the
 * chunked CA is never stepped here). tsc -> node.
 */

import { createZombie, updateZombie, herdPullX } from '../src/characters/zombie';
import type { Zombie } from '../src/characters/zombie';
import { createSurvivor } from '../src/characters/survivor';
import { material, set } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { STONE } from '../src/engine/materials';
import {
  WORLD_W,
  SENSE_RADIUS,
  ZOMBIE_HERD_RADIUS,
  ZOMBIE_HERD_BIAS,
  ZOMBIE_HERD_PULL_MAX,
} from '../src/config';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

/** Seeded LCG stub for Math.random - identical streams across paired runs. */
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

function spread(zs: Zombie[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const z of zs) {
    lo = Math.min(lo, z.body.x);
    hi = Math.max(hi, z.body.x);
  }
  return hi - lo;
}

// ===========================================================================
// 1. PURE PULL - herdPullX arithmetic, exclusions, cap.
// ===========================================================================
flatWorld();
{
  const z = createZombie(300, FLOOR - 1);

  // Lone -> 0.
  check(herdPullX(z, [z]) === 0, 'pure: lone zombie (self-only herd) pulls 0');

  // One ally 20 cells left, in range -> pull = -20 * BIAS.
  const a = createZombie(280, FLOOR - 1);
  check(
    herdPullX(z, [z, a]) === -20 * ZOMBIE_HERD_BIAS,
    'pure: single in-range ally at -20 pulls -20*bias',
  );

  // Clump centroid: allies at 280 and 320 -> centroid 300 -> pull 0.
  const b = createZombie(320, FLOOR - 1);
  check(
    herdPullX(z, [z, a, b]) === 0,
    'pure: symmetric clump (centroid on the zombie) pulls 0',
  );

  // Out of 2D range: same column but far vertically -> 0.
  const farUp = createZombie(300, FLOOR - 1 - (ZOMBIE_HERD_RADIUS + 30));
  check(
    herdPullX(z, [z, farUp]) === 0,
    'pure: ally beyond ZOMBIE_HERD_RADIUS (vertical) pulls 0',
  );

  // Beyond horizontal range -> 0.
  const farOff = createZombie(300 + ZOMBIE_HERD_RADIUS + 10, FLOOR - 1);
  check(
    herdPullX(z, [z, farOff]) === 0,
    'pure: ally beyond ZOMBIE_HERD_RADIUS (horizontal) pulls 0',
  );

  // Dead ally ignored.
  const dead = createZombie(280, FLOOR - 1);
  dead.body.alive = false;
  check(herdPullX(z, [z, dead]) === 0, 'pure: dead ally pulls 0');

  // Cap engages: ally at the radius edge, centroid offset > PULL_MAX.
  const edge = createZombie(300 - (ZOMBIE_HERD_RADIUS - 2), FLOOR - 1);
  check(
    ZOMBIE_HERD_RADIUS - 2 > ZOMBIE_HERD_PULL_MAX &&
      herdPullX(z, [z, edge]) === -ZOMBIE_HERD_PULL_MAX * ZOMBIE_HERD_BIAS,
    'pure: far in-range ally is capped at -PULL_MAX*bias',
  );
}

// ===========================================================================
// 2. GOAL BIAS - first retarget goal shifts by exactly round(pull) under an
//    identical RNG stream (the pull consumes no randomness).
// ===========================================================================
{
  // Lone run.
  flatWorld();
  seedRandom(0xc0ffee);
  const lone = createZombie(300, FLOOR - 1);
  updateZombie(lone, []); // first tick picks the first idle goal
  const loneGoal = lone.idleGoalX;

  // Herded run, same seed: stationary clump 40 cells behind (in range 48).
  flatWorld();
  seedRandom(0xc0ffee);
  const z = createZombie(300, FLOOR - 1);
  const clump = [
    z,
    createZombie(260, FLOOR - 1),
    createZombie(260, FLOOR - 1),
    createZombie(260, FLOOR - 1),
  ];
  const expectedPull = Math.round(
    Math.max(-ZOMBIE_HERD_PULL_MAX, Math.min(ZOMBIE_HERD_PULL_MAX, 260 - 300)) *
      ZOMBIE_HERD_BIAS,
  );
  updateZombie(z, [], clump);
  const herdGoal = z.idleGoalX;

  console.log('  goal lone=', loneGoal, 'herded=', herdGoal, 'expected pull=', expectedPull);
  check(
    loneGoal !== null && herdGoal !== null && herdGoal - loneGoal === expectedPull,
    'goal bias: first idle goal shifts by exactly round(pull) toward the clump',
  );
}

// ===========================================================================
// 3. CLUMPING E2E - herded pack congeals vs the herd-less control.
// ===========================================================================
{
  const START_XS = [200, 230, 260, 290]; // gaps 30 <= herd radius 48
  // Short enough that the colony-ward drift (~0.2 cells/tick) can NOT reach
  // the far world edge (290 + ~300 << WORLD_W) - at the edge the goal clamp
  // piles ANY pack up and would fake a clumping pass.
  const TICKS = 1500;

  // Control: same seed, NO herd arg (old behaviour).
  flatWorld();
  seedRandom(1234);
  const control = START_XS.map((x) => createZombie(x, FLOOR - 1));
  for (let t = 0; t < TICKS; t++) {
    for (const z of control) updateZombie(z, []);
  }
  const controlSpread = spread(control);

  // Herded: identical seed, zombie list passed through.
  flatWorld();
  seedRandom(1234);
  const pack = START_XS.map((x) => createZombie(x, FLOOR - 1));
  let tunnel = false;
  let everAttacked = false;
  for (let t = 0; t < TICKS; t++) {
    for (const z of pack) {
      updateZombie(z, [], pack);
      if (z.state === 'attack') everAttacked = true;
    }
  }
  for (const z of pack) if (bodyInStone(z.body)) tunnel = true;
  const startSpread = spread(
    START_XS.map((x) => createZombie(x, FLOOR - 1)),
  );
  const packSpread = spread(pack);

  console.log(
    '  spread: start=', startSpread, 'control(final)=', Math.round(controlSpread),
    'herded(final)=', Math.round(packSpread),
  );
  check(
    packSpread < startSpread * 0.5,
    'clumping: herded pack final spread < half its starting spread',
  );
  check(
    packSpread < controlSpread,
    'clumping: herded pack ends tighter than the herd-less control (same seed)',
  );
  check(!everAttacked, 'clumping: no survivors -> pack stayed idle throughout');
  check(!tunnel, 'clumping: no zombie tunnelled into the floor');
}

// ===========================================================================
// 4. ATTACK UNTOUCHED - detection + pursuit win over the herd pull.
// ===========================================================================
{
  flatWorld();
  seedRandom(42);
  const z = createZombie(300, FLOOR - 1);
  // Herd behind (would pull -x) + survivor ahead inside SENSE_RADIUS (60).
  const herd = [z, createZombie(270, FLOOR - 1), createZombie(270, FLOOR - 1)];
  const prey = createSurvivor(300 + SENSE_RADIUS - 20, FLOOR - 1);
  const gap0 = Math.abs(z.body.x - prey.body.x);
  let flipped = false;
  let minGap = gap0;
  for (let t = 0; t < 400; t++) {
    updateZombie(z, [prey], herd);
    if (z.state === 'attack') flipped = true;
    minGap = Math.min(minGap, Math.abs(z.body.x - prey.body.x));
  }
  // The zombie should close in and BITE (after which the infected prey is no
  // longer a valid target and the zombie legitimately drifts back to the herd
  // - so judge the approach by the closest pass + the landed bite, not the
  // end-of-run gap).
  console.log('  pursuit gap:', gap0, '-> min', Math.round(minGap), 'bitten:', prey.body.infected);
  check(flipped, 'attack: survivor in range flips the zombie to attack despite the herd');
  check(
    minGap < gap0 / 2 && prey.body.infected === true,
    'attack: zombie closed on the survivor and landed the bite, not distracted by the herd',
  );
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
