/**
 * Headless verification for p5-t4 — auto-override: crossing a need threshold
 * drops wander and self-preserves via pathfinding + local steering (GDD §6.1,
 * §13). Imports the REAL modules (no mocks); seeds terrain into grid.material,
 * builds the navgrid, then steps updateSurvivor. Run via tsc (commonjs) → node.
 */
import { createSurvivor, updateSurvivor } from '../src/characters/survivor';
import type { Survivor } from '../src/characters/survivor';
import { material, set, idx } from '../src/engine/grid';
import { STONE, WATER, FOLIAGE, AIR } from '../src/engine/materials';
import {
  rebuildNavgrid,
  markTerrainEdit,
  epochAt,
  coarseOf,
} from '../src/engine/navgrid';
import { isPathStale } from '../src/game/pathfinding';
import { WORLD_W, NEED_MAX, THIRST_THRESHOLD, HUNGER_THRESHOLD } from '../src/config';

const FLOOR = 150;
let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
function clearGrid(): void {
  material.fill(AIR);
}
function floor(x0: number, x1: number, top = FLOOR): void {
  for (let x = x0; x <= x1; x++)
    for (let r = top; r < top + 8; r++) set(x, r, STONE);
}
// Min Euclidean distance from the body anchor to any cell of `mat`.
function minDistTo(s: Survivor, mat: number): number {
  const bx = Math.round(s.body.x);
  const by = Math.round(s.body.y);
  let best = Infinity;
  for (let y = 0; y < 240; y++)
    for (let x = 0; x < WORLD_W; x++)
      if (material[y * WORLD_W + x] === mat) {
        const d = Math.hypot(x - bx, y - by);
        if (d < best) best = d;
      }
  return best;
}
// Does ANY non-destroyed body pixel currently sit in a cell of `mat`?
function bodyOverlaps(s: Survivor, mat: number): boolean {
  const b = s.body;
  for (const bone of b.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const wx = Math.round(b.x) + bone.offset.dx + p.dx;
      const wy = Math.round(b.y) + bone.offset.dy + p.dy;
      if (material[wy * WORLD_W + wx] === mat) return true;
    }
  }
  return false;
}

// ===========================================================================
// 1. THIRST: seek water, drink, recover, don't die.
// ===========================================================================
clearGrid();
floor(100, 600);
for (let x = 280; x <= 285; x++) for (let y = 146; y <= 149; y++) set(x, y, WATER);
rebuildNavgrid();
{
  const s = createSurvivor(200, 149);
  s.needs.thirst = 30; // below THIRST_THRESHOLD (35) → must auto-override
  const before = s.needs.thirst;
  let switched = false;
  let minD = Infinity;
  let peak = before;
  // Step until the thirst has been restored (then stop, so post-drink wander
  // depletion doesn't muddy the "restored toward NEED_MAX" check).
  for (let i = 0; i < 6000 && s.body.alive && peak < NEED_MAX - 5; i++) {
    updateSurvivor(s);
    if (s.behaviour === 'seekWater' || s.behaviour === 'consuming') switched = true;
    minD = Math.min(minD, minDistTo(s, WATER));
    peak = Math.max(peak, s.needs.thirst);
  }
  console.log(
    `R1 thirst ${before} → peak ${peak.toFixed(1)} | minDist→water=${minD.toFixed(1)} | alive=${s.body.alive} | behaviour=${s.behaviour}`,
  );
  check(switched, 'R1 auto-override to seekWater fired below threshold');
  check(minD <= 5, 'R1 reached a cell adjacent to the pool (minDist ≤ 5)');
  check(peak > before, 'R1 thirst recovered after drinking');
  check(peak >= NEED_MAX - 5, 'R1 thirst restored toward NEED_MAX');
  check(s.body.alive, 'R1 survivor did NOT die');
  check(!bodyOverlaps(s, WATER), 'R1 body never standing inside WATER while seeking');
}

// ===========================================================================
// 2. HUNGER: seek foliage, eat ADJACENT (never overlapping), consume the cell.
// ===========================================================================
clearGrid();
floor(100, 600);
for (let y = 147; y <= 149; y++) set(280, y, FOLIAGE); // single-column bush
rebuildNavgrid();
{
  const s = createSurvivor(200, 149);
  s.needs.hunger = 30; // below HUNGER_THRESHOLD
  const before = s.needs.hunger;
  let switched = false;
  let everOverlapped = false;
  let peak = before;
  const foliageBefore = countMat(FOLIAGE);
  // Snapshot the coarse cell epoch of the bush surface to confirm markTerrainEdit.
  const bc = coarseOf(280, 149);
  const epochBefore = epochAt(bc.cx, bc.cy);
  for (let i = 0; i < 6000 && s.body.alive && peak < NEED_MAX - 5; i++) {
    updateSurvivor(s);
    if (s.behaviour === 'seekFood' || s.behaviour === 'consuming') switched = true;
    if (bodyOverlaps(s, FOLIAGE)) everOverlapped = true;
    peak = Math.max(peak, s.needs.hunger);
  }
  const foliageAfter = countMat(FOLIAGE);
  const epochAfter = epochAt(bc.cx, bc.cy);
  console.log(
    `R2 hunger ${before} → peak ${peak.toFixed(1)} | foliage cells ${foliageBefore} → ${foliageAfter} | epoch ${epochBefore} → ${epochAfter} | overlapped=${everOverlapped}`,
  );
  check(switched, 'R2 auto-override to seekFood fired below threshold');
  check(!everOverlapped, 'R2 NO body pixel ever entered a FOLIAGE cell');
  check(peak >= NEED_MAX - 5, 'R2 hunger restored toward NEED_MAX');
  check(foliageAfter === foliageBefore - 1, 'R2 exactly one FOLIAGE cell consumed (→AIR)');
  check(epochAfter > epochBefore, 'R2 markTerrainEdit bumped the navgrid epoch on eat');
  check(s.body.alive, 'R2 survivor did NOT die');
}
function countMat(mat: number): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === mat) n++;
  return n;
}

// ===========================================================================
// 3. NO RESOURCE: nothing reachable → survivor still dies of the need.
// ===========================================================================
clearGrid();
floor(100, 600);
rebuildNavgrid();
{
  const s = createSurvivor(300, 149);
  s.needs.thirst = 30;
  let deathTick = -1;
  for (let i = 0; i < 60000 && deathTick < 0; i++) {
    updateSurvivor(s);
    if (!s.body.alive) deathTick = i;
  }
  console.log(`R3 death tick=${deathTick} cause=${s.deathCause} alive=${s.body.alive}`);
  check(!s.body.alive && s.deathCause === 'thirst', 'R3 no water → dies of thirst');
}

// ===========================================================================
// 4. MUTABLE TERRAIN: edit a cell ON the path → repath (stale) → still arrives.
// ===========================================================================
clearGrid();
floor(100, 600);
for (let x = 360; x <= 365; x++) for (let y = 146; y <= 149; y++) set(x, y, WATER);
rebuildNavgrid();
{
  const s = createSurvivor(200, 149);
  s.needs.thirst = 33;
  const before = s.needs.thirst;
  // Run a few ticks so the first path is planned.
  for (let i = 0; i < 5; i++) updateSurvivor(s);
  const oldPath = s.path;
  check(oldPath !== null, 'R4 a path was planned before the edit');
  // Drop terrain ON the path corridor (a 1-cell stone bump on the surface) and
  // notify the navgrid — this must make the existing path go stale.
  set(250, 149, STONE);
  markTerrainEdit(250, 149);
  const staleAfterEdit = oldPath ? isPathStale(oldPath) : false;
  check(staleAfterEdit, 'R4 edit on the path made it stale (isPathStale true)');
  // Continue: survivor should recompute and still reach the water and drink.
  let drank = false;
  let repathed = false;
  let peak = before;
  for (let i = 0; i < 6000 && s.body.alive && !drank; i++) {
    updateSurvivor(s);
    if (s.path !== null && s.path !== oldPath) repathed = true;
    peak = Math.max(peak, s.needs.thirst);
    if (peak >= NEED_MAX - 5) drank = true;
  }
  console.log(
    `R4 thirst ${before} → peak ${peak.toFixed(1)} | repathed=${repathed} | alive=${s.body.alive}`,
  );
  check(repathed, 'R4 survivor recomputed the path after the on-path edit');
  check(drank, 'R4 survivor still reached the water and drank');
  check(s.body.alive, 'R4 survivor did NOT die');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
