declare const process: any;
/**
 * df2-fisherman.test.ts — DF-2: fisherman role loop (GDD §6.2, §14 Beyond
 * item 4). Headless e2e over the REAL modules: seeds a stone world with a
 * dug pond, assigns a fisherman, and steps updateSurvivor.
 *
 * Done-when:
 *   1. assignRole('fisherman') auto-crafts the rod (wood debited).
 *   2. The fisherman walks to a standable bank, works FISH_TICKS, and food
 *      lands in the stockpile (deposited at the stockpile point).
 *   3. The WATER is NEVER consumed: the pond's water cell count is unchanged
 *      after multiple catches (renewable food).
 *   4. First catch takes at least FISH_TICKS (real timed work, no free food).
 *   5. The rod breaks after WOOD_TOOL_DURABILITY catches -> role 'none',
 *      tool null (idle).
 *   6. No-tunnel: the body never enters a cell solid to bodies.
 *   7. No water in range -> the fisherman wanders (no target, no crash, no food).
 */

import {
  createSurvivor,
  updateSurvivor,
  assignRole,
} from '../src/characters/survivor';
import type { Survivor } from '../src/characters/survivor';
import { material, set } from '../src/engine/grid';
import { STONE, WATER, AIR, isSolidForBody } from '../src/engine/materials';
import { rebuildNavgrid } from '../src/engine/navgrid';
import {
  addResource,
  getStockpile,
  resetStockpile,
  setStockpilePoint,
} from '../src/game/resources';
import {
  WORLD_W,
  NEED_MAX,
  ROD_WOOD_COST,
  FOOD_PER_FISH,
  FISH_TICKS,
  WOOD_TOOL_DURABILITY,
} from '../src/config';

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
    for (let r = top; r < top + 20; r++) set(x, r, STONE);
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

// ===========================================================================
// Scene: stone plain with a pond DUG INTO the floor (water is walled by stone
// on every side, so the static grid holds it). Bank stands are the pond lip.
// ===========================================================================
clearGrid();
floor(100, 400);
for (let x = 250; x <= 260; x++)
  for (let y = FLOOR; y <= FLOOR + 3; y++) set(x, y, WATER);
rebuildNavgrid();
resetStockpile();
setStockpilePoint(180, FLOOR - 1);
addResource('wood', ROD_WOOD_COST);

// ── 1..6: assign, catch, deposit, water conserved, rod breaks ────────────────
{
  const s = createSurvivor(200, FLOOR - 1);
  const waterStart = countMat(WATER);
  check(assignRole(s, 'fisherman') === true, '1: assignRole(fisherman) === true');
  check(getStockpile().wood === 0, '1: rod craft debited the wood');
  check(s.tool !== null && s.tool.kind === 'rod', '1: survivor holds a rod');

  let tunneled = false;
  let firstDepositTick = -1;
  let brokeTick = -1;
  for (let i = 0; i < 40000; i++) {
    // Isolate the fishing loop from survival (the seek override is p5 tested).
    s.needs.thirst = NEED_MAX;
    s.needs.hunger = NEED_MAX;
    s.needs.warmth = NEED_MAX;
    updateSurvivor(s);
    if (bodyInSolid(s)) tunneled = true;
    if (firstDepositTick < 0 && getStockpile().food > 0) firstDepositTick = i;
    if (s.tool === null && s.role === 'none') {
      brokeTick = i;
      break;
    }
  }

  const food = getStockpile().food;
  console.log(
    `   firstDepositTick=${firstDepositTick} brokeTick=${brokeTick} food=${food} water ${waterStart}->${countMat(WATER)}`,
  );
  check(firstDepositTick > 0, '2: a catch was deposited at the stockpile');
  check(
    firstDepositTick >= FISH_TICKS,
    `4: first deposit no earlier than FISH_TICKS (${firstDepositTick} >= ${FISH_TICKS})`,
  );
  check(countMat(WATER) === waterStart, '3: water cell count UNCHANGED (renewable)');
  check(brokeTick > 0, '5: rod broke -> idle (role none, tool null)');
  // The breaking catch is still carried (deposited only on a later assignment),
  // so the stockpile holds durability-1 catches; the last one is in hand.
  check(
    food + s.carrying === WOOD_TOOL_DURABILITY * FOOD_PER_FISH,
    `5: total catches == rod durability (${food} banked + ${s.carrying} carried == ${WOOD_TOOL_DURABILITY * FOOD_PER_FISH})`,
  );
  check(!tunneled, '6: no-tunnel held for the whole run');
}

// ── 7: no water in range -> wander, no food, no crash ────────────────────────
clearGrid();
floor(100, 400);
rebuildNavgrid();
resetStockpile();
setStockpilePoint(180, FLOOR - 1);
addResource('wood', ROD_WOOD_COST);
{
  const s = createSurvivor(200, FLOOR - 1);
  check(assignRole(s, 'fisherman') === true, '7: assignable on a dry map (rod affordable)');
  for (let i = 0; i < 2000; i++) {
    s.needs.thirst = NEED_MAX;
    s.needs.hunger = NEED_MAX;
    s.needs.warmth = NEED_MAX;
    updateSurvivor(s);
  }
  check(getStockpile().food === 0 && s.carrying === 0, '7: no water -> no food conjured');
  check(s.role === 'fisherman' && s.tool !== null, '7: still equipped, idling (wander fallback)');
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(
  '\nSUMMARY: fisherman walks to the pond bank, catches on FISH_TICKS cadence, deposits food, never consumes water, rod breaks to idle, no-tunnel; dry map -> harmless wander. ALL PASS',
);
