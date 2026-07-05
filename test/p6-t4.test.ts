/**
 * Headless verification for p6-t4 — the survivor role loop (find → path → work →
 * deposit → repeat) layered on the Phase-5 needs/fire auto-override (GDD §6.2,
 * §6.3, §8, §9). Imports the REAL modules (no mocks); seeds terrain into
 * grid.material, builds the navgrid, then steps updateSurvivor. tsc → node.
 */
import {
  createSurvivor,
  updateSurvivor,
  assignRole,
} from '../src/characters/survivor';
import type { Survivor } from '../src/characters/survivor';
import { material, set, get } from '../src/engine/grid';
import {
  STONE,
  WATER,
  FOLIAGE,
  AIR,
  isSolidForBody,
} from '../src/engine/materials';
import { rebuildNavgrid } from '../src/engine/navgrid';
import {
  addResource,
  getStockpile,
  resetStockpile,
  setStockpilePoint,
} from '../src/game/resources';
import {
  WORLD_W,
  WORLD_H,
  NEED_MAX,
  AXE_WOOD_COST,
  PICKAXE_WOOD_COST,
  WOOD_PER_CHOP,
  STONE_PER_MINE,
  WOOD_TOOL_DURABILITY,
  TOOL_BREAKAGE,
  THIRST_THRESHOLD,
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
// Thick stone floor so a miner can dig a couple of cells without losing footing.
function floor(x0: number, x1: number, top = FLOOR): void {
  for (let x = x0; x <= x1; x++)
    for (let r = top; r < top + 20; r++) set(x, r, STONE);
}
function countMat(mat: number): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === mat) n++;
  return n;
}
// Does ANY non-destroyed body pixel currently sit in a cell solid to bodies?
// (no-tunnel guarantee: bodies pass through FOLIAGE, never through STONE.)
function bodyInSolid(s: Survivor): boolean {
  const b = s.body;
  for (const bone of b.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const wx = Math.round(b.x) + bone.offset.dx + p.dx;
      const wy = Math.round(b.y) + bone.offset.dy + p.dy;
      const m = material[wy * WORLD_W + wx];
      if (m === STONE && isSolidForBody(m)) return true;
    }
  }
  return false;
}

// ===========================================================================
// 1 + 2. LUMBERJACK: assign (auto-craft axe), chop a tree, deposit wood, repeat
//        until the axe breaks (durability).
// ===========================================================================
clearGrid();
floor(100, 400);
// A woodland cluster (plenty of FOLIAGE cells for >5 chops) at columns 250..262.
for (let x = 250; x <= 262; x++)
  for (let y = 146; y <= 149; y++) set(x, y, FOLIAGE);
rebuildNavgrid();
resetStockpile();
setStockpilePoint(180, 149);
addResource('wood', AXE_WOOD_COST);
{
  const s = createSurvivor(200, 149);
  const assigned = assignRole(s, 'lumberjack');
  check(assigned === true, '1: assignRole(lumberjack) === true');
  check(getStockpile().wood === 0, `1: craft spent the wood (wood → 0, got ${getStockpile().wood})`);
  check(s.tool !== null && s.tool.kind === 'axe', '1: survivor now holds an axe');

  const foliageStart = countMat(FOLIAGE);
  let ticksToFirstDeposit = -1;
  let tunneled = false;
  let chops = 0;
  let prevFoliage = foliageStart;
  let brokeAtChop = -1;
  let woodAtFirstDeposit = 0;

  for (let i = 0; i < 20000; i++) {
    // Keep needs topped up: this scenario isolates the chop/deposit/break loop,
    // not survival. (Threshold was raised to 50 in 11-6, so without water the
    // lumberjack would correctly divert to drink and die — covered by scenario 3.)
    s.needs.thirst = NEED_MAX;
    s.needs.hunger = NEED_MAX;
    updateSurvivor(s);
    if (bodyInSolid(s)) tunneled = true;
    const f = countMat(FOLIAGE);
    if (f < prevFoliage) {
      chops += prevFoliage - f; // a FOLIAGE cell was chopped → AIR this tick
      prevFoliage = f;
    }
    if (ticksToFirstDeposit < 0 && getStockpile().wood > 0) {
      ticksToFirstDeposit = i;
      woodAtFirstDeposit = getStockpile().wood;
    }
    // Detect the break: dropped back to idle.
    if (brokeAtChop < 0 && s.tool === null && s.role === 'none') {
      brokeAtChop = chops;
      break;
    }
  }

  console.log(
    `1: ticksToFirstDeposit=${ticksToFirstDeposit} woodAtFirstDeposit=${woodAtFirstDeposit} finalWood=${getStockpile().wood} chopsAtBreak=${brokeAtChop} tunneled=${tunneled}`,
  );
  check(ticksToFirstDeposit > 0, '1: survivor chopped & deposited (first deposit happened)');
  check(woodAtFirstDeposit === WOOD_PER_CHOP, `1: first deposit added WOOD_PER_CHOP (=${WOOD_PER_CHOP})`);
  check(s.body.alive, '1: survivor still alive');
  check(!tunneled, '1: NO body pixel ever entered a STONE cell (no-tunnel held)');
  // Tool breakage is disabled (config.TOOL_BREAKAGE === false, playtest request):
  // the axe never wears out, so the survivor keeps its tool + role and just keeps
  // chopping. (When re-enabled, it would instead break after WOOD_TOOL_DURABILITY
  // chops and drop to idle.)
  if (TOOL_BREAKAGE) {
    check(brokeAtChop === WOOD_TOOL_DURABILITY, `2: axe broke after WOOD_TOOL_DURABILITY (=${WOOD_TOOL_DURABILITY}) chops`);
    check(s.tool === null && s.role === 'none', '2: tool null & role none after break (idle)');
  } else {
    check(brokeAtChop === -1, '2: axe NEVER broke (breakage disabled)');
    check(
      s.tool !== null && s.tool.kind === 'axe' && s.role === 'lumberjack',
      '2: survivor keeps axe + lumberjack role (breakage disabled)',
    );
    check(chops > WOOD_TOOL_DURABILITY, `2: chopped past the old break point (${chops} > ${WOOD_TOOL_DURABILITY})`);
  }
}

// ===========================================================================
// 3. OVERRIDE PRECEDENCE: mid-role-loop force thirst below threshold → diverts
//    to seekWater (drinks), then RESUMES the role loop and deposits again.
// ===========================================================================
clearGrid();
floor(100, 400);
for (let x = 250; x <= 262; x++)
  for (let y = 146; y <= 149; y++) set(x, y, FOLIAGE);
// A small pool to the LEFT of spawn so the diversion is a clear detour.
for (let x = 120; x <= 124; x++) for (let y = 146; y <= 149; y++) set(x, y, WATER);
rebuildNavgrid();
resetStockpile();
setStockpilePoint(180, 149);
addResource('wood', AXE_WOOD_COST);
{
  const s = createSurvivor(200, 149);
  check(assignRole(s, 'lumberjack') === true, '3: assignRole(lumberjack) === true');

  // Run until the first deposit so we're mid-loop with a working role.
  let firstDeposit = -1;
  for (let i = 0; i < 20000 && firstDeposit < 0; i++) {
    updateSurvivor(s);
    if (getStockpile().wood > 0) firstDeposit = i;
  }
  check(firstDeposit > 0, '3: role loop deposited once before the override');

  // Force severe thirst → must auto-override to seekWater.
  s.needs.thirst = THIRST_THRESHOLD - 10;
  const woodBeforeThirst = getStockpile().wood;
  const thirstBefore = s.needs.thirst;
  let sawSeekWater = false;
  let thirstPeak = thirstBefore;
  let depositedAfterDrink = false;
  let drank = false;

  for (let i = 0; i < 20000 && s.body.alive; i++) {
    updateSurvivor(s);
    if (s.behaviour === 'seekWater' || s.behaviour === 'consuming') sawSeekWater = true;
    thirstPeak = Math.max(thirstPeak, s.needs.thirst);
    if (!drank && thirstPeak >= NEED_MAX - 5) drank = true;
    // After drinking, a fresh deposit proves the role loop resumed.
    if (drank && getStockpile().wood > woodBeforeThirst) {
      depositedAfterDrink = true;
      break;
    }
  }

  console.log(
    `3: thirst ${thirstBefore} → peak ${thirstPeak.toFixed(1)} | sawSeekWater=${sawSeekWater} drank=${drank} depositedAfterDrink=${depositedAfterDrink} wood ${woodBeforeThirst}→${getStockpile().wood}`,
  );
  check(sawSeekWater, '3: thirst override preempted the role loop (seekWater fired)');
  check(drank, '3: survivor reached water and drank (thirst restored)');
  check(depositedAfterDrink, '3: role loop RESUMED after drinking (deposited again)');
  check(s.body.alive, '3: survivor survived the detour');
}

// ===========================================================================
// 4. MINER: assign (auto-craft pickaxe), mine exposed STONE → stockpile.stone.
// ===========================================================================
clearGrid();
floor(100, 400);
rebuildNavgrid();
resetStockpile();
setStockpilePoint(180, 149);
addResource('wood', PICKAXE_WOOD_COST);
{
  const s = createSurvivor(200, 149);
  check(assignRole(s, 'miner') === true, '4: assignRole(miner) === true');
  check(s.tool !== null && s.tool.kind === 'pickaxe', '4: survivor holds a pickaxe');

  const stoneStart = countMat(STONE);
  let tunneled = false;
  let firstMineDeposit = -1;
  for (let i = 0; i < 20000 && firstMineDeposit < 0; i++) {
    updateSurvivor(s);
    if (bodyInSolid(s)) tunneled = true;
    if (getStockpile().stone > 0) firstMineDeposit = i;
  }
  const stoneEnd = countMat(STONE);
  console.log(
    `4: ticksToFirstStone=${firstMineDeposit} stockpile.stone=${getStockpile().stone} stoneCells ${stoneStart}→${stoneEnd} tunneled=${tunneled}`,
  );
  check(firstMineDeposit > 0, '4: miner mined & deposited stone');
  check(getStockpile().stone >= STONE_PER_MINE, `4: stockpile.stone rose (≥ STONE_PER_MINE=${STONE_PER_MINE})`);
  check(stoneEnd < stoneStart, '4: at least one STONE cell became AIR (mined out)');
  check(!tunneled, '4: no-tunnel held during mining');
  check(s.body.alive, '4: miner still alive');
}

void WORLD_H;
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
if (failures > 0) throw new Error(`${failures} failure(s)`);
