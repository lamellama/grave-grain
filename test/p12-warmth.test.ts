/**
 * Headless verification for Task W1 — the WARMTH survival need (GDD §6.1, §10).
 * Imports the REAL modules (no mocks). Run via tsc (commonjs) -> node.
 *
 * Covers:
 *   1. FREEZE → corpse: a survivor in open cold (AMBIENT_COLD, no FIRE nearby)
 *      loses warmth over ticks → warmth 0 → deathCause 'frozen', alive=false,
 *      and the body is a CORPSE (corpse=true, rig INTACT, NOT dissolved).
 *   2. FIRE keeps warm: a FIRE cell within FIRE_WARMTH_RADIUS keeps a survivor's
 *      warmth at/near NEED_MAX over a long run; it never freezes.
 *   3. INVARIANT: FIRE_WARMTH_RADIUS >= FLEE_FIRE_RADIUS (the ring a survivor
 *      flees TO must still be warm — passive proximity warmth).
 */
import {
  WORLD_W,
  NEED_MAX,
  WARMTH_RATE,
  FIRE_WARMTH_RADIUS,
  FLEE_FIRE_RADIUS,
} from '../src/config';
import { FIRE, STONE, FLESH, BONE } from '../src/engine/materials';
import { material, set } from '../src/engine/grid';
import type { Body } from '../src/characters/body';
import {
  createSurvivor,
  updateSurvivor,
  type Survivor,
} from '../src/characters/survivor';
import { __setWeatherForTest } from '../src/engine/weather';

// T4 (GDD §10): warmth depletion is now gated on DYNAMIC weather
// (isAmbientColdNow). These scenarios model an "open cold" world, so pin the
// weather to SNOW (temp < COLD_THRESHOLD) to recreate the always-cold regime
// this suite was written for. Pin once at module scope; updateSurvivor never
// advances the weather state machine, so the forced cold holds for every run.
__setWeatherForTest('snow');

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}
function clearGrid(): void {
  material.fill(0);
}
function floor(row: number): void {
  for (let x = 0; x < WORLD_W; x++) set(x, row, STONE);
}
/** Vertical STONE wall in column x, rows [y0, y1] inclusive. */
function wall(x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) set(x, y, STONE);
}
function isBodyMat(m: number): boolean {
  return m === FLESH || m === BONE;
}
function countBodyCells(): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (isBodyMat(material[i])) n++;
  return n;
}
function anyDestroyed(body: Body): boolean {
  return body.rig.some((b) => b.destroyed);
}

// ============================================================================
// 3. INVARIANT first (cheap, gates the rest of the feature).
// ============================================================================
if (FIRE_WARMTH_RADIUS < FLEE_FIRE_RADIUS) {
  fail(
    `invariant: FIRE_WARMTH_RADIUS (${FIRE_WARMTH_RADIUS}) < FLEE_FIRE_RADIUS (${FLEE_FIRE_RADIUS})`,
  );
}
ok(
  `invariant: FIRE_WARMTH_RADIUS (${FIRE_WARMTH_RADIUS}) >= FLEE_FIRE_RADIUS (${FLEE_FIRE_RADIUS}) — the ring fled-to stays warm`,
);

// ============================================================================
// 1. FREEZE → corpse. Open cold, no FIRE. Keep hunger/thirst topped up each
//    tick so warmth is unambiguously the cause of death.
// ============================================================================
clearGrid();
floor(150);
{
  const s = createSurvivor(200, 149);
  const before = countBodyCells();
  const w0 = s.needs.warmth;
  let freezeTick = -1;
  for (let t = 0; t < 20000 && freezeTick < 0; t++) {
    // Only warmth should drive death here.
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    updateSurvivor(s, []);
    if (!s.body.alive) freezeTick = t;
  }
  const body = s.body;
  const after = countBodyCells();

  if (freezeTick < 0) fail('freeze: survivor never froze within 20000 ticks');
  if (s.deathCause !== 'frozen') fail(`freeze: deathCause = ${s.deathCause}`);
  if (body.alive !== false) fail('freeze: alive !== false');
  if (body.corpse !== true) fail('freeze: corpse !== true (must lie down, not dissolve)');
  if (anyDestroyed(body)) fail('freeze: a bone was destroyed (rig must stay intact)');
  if (after !== before)
    fail(`freeze: grid body-cell count changed ${before} -> ${after} (corpse must NOT spray cells)`);
  const expected = Math.ceil(w0 / WARMTH_RATE);
  console.log(
    `R1 ticks-to-freeze: ${freezeTick} (analytic ~${expected} from warmth ${w0} @ ${WARMTH_RATE}/tick)`,
  );
  ok(
    `freeze → corpse (deathCause=frozen, alive=false, corpse=true, 6 bones intact, grid cells ${before}=${after})`,
  );
}

// ============================================================================
// 2. FIRE keeps warm. Confine the survivor in a tight STONE pen so it cannot
//    flee out of FIRE_WARMTH_RADIUS, with a FIRE cell just outside within range
//    (not orthogonally adjacent to flesh → no ignition). Warmth must stay high
//    for far longer than the freeze time and the survivor must never die.
// ============================================================================
clearGrid();
floor(150);
{
  // Body feet at (200,149); footprint x in [197,202], y in [138,149].
  // Pen walls flank it so it is fully pinned (moveDir is a no-op).
  wall(196, 138, 149);
  wall(203, 138, 149);
  // FIRE outside the right wall: Chebyshev 6 from feet (<= FIRE_WARMTH_RADIUS),
  // 3 cells from the nearest flesh (cells 203/204/205 between) → no ignition.
  set(206, 149, FIRE);

  const s = createSurvivor(200, 149);
  // Start cold to prove fire RESTORES (out-paces depletion), not just holds.
  s.needs.warmth = 20;
  let minWarmth = Infinity;
  let frozeOrDied = false;
  // Run far longer than the freeze time (~8333 ticks) — fire must keep it alive.
  for (let t = 0; t < 30000; t++) {
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    updateSurvivor(s, []);
    if (!s.body.alive) {
      frozeOrDied = true;
      break;
    }
    // Sample warmth after it has had time to climb back up from the cold start.
    if (t > 200) minWarmth = Math.min(minWarmth, s.needs.warmth);
  }
  if (frozeOrDied)
    fail(`fire-keeps-warm: survivor died (cause=${s.deathCause}) despite a fire in range`);
  if (anyDestroyed(s.body)) fail('fire-keeps-warm: a bone was destroyed (fire must warm, not ignite)');
  if (s.needs.warmth < NEED_MAX - 1e-6)
    fail(`fire-keeps-warm: warmth ${s.needs.warmth} did not reach NEED_MAX`);
  console.log(
    `R2 fire-keeps-warm final warmth: ${s.needs.warmth} (min after warm-up: ${minWarmth.toFixed(2)})`,
  );
  ok(
    `fire keeps warm (final warmth ${s.needs.warmth} = NEED_MAX, never froze over 30000 ticks)`,
  );
}

console.log('\nALL PASS');
console.log(
  'SUMMARY: warmth depletes in open cold → frozen corpse (rig intact, 0 cells sprayed); a fire within FIRE_WARMTH_RADIUS restores/holds warmth at NEED_MAX; FIRE_WARMTH_RADIUS >= FLEE_FIRE_RADIUS.',
);
