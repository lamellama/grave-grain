/**
 * p9-reachable (task 9-8) — survivor resource targeting picks the nearest
 * REACHABLE resource, not the geometrically-nearest one it can't path to
 * (playtest #3 forage/drink natural worldgen resources; #5 miner reaches ore).
 * Real modules, no mocks. tsc (commonjs) → node.
 *
 * Scenes:
 *   1. Forage a NATURAL worldgen FOLIAGE bush (generateWorld + navgrid).
 *   2a. Drink from the reachable spawn pond in the generated world.
 *   2b. Constructed: a NEAR sealed pool + a FARTHER open pond → drinks the pond,
 *       never fixates on the unreachable sealed pool.
 *   3. No reachable water at all → still dies of thirst (graceful degradation).
 *   4. Miner walks to and mines a reachable EXPOSED ore face (stockpile.ore↑).
 */
import { createSurvivor, updateSurvivor, assignRole } from '../src/characters/survivor';
import type { Survivor } from '../src/characters/survivor';
import { material, set, idx } from '../src/engine/grid';
import { STONE, WATER, FOLIAGE, ORE, DIRT, AIR } from '../src/engine/materials';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { makeTool } from '../src/game/roles';
import { generateWorld } from '../src/game/worldgen';
import {
  getStockpile,
  resetStockpile,
  setStockpilePoint,
} from '../src/game/resources';
import { WORLD_W, WORLD_H, WORLDGEN_SEED, NEED_MAX, CAMP_HALF_WIDTH } from '../src/config';

declare const process: any;

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
function clearGrid(): void {
  material.fill(AIR);
}
function floor(x0: number, x1: number, top: number, bottom: number, mat = STONE): void {
  for (let x = x0; x <= x1; x++)
    for (let r = top; r <= bottom; r++) set(x, r, mat);
}
// Min Euclidean distance from the body anchor to the nearest cell of `mat`
// within the column window [x0,x1] (used to target a SPECIFIC pool, not all).
function minDistToWindow(s: Survivor, mat: number, x0: number, x1: number): number {
  const bx = Math.round(s.body.x);
  const by = Math.round(s.body.y);
  let best = Infinity;
  for (let y = 0; y < WORLD_H; y++)
    for (let x = x0; x <= x1; x++)
      if (material[idx(x, y)] === mat) {
        const d = Math.hypot(x - bx, y - by);
        if (d < best) best = d;
      }
  return best;
}
function countMat(mat: number): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === mat) n++;
  return n;
}
// First non-AIR / non-FOLIAGE cell top-down in a column = the surface row.
function surfaceRow(x: number): number {
  for (let y = 0; y < WORLD_H; y++) {
    const m = material[idx(x, y)];
    if (m !== AIR && m !== FOLIAGE) return y;
  }
  return WORLD_H;
}
// Min Euclidean distance from the body anchor to any cell of `mat` in a window.
function minDistTo(s: Survivor, mat: number): number {
  const bx = Math.round(s.body.x);
  const by = Math.round(s.body.y);
  let best = Infinity;
  for (let y = 0; y < WORLD_H; y++)
    for (let x = 0; x < WORLD_W; x++)
      if (material[idx(x, y)] === mat) {
        const d = Math.hypot(x - bx, y - by);
        if (d < best) best = d;
      }
  return best;
}

// ===========================================================================
// 1. FORAGE a NATURAL worldgen FOLIAGE bush.
// ===========================================================================
console.log('\n=== 1. Forage natural worldgen foliage ===');
{
  resetStockpile();
  const res = generateWorld(WORLDGEN_SEED);
  rebuildNavgrid();
  // Task W5: worldgen now builds a sealed starter camp ON res.spawnX, so spawn
  // on OPEN ground just left of the camp (toward the guaranteed grove) to test
  // foraging a natural worldgen bush from a free-roaming survivor.
  const forageX = res.spawnX - (CAMP_HALF_WIDTH + 34);
  const sr = surfaceRow(forageX);
  const s = createSurvivor(forageX, sr - 1);
  s.needs.hunger = 30; // below HUNGER_THRESHOLD → seekFood auto-override
  const before = s.needs.hunger;
  const foliageBefore = countMat(FOLIAGE);
  let switched = false;
  let peak = before;
  let ate = -1;
  for (let i = 0; i < 40000 && s.body.alive && peak < NEED_MAX - 5; i++) {
    updateSurvivor(s);
    if (s.behaviour === 'seekFood' || s.behaviour === 'consuming') switched = true;
    if (peak < s.needs.hunger) ate = i;
    peak = Math.max(peak, s.needs.hunger);
  }
  const foliageAfter = countMat(FOLIAGE);
  console.log(
    `  forageX=${forageX} surfaceRow=${sr} | hunger ${before} → peak ${peak.toFixed(1)} | ` +
      `foliage ${foliageBefore} → ${foliageAfter} | ticks-to-eat=${ate} | alive=${s.body.alive}`,
  );
  check(switched, '1: auto-override to seekFood fired');
  check(foliageAfter === foliageBefore - 1, '1: exactly one worldgen FOLIAGE cell eaten (→AIR)');
  check(peak >= NEED_MAX - 5, '1: hunger restored toward NEED_MAX from a natural bush');
  check(s.body.alive, '1: survivor did NOT die');
}

// ===========================================================================
// 2a. DRINK from the reachable spawn pond in the generated world.
// ===========================================================================
console.log('\n=== 2a. Drink reachable spawn pond (generated world) ===');
{
  resetStockpile();
  const res = generateWorld(WORLDGEN_SEED);
  rebuildNavgrid();
  // Task W5: spawn on OPEN ground just right of the sealed starter camp (toward
  // the guaranteed surface pond) so a free-roaming survivor drinks it.
  const drinkX = res.spawnX + (CAMP_HALF_WIDTH + 34);
  const sr = surfaceRow(drinkX);
  const s = createSurvivor(drinkX, sr - 1);
  s.needs.thirst = 30;
  const before = s.needs.thirst;
  let peak = before;
  let drank = -1;
  for (let i = 0; i < 40000 && s.body.alive && peak < NEED_MAX - 5; i++) {
    updateSurvivor(s);
    if (peak < s.needs.thirst) drank = i;
    peak = Math.max(peak, s.needs.thirst);
  }
  console.log(
    `  thirst ${before} → peak ${peak.toFixed(1)} | ticks-to-drink=${drank} | alive=${s.body.alive}`,
  );
  check(peak >= NEED_MAX - 5, '2a: thirst restored from the reachable worldgen pond');
  check(s.body.alive, '2a: survivor did NOT die');
}

// ===========================================================================
// 2b. NEAR sealed pool + FARTHER open pond → drink the reachable pond.
// ===========================================================================
console.log('\n=== 2b. Skip near sealed pool, drink farther open pond ===');
{
  resetStockpile();
  clearGrid();
  const TOP = 150;
  floor(100, 600, TOP, TOP + 20); // deep stone floor (surface row = 150)
  // NEAR sealed pool: water encased in the stone block (no standable bank).
  for (let x = 253; x <= 257; x++) for (let y = 153; y <= 155; y++) set(x, y, WATER);
  // FARTHER open pond: a water block sitting on the floor with open air above
  // and dry stone banks either side (a reachable surface source).
  for (let x = 337; x <= 341; x++) for (let y = 148; y <= 149; y++) set(x, y, WATER);
  rebuildNavgrid();
  const s = createSurvivor(270, 149); // between the two: pool at ~255, pond at ~339
  s.needs.thirst = 30;
  const before = s.needs.thirst;
  let peak = before;
  let minPond = Infinity;
  for (let i = 0; i < 30000 && s.body.alive && peak < NEED_MAX - 5; i++) {
    updateSurvivor(s);
    peak = Math.max(peak, s.needs.thirst);
    minPond = Math.min(minPond, minDistToWindow(s, WATER, 337, 341));
  }
  const finalX = Math.round(s.body.x);
  console.log(
    `  thirst ${before} → peak ${peak.toFixed(1)} | finalX=${finalX} (sealed≈255, pond≈339) | ` +
      `minDist→pond=${minPond.toFixed(1)} | alive=${s.body.alive}`,
  );
  check(peak >= NEED_MAX - 5, '2b: thirst restored (drank the reachable pond)');
  check(minPond <= 5, '2b: reached the open pond water (not stuck at the sealed pool)');
  check(finalX > 300, '2b: ended near the open pond, never fixated on the near sealed pool');
  check(s.body.alive, '2b: survivor did NOT die');
}

// ===========================================================================
// 3. NO reachable water → still dies of thirst (graceful degradation).
// ===========================================================================
console.log('\n=== 3. No reachable water → dies of thirst ===');
{
  resetStockpile();
  clearGrid();
  const TOP = 150;
  floor(100, 600, TOP, TOP + 7);
  // A single SEALED pool only — unreachable, so the survivor must still starve
  // of thirst rather than fixate on it forever.
  for (let x = 300; x <= 304; x++) for (let y = 153; y <= 155; y++) set(x, y, WATER);
  rebuildNavgrid();
  const s = createSurvivor(330, 149);
  s.needs.thirst = 30;
  let deathTick = -1;
  for (let i = 0; i < 60000 && deathTick < 0; i++) {
    updateSurvivor(s);
    if (!s.body.alive) deathTick = i;
  }
  console.log(`  death tick=${deathTick} cause=${s.deathCause} alive=${s.body.alive}`);
  check(!s.body.alive && s.deathCause === 'thirst', '3: sealed-only water → still dies of thirst');
}

// ===========================================================================
// 4. MINER walks to and mines a reachable EXPOSED ore face.
// ===========================================================================
console.log('\n=== 4. Miner reaches and mines exposed ore ===');
{
  resetStockpile();
  clearGrid();
  const TOP = 150;
  floor(100, 400, TOP, TOP + 20, DIRT); // lower ground = DIRT (NOT mineable rock)
  // A raised STONE plateau from x320 → a vertical cliff FACE at x320.
  floor(320, 360, 141, 149, STONE);
  // Expose ORE on the cliff face (left neighbour is AIR at these rows).
  const oreFace: Array<{ x: number; y: number }> = [];
  for (let y = 145; y <= 149; y++) {
    set(320, y, ORE);
    oreFace.push({ x: 320, y });
  }
  rebuildNavgrid();
  setStockpilePoint(305, 149); // deposit point on the reachable lower ground
  const s = createSurvivor(300, 149);
  s.role = 'miner';
  s.tool = makeTool('pickaxe');
  s.roleState = 'toTarget';
  const oreBefore = countMat(ORE);
  let mined = -1;
  let reached = Infinity;
  for (let i = 0; i < 40000 && getStockpile().ore === 0; i++) {
    updateSurvivor(s);
    reached = Math.min(reached, minDistTo(s, ORE));
    if (mined < 0 && countMat(ORE) < oreBefore) mined = i;
  }
  const oreAfter = countMat(ORE);
  console.log(
    `  ore cells ${oreBefore} → ${oreAfter} | ticks-to-mine=${mined} | minDist→ore=${reached.toFixed(1)} | ` +
      `stockpile.ore=${getStockpile().ore} | finalX=${Math.round(s.body.x)}`,
  );
  check(oreAfter === oreBefore - 1, '4: exactly one exposed ORE cell mined (→AIR)');
  check(getStockpile().ore > 0, '4: mined ore deposited to the stockpile (reachable face)');
  check(s.body.alive, '4: miner did NOT die');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
