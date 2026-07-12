declare const process: any;
/**
 * ir-irontier.test.ts — Beyond item 5: IRON tool tier (GDD §6.3, §6.2 upgrade
 * path, §14). Headless over the REAL modules.
 *
 * Done-when:
 *   1. makeTool tiers: iron durability = wood durability x IRON_DURABILITY_MULT
 *      for every upgradable kind; IRON_UPGRADABLE excludes basket + rod.
 *   2. craftToolFor NEVER crafts iron (fresh crafts stay cheap/predictable) —
 *      even with plenty of ore banked, and the free axe stays free.
 *   3. Upgrade path (GDD §6.2 "roles can be upgraded once iron is available"):
 *      RE-assigning the same role while holding the matching WOOD tool and
 *      affording {IRON_TOOL_WOOD_COST wood, IRON_TOOL_ORE_COST ore} swaps it
 *      for a fresh IRON tool and debits the stockpile. Already-iron -> no
 *      second spend; broke colony -> stays wood, nothing spent.
 *   4. Non-upgradable roles (forager basket, fisherman rod) never go iron.
 *   5. Iron works faster: the work timer arms at round(base x
 *      IRON_WORK_TICKS_MULT) for a harvest role AND the digger.
 *   6. Iron fights harder: an iron-armed guard's strike arms attackCooldown at
 *      round(ARROW_COOLDOWN x IRON_ATTACK_COOLDOWN_MULT); wood arms the full
 *      ARROW_COOLDOWN (guards are ARCHERS since round 11 - the bow's cadence).
 */

import {
  createSurvivor,
  updateSurvivor,
  assignRole,
} from '../src/characters/survivor';
import { createZombie } from '../src/characters/zombie';
import { material, set } from '../src/engine/grid';
import { STONE, DIRT, TRUNK, AIR } from '../src/engine/materials';
import { rebuildNavgrid } from '../src/engine/navgrid';
import {
  addResource,
  getStockpile,
  resetStockpile,
  setStockpilePoint,
} from '../src/game/resources';
import { makeTool, craftToolFor, IRON_UPGRADABLE } from '../src/game/roles';
import type { ToolKind } from '../src/game/roles';
import {
  NEED_MAX,
  WOOD_TOOL_DURABILITY,
  SHOVEL_DURABILITY,
  HAMMER_DURABILITY,
  IRON_DURABILITY_MULT,
  IRON_TOOL_ORE_COST,
  IRON_TOOL_WOOD_COST,
  IRON_WORK_TICKS_MULT,
  IRON_ATTACK_COOLDOWN_MULT,
  CHOP_TICKS,
  DIG_TICKS,
  ARROW_COOLDOWN,
  AXE_WOOD_COST,
  BASKET_WOOD_COST,
} from '../src/config';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
function clearGrid(): void {
  material.fill(AIR);
}
const FLOOR = 150;
function floor(x0: number, x1: number, mat = STONE): void {
  for (let x = x0; x <= x1; x++)
    for (let r = FLOOR; r < FLOOR + 20; r++) set(x, r, mat);
}

// ── 1. Tiered durabilities + upgradable set ──────────────────────────────────
console.log('1. tiers & durabilities');
check(makeTool('axe').tier === 'wood', 'default tier is wood');
check(
  makeTool('axe', 'iron').durability === WOOD_TOOL_DURABILITY * IRON_DURABILITY_MULT,
  'iron axe durability = wood x mult',
);
check(
  makeTool('shovel', 'iron').durability === SHOVEL_DURABILITY * IRON_DURABILITY_MULT,
  'iron shovel scales the shovel base',
);
check(
  makeTool('hammer', 'iron').durability === HAMMER_DURABILITY * IRON_DURABILITY_MULT,
  'iron hammer scales the hammer base',
);
check(
  (['pickaxe', 'axe', 'shovel', 'weapon', 'hammer'] as ToolKind[]).every(k =>
    IRON_UPGRADABLE.includes(k),
  ),
  'all five metal kinds are iron-upgradable',
);
check(
  !IRON_UPGRADABLE.includes('basket') && !IRON_UPGRADABLE.includes('rod'),
  'basket + rod are wood-only (no iron basket)',
);

// ── 2. Fresh crafts stay wood, never spend ore ───────────────────────────────
console.log('2. fresh crafts are always wood');
resetStockpile();
addResource('wood', 10);
addResource('ore', 10);
const fresh = craftToolFor('miner');
check(fresh !== null && fresh.tier === 'wood', 'craftToolFor(miner) -> wood pickaxe');
check(getStockpile().ore === 10, 'no ore spent on a fresh craft');
const freshAxe = craftToolFor('lumberjack');
check(
  freshAxe !== null && freshAxe.tier === 'wood' && AXE_WOOD_COST === 0,
  'free bootstrap axe stays free and wood',
);

// ── 3. Upgrade path via re-assign ────────────────────────────────────────────
console.log('3. re-assign upgrades wood -> iron');
clearGrid();
floor(100, 300);
rebuildNavgrid();
resetStockpile();
setStockpilePoint(180, FLOOR - 1);
{
  const s = createSurvivor(200, FLOOR - 1);
  check(assignRole(s, 'lumberjack') === true, '3: fresh assign (free wood axe)');
  check(s.tool !== null && s.tool.tier === 'wood', '3: holds a wood axe');

  // Broke colony: re-assign changes nothing, spends nothing.
  check(assignRole(s, 'lumberjack') === true, '3: re-assign while broke succeeds');
  check(s.tool !== null && s.tool.tier === 'wood', '3: still wood (no ore)');

  // Banked ore: re-assign upgrades and debits.
  addResource('wood', IRON_TOOL_WOOD_COST);
  addResource('ore', IRON_TOOL_ORE_COST);
  check(assignRole(s, 'lumberjack') === true, '3: re-assign with ore succeeds');
  check(s.tool !== null && s.tool.tier === 'iron', '3: axe upgraded to IRON');
  check(
    s.tool !== null &&
      s.tool.durability === WOOD_TOOL_DURABILITY * IRON_DURABILITY_MULT,
    '3: fresh iron durability',
  );
  check(
    getStockpile().ore === 0 && getStockpile().wood === 0,
    '3: upgrade debited the ore + wood',
  );

  // Already iron: re-assign never double-spends.
  addResource('wood', IRON_TOOL_WOOD_COST);
  addResource('ore', IRON_TOOL_ORE_COST);
  check(assignRole(s, 'lumberjack') === true, '3: re-assign when already iron');
  check(
    getStockpile().ore === IRON_TOOL_ORE_COST,
    '3: no second spend on an iron tool',
  );
}

// ── 4. Non-upgradable roles stay wood ────────────────────────────────────────
console.log('4. basket/rod never go iron');
resetStockpile();
addResource('wood', BASKET_WOOD_COST + IRON_TOOL_WOOD_COST);
addResource('ore', IRON_TOOL_ORE_COST);
{
  const s = createSurvivor(200, FLOOR - 1);
  assignRole(s, 'forager');
  assignRole(s, 'forager'); // re-assign with ore banked
  check(s.tool !== null && s.tool.tier === 'wood', '4: basket stays wood');
  check(getStockpile().ore === IRON_TOOL_ORE_COST, '4: no ore spent');
}

// ── 5. Iron works faster (harvest + dig timers) ──────────────────────────────
console.log('5. work timers scale');
clearGrid();
floor(100, 400);
// Trees (TRUNK columns) - the lumberjack fells trees now, never bare foliage.
for (let x = 250; x <= 262; x += 2)
  for (let y = FLOOR - 4; y <= FLOOR - 1; y++) set(x, y, TRUNK);
rebuildNavgrid();
resetStockpile();
setStockpilePoint(180, FLOOR - 1);
{
  // Iron lumberjack: capture workTicksLeft on the tick 'working' first arms.
  const s = createSurvivor(240, FLOOR - 1);
  assignRole(s, 'lumberjack');
  s.tool = makeTool('axe', 'iron');
  let armed = -1;
  for (let i = 0; i < 3000 && armed < 0; i++) {
    s.needs.thirst = NEED_MAX;
    s.needs.hunger = NEED_MAX;
    s.needs.warmth = NEED_MAX;
    const wasWorking = s.roleState === 'working';
    updateSurvivor(s);
    if (!wasWorking && s.roleState === 'working') armed = s.workTicksLeft;
  }
  check(
    armed === Math.round(CHOP_TICKS * IRON_WORK_TICKS_MULT),
    `5: iron chop timer arms at ${Math.round(CHOP_TICKS * IRON_WORK_TICKS_MULT)} (got ${armed})`,
  );
}
clearGrid();
floor(100, 400, DIRT);
rebuildNavgrid();
resetStockpile();
setStockpilePoint(180, FLOOR - 1);
{
  // Iron digger: the carve timer arms at the halved DIG_TICKS.
  const s = createSurvivor(200, FLOOR - 1);
  s.body.facing = 1;
  addResource('wood', 2);
  assignRole(s, 'diggerDown');
  s.tool = makeTool('shovel', 'iron');
  let maxArmed = -1;
  for (let i = 0; i < 500; i++) {
    s.needs.thirst = NEED_MAX;
    s.needs.hunger = NEED_MAX;
    s.needs.warmth = NEED_MAX;
    updateSurvivor(s);
    if (s.workTicksLeft > maxArmed) maxArmed = s.workTicksLeft;
  }
  check(
    maxArmed === Math.round(DIG_TICKS * IRON_WORK_TICKS_MULT),
    `5: iron dig timer arms at ${Math.round(DIG_TICKS * IRON_WORK_TICKS_MULT)} (got ${maxArmed})`,
  );
}

// ── 6. Iron guard strikes on a shorter cooldown ──────────────────────────────
console.log('6. guard cadence');
clearGrid();
floor(100, 400);
rebuildNavgrid();
resetStockpile();
setStockpilePoint(180, FLOOR - 1);
function guardCooldownWith(tier: 'wood' | 'iron'): number {
  resetStockpile();
  addResource('wood', 2);
  const s = createSurvivor(200, FLOOR - 1);
  assignRole(s, 'guard');
  s.tool = makeTool('weapon', tier);
  const z = createZombie(203, FLOOR - 1); // adjacent - within reach
  s.needs.thirst = NEED_MAX;
  s.needs.hunger = NEED_MAX;
  s.needs.warmth = NEED_MAX;
  updateSurvivor(s, [z]); // first tick: cooldown 0 -> strike -> re-arm
  return s.attackCooldown;
}
check(
  guardCooldownWith('wood') === ARROW_COOLDOWN,
  '6: wood bow re-arms at full ARROW_COOLDOWN',
);
check(
  guardCooldownWith('iron') ===
    Math.max(1, Math.round(ARROW_COOLDOWN * IRON_ATTACK_COOLDOWN_MULT)),
  '6: iron bow re-arms at the reduced cooldown',
);

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(
  '\nSUMMARY: iron tier - durable (x' +
    IRON_DURABILITY_MULT +
    '), player-triggered upgrade via re-assign (ore+wood debit, never silent, never on fresh crafts, never for basket/rod), halved work timers for harvest+dig, halved guard strike cooldown. ALL PASS',
);
