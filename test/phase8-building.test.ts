/**
 * phase8-building.test.ts — Phase 8 integration lock (GDD §8, §7.3, §7.4)
 *
 * Four assertions over real modules (no mocks):
 *   A1  Scarcity: placeStructure('fence') drains wood until empty, then fails;
 *       stockpile never negative; placed cells are WOOD (id 6) with integrity 60.
 *   A2  Wall ≠ raw stone under breaching: WALL (hasIntegrity=true) chips over
 *       time; raw STONE (hasIntegrity=false) is NEVER chipped.
 *   A3  Fence weaker than wall: WOOD fence (integrity 60) breaches in fewer ticks
 *       than WALL (integrity 200) under equal pursuit pressure.
 *   A4  Fire-as-tool: igniting one fence cell → fire spreads to an adjacent fence
 *       cell (fence-to-fence) proving careless fire catches own structures (§7.3).
 *
 * Scene setup mirrors p7-t5.test.ts: stone floor, barrier, zombie pursues
 * survivor. Seeded RNG for reproducibility.
 */

// ---- seeded RNG (mulberry32) ------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedRandom(seed: number): void {
  Math.random = mulberry32(seed);
}

// ---- imports ----------------------------------------------------------------
import { placeStructure }                    from '../src/game/building';
import { addResource, resetStockpile, getStockpile } from '../src/game/resources';
import { material, set, get, getIntegrity, placeMaterial, integrity } from '../src/engine/grid';
import { rebuildNavgrid }                    from '../src/engine/navgrid';
import { WOOD, STONE, WALL, AIR, FIRE }      from '../src/engine/materials';
import { WORLD_W, WOOD_INTEGRITY, WALL_INTEGRITY, P3_GROUND_Y } from '../src/config';
import { createZombie, updateZombie }        from '../src/characters/zombie';
import { createSurvivor }                    from '../src/characters/survivor';
import { resolveBreaching }                  from '../src/game/breaching';
import { step, ignite }                      from '../src/engine/simulation';

declare const process: any;

// ---- harness ----------------------------------------------------------------
let totalFailed = 0;
function label(name: string): void { console.log(`\n=== ${name} ===`); }
function ok(cond: boolean, msg: string): boolean {
  if (cond) { console.log('  PASS:', msg); }
  else       { console.error('  FAIL:', msg); totalFailed++; }
  return cond;
}

// ---- shared scene geometry (mirrors p7-t5) ----------------------------------
const FLOOR     = P3_GROUND_Y;            // stone floor row
const BARRIER_X = 120;                    // chokepoint column
const FENCE_HEIGHT = 4;                   // tall enough that zombie can't step over
const FENCE_TOP = FLOOR - FENCE_HEIGHT;   // topmost barrier row
const SPAWN_GAP = 6;                      // cells zombie spawns left of barrier

/**
 * Clear the world, lay a stone floor, place a barrier column of `barrierMat`
 * at BARRIER_X, rebuild navgrid, spawn n zombies left of barrier and one
 * target survivor to the right (inside SENSE_RADIUS).
 */
function buildScene(n: number, barrierMat: number) {
  material.fill(0);
  integrity.fill(0);
  // Stone floor spanning full width
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  // Barrier column
  for (let y = FENCE_TOP; y <= FLOOR - 1; y++) placeMaterial(BARRIER_X, y, barrierMat);
  rebuildNavgrid();
  // Zombies spawn a few cells left of the barrier and will walk/press it
  const zombies = [];
  for (let i = 0; i < n; i++) {
    zombies.push(createZombie(BARRIER_X - SPAWN_GAP, FLOOR - 1));
  }
  // Target: well inside SENSE_RADIUS but beyond the barrier
  const target = createSurvivor(BARRIER_X + 10, FLOOR - 1);
  return { zombies, target };
}

/** One sim tick: zombie AI + breaching pass. */
function tickBreaching(
  zombies: ReturnType<typeof createZombie>[],
  target: ReturnType<typeof createSurvivor>,
): void {
  for (const z of zombies) updateZombie(z, [target]);
  resolveBreaching(zombies);
}

// ============================================================
// A1 — Scarcity: wood runs out → further fences rejected
// ============================================================
label('A1 Scarcity');
seedRandom(42);
resetStockpile();

const WOOD_SEED = 3; // enough for exactly 3 fence cells (fence cost = 1 wood each)
addResource('wood', WOOD_SEED);
ok(getStockpile().wood === WOOD_SEED, `setup: wood === ${WOOD_SEED}`);

// Clear grid area we'll use
material.fill(0);
integrity.fill(0);

let successCount = 0;
let failCount = 0;
const PLACE_ATTEMPTS = WOOD_SEED + 2;
for (let i = 0; i < PLACE_ATTEMPTS; i++) {
  const placed = placeStructure(50 + i, 10, 'fence');
  if (placed) successCount++;
  else         failCount++;
}

ok(successCount === WOOD_SEED,
   `placed exactly ${WOOD_SEED} fence cells (one per wood unit), got ${successCount}`);
ok(failCount === 2,
   `${2} placements failed after exhaustion, got ${failCount}`);
ok(getStockpile().wood === 0,
   `stockpile drained to 0 (was ${WOOD_SEED}), now ${getStockpile().wood}`);
ok(getStockpile().wood >= 0,
   `stockpile never went negative: ${getStockpile().wood}`);

// Verify placed cells
let a1CellsOk = true;
for (let i = 0; i < WOOD_SEED; i++) {
  const x = 50 + i;
  if (get(x, 10) !== WOOD)            a1CellsOk = false;
  if (getIntegrity(x, 10) !== WOOD_INTEGRITY) a1CellsOk = false;
}
ok(a1CellsOk,
   `all ${WOOD_SEED} placed cells are WOOD (id ${WOOD}) with integrity ${WOOD_INTEGRITY}`);

// Cells that were NOT placed (indices WOOD_SEED and WOOD_SEED+1) must be AIR
let a1RejectOk = true;
for (let i = WOOD_SEED; i < PLACE_ATTEMPTS; i++) {
  if (get(50 + i, 10) !== AIR) a1RejectOk = false;
}
ok(a1RejectOk, 'rejected placements left cells as AIR');
const a1Pass = successCount === WOOD_SEED && failCount === 2 && getStockpile().wood === 0 && a1CellsOk && a1RejectOk;

// ============================================================
// A2 — Wall ≠ raw stone under breaching
//       WALL chips; STONE is never chipped
// ============================================================
label('A2 Wall vs Raw Stone under breaching');
seedRandom(7);

// --- sub-test: WALL integrity decreases when pressed ---
const WALL_TICK_LIMIT = 6000;
const { zombies: wallZombies, target: wallTarget } = buildScene(3, WALL);

// We need to find the first WALL cell that gets pressed and watch its integrity.
// Run until integrity of at least one barrier cell has dropped.
let wallIntegBefore = WALL_INTEGRITY;
// Find the min integrity in the barrier column after many ticks
let wallChipped = false;
let wallTicksTaken = 0;
for (let t = 1; t <= WALL_TICK_LIMIT; t++) {
  tickBreaching(wallZombies, wallTarget);
  // Check if any barrier cell has been chipped
  for (let y = FENCE_TOP; y <= FLOOR - 1; y++) {
    const mat = get(BARRIER_X, y);
    const integ = getIntegrity(BARRIER_X, y);
    if ((mat === WALL || mat === AIR) && integ < wallIntegBefore) {
      wallChipped = true;
      wallIntegBefore = integ;
    }
  }
  if (wallChipped) { wallTicksTaken = t; break; }
}

// Find current min integrity of WALL column
let wallMinInteg = WALL_INTEGRITY;
for (let y = FENCE_TOP; y <= FLOOR - 1; y++) {
  const integ = getIntegrity(BARRIER_X, y);
  if (integ < wallMinInteg) wallMinInteg = integ;
}
console.log(`  WALL min integrity after ${wallTicksTaken} ticks: ${wallMinInteg} (started ${WALL_INTEGRITY})`);
ok(wallChipped, `WALL integrity decreased (chipped at tick ${wallTicksTaken})`);

// --- sub-test: raw STONE is never chipped ---
seedRandom(7);
const { zombies: stoneZombies, target: stoneTarget } = buildScene(3, STONE);
// Run same number of ticks
for (let t = 1; t <= WALL_TICK_LIMIT; t++) {
  tickBreaching(stoneZombies, stoneTarget);
}
// Verify: all stone cells still STONE, all integrity still 0
let stoneIntact = true;
for (let y = FENCE_TOP; y <= FLOOR - 1; y++) {
  if (get(BARRIER_X, y) !== STONE)           stoneIntact = false;
  if (getIntegrity(BARRIER_X, y) !== 0)      stoneIntact = false;
}
console.log(`  STONE column intact after ${WALL_TICK_LIMIT} ticks: ${stoneIntact}`);
ok(stoneIntact, `raw STONE never chipped (hasIntegrity=false, integrity always 0, cell always STONE)`);
const a2Pass = wallChipped && stoneIntact;

// ============================================================
// A3 — Fence weaker than wall: fence breaches in fewer ticks
// ============================================================
label('A3 Fence (WOOD) breaches faster than Wall');

/**
 * Run the pursuit scene until a barrier cell (of given material) is destroyed
 * (→ AIR). Returns the tick count, or MAX_TICKS if not breached in time.
 */
function runToBreach(n: number, barrierMat: number, maxTicks: number): number {
  const { zombies, target } = buildScene(n, barrierMat);
  for (let t = 1; t <= maxTicks; t++) {
    tickBreaching(zombies, target);
    for (let y = FENCE_TOP; y <= FLOOR - 1; y++) {
      if (get(BARRIER_X, y) === AIR) return t;
    }
  }
  return maxTicks; // did not breach within limit
}

// Average over multiple seeds for robustness
const SEEDS_A3 = [11, 22, 33, 44, 55, 66, 77, 88, 99, 101];
const N_ZOMBIES = 3; // enough pressure for WALL to breach within reasonable time
const MAX_BREACH_TICKS = 12000;

function avgBreachTicks(mat: number): number {
  let sum = 0;
  for (const s of SEEDS_A3) {
    seedRandom(s);
    sum += runToBreach(N_ZOMBIES, mat, MAX_BREACH_TICKS);
  }
  return sum / SEEDS_A3.length;
}

const avgFenceTicks = avgBreachTicks(WOOD);
const avgWallTicks  = avgBreachTicks(WALL);

console.log(`  Fence (WOOD) avg ticks-to-breach: ${avgFenceTicks.toFixed(1)}`);
console.log(`  Wall  (WALL) avg ticks-to-breach: ${avgWallTicks.toFixed(1)}`);
console.log(`  Ratio: wall takes ${(avgWallTicks / avgFenceTicks).toFixed(2)}× longer`);

ok(avgFenceTicks < avgWallTicks,
   `fence breaches in fewer avg ticks (${avgFenceTicks.toFixed(1)}) than wall (${avgWallTicks.toFixed(1)})`);
const a3Pass = avgFenceTicks < avgWallTicks;

// ============================================================
// A4 — Fire-as-tool: igniting one fence cell spreads to adjacent
// ============================================================
label('A4 Fire spreads to adjacent fence (own structure catches)');
seedRandom(314);

// Clear world, build a short WOOD fence line (3 cells side by side, no floor needed)
material.fill(0);
integrity.fill(0);
rebuildNavgrid();

const FIRE_ROW = 50;
const FIRE_COL_START = 200;
const FIRE_FENCE_LEN = 3; // 3 contiguous WOOD fence cells

for (let i = 0; i < FIRE_FENCE_LEN; i++) {
  placeMaterial(FIRE_COL_START + i, FIRE_ROW, WOOD);
}

// Confirm all three cells are WOOD before ignition
let fenceBuilt = true;
for (let i = 0; i < FIRE_FENCE_LEN; i++) {
  if (get(FIRE_COL_START + i, FIRE_ROW) !== WOOD) fenceBuilt = false;
}
ok(fenceBuilt, `seeded ${FIRE_FENCE_LEN} WOOD fence cells at row ${FIRE_ROW} cols ${FIRE_COL_START}–${FIRE_COL_START + FIRE_FENCE_LEN - 1}`);

// Ignite the leftmost fence cell
ignite(FIRE_COL_START, FIRE_ROW);
ok(get(FIRE_COL_START, FIRE_ROW) === FIRE, `leftmost cell is now FIRE after ignite()`);

// Step the simulation and detect spread to an adjacent fence cell.
// FIRE_SPREAD_CHANCE=0.25 per neighbour per tick → expect spread quickly.
// Run up to 200 ticks; at 25% per tick the probability of NOT spreading in 200
// ticks to at least one neighbour is (0.75)^200 ≈ 10^-25 — effectively zero.
const FIRE_STEP_LIMIT = 200;
let spreadDetected = false;
let spreadTick = -1;

for (let t = 1; t <= FIRE_STEP_LIMIT; t++) {
  step();
  // Check if any of the originally-WOOD cells (other than col 0) is now FIRE
  for (let i = 1; i < FIRE_FENCE_LEN; i++) {
    if (get(FIRE_COL_START + i, FIRE_ROW) === FIRE) {
      spreadDetected = true;
      spreadTick = t;
      break;
    }
  }
  if (spreadDetected) break;
}

console.log(`  Fire spread to adjacent fence cell: ${spreadDetected} (at tick ${spreadTick})`);
ok(spreadDetected,
   `FIRE spread from fence cell [${FIRE_COL_START}] to adjacent fence cell within ${FIRE_STEP_LIMIT} ticks`);
const a4Pass = spreadDetected;

// ============================================================
// SUMMARY
// ============================================================
console.log('\n══════════════════════════════════════════════════════');
console.log(`A1 Scarcity-gated placement: ${a1Pass ? 'PASS' : 'FAIL'}`);
console.log(`A2 Wall chips / Stone immune: ${a2Pass ? 'PASS' : 'FAIL'}`);
console.log(`A3 Fence < Wall breach ticks: ${a3Pass ? 'PASS' : 'FAIL'}`);
console.log(`A4 Fire spreads own fence:    ${a4Pass ? 'PASS' : 'FAIL'}`);
const allPass = a1Pass && a2Pass && a3Pass && a4Pass;
console.log(`══════════════════════════════════════════════════════`);
console.log(allPass ? 'OVERALL: PASS' : `OVERALL: FAIL (${totalFailed} assertion(s) failed)`);
process.exit(allPass ? 0 : 1);
