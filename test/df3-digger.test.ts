declare const process: any;
/**
 * df3-digger.test.ts — DF-3: digger roles (GDD §6.2, §14 Beyond item 4).
 * Headless e2e over the REAL modules: seeds terrain, assigns diggers, steps
 * updateSurvivor on a STATIC grid (no sim step - the carve edits are the
 * digger's own; flooding/pour-in interplay is the live sim's emergent layer).
 *
 * Done-when:
 *   1. diggerDown on a deep dirt plain carves a 45-degree stair-step tunnel
 *      DIG_DISTANCE columns long in the FACING direction; the body follows the
 *      staircase down (max feet depth ~ DIG_DISTANCE) and the job completes ->
 *      role 'none', shovel KEPT (reusable).
 *   2. The tunnel profile is real: each dug column's floor is intact and the
 *      bore above it is AIR (body-height clearance), descending 1 per column.
 *   3. diggerDown stops EARLY at a stone bed: stone count unchanged, role
 *      reverts before DIG_DISTANCE columns, and the face stone is left EXPOSED
 *      (isExposedRock true somewhere on the bed) for a miner.
 *   4. diggerUp tunnels UP through a dirt cliff (ramp/escape route): feet rise
 *      ~DIG_DISTANCE and the job completes.
 *   5. Facing is honoured: a left-facing digger digs at x < start.
 *   6. Shovel durability: a nearly-broken shovel breaks mid-dig -> tool null,
 *      role 'none' (idle), dig stops.
 *   7. No-tunnel invariant: the body never occupies a cell solid to bodies.
 */

import {
  createSurvivor,
  updateSurvivor,
  assignRole,
} from '../src/characters/survivor';
import type { Survivor } from '../src/characters/survivor';
import { material, set, get } from '../src/engine/grid';
import { STONE, DIRT, AIR, isSolidForBody } from '../src/engine/materials';
import { isExposedRock } from '../src/game/roles';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { addResource, resetStockpile, setStockpilePoint } from '../src/game/resources';
import {
  WORLD_W,
  WORLD_H,
  NEED_MAX,
  SHOVEL_WOOD_COST,
  DIG_DISTANCE,
  DIG_TICKS,
  BODY_H,
} from '../src/config';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
function clearGrid(): void {
  material.fill(AIR);
}
function countMat(mat: number): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === mat) n++;
  return n;
}
function bodyInSolid(s: Survivor): boolean {
  const b = s.body;
  for (const bone of b.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const wx = Math.round(b.x) + bone.offset.dx + p.dx;
      const wy = Math.round(b.y) + bone.offset.dy + p.dy;
      const m = material[wy * WORLD_W + wx];
      if (isSolidForBody(m)) return true;
    }
  }
  return false;
}
/** Fill a solid dirt block [x0..x1] x [y0..y1]. */
function dirtBlock(x0: number, x1: number, y0: number, y1: number): void {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) set(x, y, DIRT);
}
/** Run the digger until its job ends (role back to 'none') or maxTicks. */
function runDig(s: Survivor, maxTicks: number): {
  ticks: number;
  maxFeetY: number;
  minFeetY: number;
  tunneled: boolean;
} {
  let maxFeetY = -Infinity;
  let minFeetY = Infinity;
  let tunneled = false;
  let i = 0;
  for (; i < maxTicks; i++) {
    s.needs.thirst = NEED_MAX;
    s.needs.hunger = NEED_MAX;
    s.needs.warmth = NEED_MAX;
    updateSurvivor(s);
    if (bodyInSolid(s)) tunneled = true;
    const fy = Math.round(s.body.y);
    if (fy > maxFeetY) maxFeetY = fy;
    if (fy < minFeetY) minFeetY = fy;
    if (s.role === 'none') break;
  }
  return { ticks: i, maxFeetY, minFeetY, tunneled };
}

const SURFACE = 120; // top row of the dirt plain (feet stand at SURFACE-1)

// ===========================================================================
// 1 + 2. Down-dig a full-length staircase into a deep dirt plain (facing right)
// ===========================================================================
console.log('--- 1/2: down-dig full distance, staircase profile ---');
clearGrid();
dirtBlock(50, WORLD_W - 50, SURFACE, Math.min(WORLD_H - 5, SURFACE + 120));
rebuildNavgrid();
resetStockpile();
setStockpilePoint(150, SURFACE - 1);
addResource('wood', SHOVEL_WOOD_COST);
{
  const s = createSurvivor(200, SURFACE - 1);
  s.body.facing = 1;
  check(assignRole(s, 'diggerDown') === true, '1: assignRole(diggerDown) === true');
  check(s.tool !== null && s.tool.kind === 'shovel', '1: survivor holds a shovel');

  const r = runDig(s, 30000);
  console.log(`   ticks=${r.ticks} maxFeetY=${r.maxFeetY} (start ${SURFACE - 1})`);
  check(s.role === 'none', '1: job completed -> role reverted to none');
  check(s.tool !== null && s.tool.kind === 'shovel', '1: shovel KEPT for the next dig');
  // The body rides the staircase on its trailing foot (rigid 6-wide rig), so
  // its feet lag the face by a few rows - assert it clearly followed the
  // tunnel down; the grid-profile check below pins the full excavation.
  check(
    r.maxFeetY >= SURFACE - 1 + 8,
    `1: body followed the staircase down (maxFeetY ${r.maxFeetY} >= ${SURFACE - 1 + 8})`,
  );
  check(!r.tunneled, '7: no-tunnel held during the down-dig');

  // Staircase profile: the dig anchored just past the leading edge (204) with
  // its first tread 1 below the original floor: tread(k) = SURFACE+1+k.
  // Column 204+k must keep that tread intact with an AIR bore above it.
  let profileOk = true;
  for (let k = 0; k < DIG_DISTANCE; k++) {
    const cx = 204 + k;
    const floorY = SURFACE + 1 + k;
    if (get(cx, floorY) !== DIRT) profileOk = false; // tread intact
    if (get(cx, floorY - 1) !== AIR) profileOk = false; // bore carved
    if (get(cx, floorY - BODY_H) !== AIR) profileOk = false; // full headroom
  }
  check(profileOk, '2: 45-degree staircase (intact treads, BODY_H headroom) for all columns');
}

// ===========================================================================
// 3. Down-dig stops at a stone bed, leaving it exposed
// ===========================================================================
console.log('--- 3: down-dig stops at stone ---');
clearGrid();
dirtBlock(50, WORLD_W - 50, SURFACE, SURFACE + 5); // thin dirt skin...
for (let x = 50; x <= WORLD_W - 50; x++)
  for (let y = SURFACE + 6; y <= SURFACE + 40; y++) set(x, y, STONE); // ...on rock
rebuildNavgrid();
resetStockpile();
setStockpilePoint(150, SURFACE - 1);
addResource('wood', SHOVEL_WOOD_COST);
{
  const s = createSurvivor(200, SURFACE - 1);
  s.body.facing = 1;
  const stoneStart = countMat(STONE);
  assignRole(s, 'diggerDown');
  const stepsAtStart = s.digStepsLeft;
  const r = runDig(s, 30000);
  console.log(`   ticks=${r.ticks} maxFeetY=${r.maxFeetY} stepsLeft=${s.digStepsLeft}/${stepsAtStart}`);
  check(s.role === 'none', '3: dig ended (role none)');
  check(s.digStepsLeft > 0, '3: stopped EARLY (columns remained when rock blocked)');
  check(countMat(STONE) === stoneStart, '3: stone count unchanged (never shoveled)');
  check(
    r.maxFeetY <= SURFACE + 6,
    `3: descent halted at the bed (maxFeetY ${r.maxFeetY} <= ${SURFACE + 6})`,
  );
  // The face/floor stone is now open to the tunnel: some stone cell around the
  // final position is exposed (an AIR orthogonal neighbour) - minable (GDD 6.2).
  let exposed = false;
  const bx = Math.round(s.body.x);
  for (let dx = -8; dx <= 8 && !exposed; dx++) {
    for (let dy = -4; dy <= 8 && !exposed; dy++) {
      if (isExposedRock(bx + dx, Math.round(s.body.y) + dy)) exposed = true;
    }
  }
  check(exposed, '3: stone at the face left EXPOSED for a miner');
  check(!r.tunneled, '7: no-tunnel held during the stone-stop dig');
}

// ===========================================================================
// 4. Up-dig a ramp through a dirt cliff
// ===========================================================================
console.log('--- 4: up-dig ramp through a cliff ---');
clearGrid();
const CLIFF_FLOOR = 200; // low ground rows for the approach
dirtBlock(50, 259, CLIFF_FLOOR, CLIFF_FLOOR + 30); // low apron the digger stands on
dirtBlock(260, WORLD_W - 50, CLIFF_FLOOR - 60, CLIFF_FLOOR + 30); // the cliff mass
rebuildNavgrid();
resetStockpile();
setStockpilePoint(150, CLIFF_FLOOR - 1);
addResource('wood', SHOVEL_WOOD_COST);
{
  const s = createSurvivor(256, CLIFF_FLOOR - 1); // at the cliff base, facing it
  s.body.facing = 1;
  check(assignRole(s, 'diggerUp') === true, '4: assignRole(diggerUp) === true');
  const r = runDig(s, 30000);
  console.log(`   ticks=${r.ticks} minFeetY=${r.minFeetY} (start ${CLIFF_FLOOR - 1})`);
  check(s.role === 'none', '4: up-dig completed (role none)');
  check(
    r.minFeetY <= CLIFF_FLOOR - 1 - 8,
    `4: body climbed the carved ramp (minFeetY ${r.minFeetY} <= ${CLIFF_FLOOR - 1 - 8})`,
  );
  // Rising staircase profile: the dig anchored at 260 (leading edge + 1) with
  // its first floor 1 ABOVE the original floor (199). Column 260+k keeps its
  // tread solid at 199-k with a carved bore cell above it.
  let rampOk = true;
  for (let k = 0; k < DIG_DISTANCE; k++) {
    const cx = 260 + k;
    const floorY = 199 - k;
    if (get(cx, floorY) !== DIRT) rampOk = false; // tread intact
    if (get(cx, floorY - 1) !== AIR) rampOk = false; // bore carved
  }
  check(rampOk, '4: 45-degree rising ramp (intact treads, carved bore) for all columns');
  check(!r.tunneled, '7: no-tunnel held during the up-dig');
}

// ===========================================================================
// 5. Facing is honoured (left-facing digger digs left)
// ===========================================================================
console.log('--- 5: left-facing dig goes left ---');
clearGrid();
dirtBlock(50, WORLD_W - 50, SURFACE, SURFACE + 60);
rebuildNavgrid();
resetStockpile();
setStockpilePoint(260, SURFACE - 1);
addResource('wood', SHOVEL_WOOD_COST);
{
  const s = createSurvivor(200, SURFACE - 1);
  s.body.facing = -1;
  assignRole(s, 'diggerDown');
  const r = runDig(s, 30000);
  check(s.role === 'none' && r.maxFeetY >= SURFACE - 1 + 8,
    '5: left dig completed to depth');
  // Carved bore exists on the LEFT of the start column, none on the right.
  // First left column 196 has tread SURFACE+1, so its bore includes SURFACE.
  const leftCarved = get(196, SURFACE) === AIR;
  const rightIntact = get(204, SURFACE) === DIRT;
  check(leftCarved && rightIntact, '5: tunnel is on the facing (left) side only');
  check(!r.tunneled, '7: no-tunnel held during the left dig');
}

// ===========================================================================
// 6. Shovel break mid-dig -> idle
// ===========================================================================
console.log('--- 6: shovel breaks mid-dig ---');
clearGrid();
dirtBlock(50, WORLD_W - 50, SURFACE, SURFACE + 60);
rebuildNavgrid();
resetStockpile();
setStockpilePoint(150, SURFACE - 1);
addResource('wood', SHOVEL_WOOD_COST);
{
  const s = createSurvivor(200, SURFACE - 1);
  s.body.facing = 1;
  assignRole(s, 'diggerDown');
  s.tool!.durability = 3; // nearly broken
  const r = runDig(s, 30000);
  console.log(`   ticks=${r.ticks} maxFeetY=${r.maxFeetY} stepsLeft=${s.digStepsLeft}`);
  check(s.role === 'none' && s.tool === null, '6: shovel broke -> idle, tool discarded');
  check(s.digStepsLeft === DIG_DISTANCE - 3, '6: exactly 3 columns dug (one use each)');
  check(
    r.ticks < DIG_TICKS * 6 + 500,
    `6: ended promptly after the third carve (${r.ticks} ticks)`,
  );
  check(!r.tunneled, '7: no-tunnel held during the break dig');
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(
  '\nSUMMARY: diggers carve real 45-degree stair-step tunnels in the facing direction (down to depth, up as a ramp), stop at stone leaving it exposed, wear the shovel one use per column, and never tunnel the body. ALL PASS',
);
