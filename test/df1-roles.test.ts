declare const process: any;
/**
 * df1-roles.test.ts — DF-1: digger/fisherman role registration (GDD §6.2,
 * §14 Beyond item 4).
 *
 * Headless Node test (real modules, no mocks).
 *
 * Done-when:
 *   1. ROLES.diggerDown/.diggerUp require 'shovel', workTicks === DIG_TICKS,
 *      output === null; ROLES.fisherman requires 'rod', workTicks === FISH_TICKS,
 *      output === 'food', harvestMaterial === WATER.
 *   2. canAssign gating: false broke, true after adding SHOVEL/ROD_WOOD_COST wood;
 *      craftToolFor debits the stockpile and returns the right tool; owning the
 *      tool bypasses the cost.
 *   3. makeTool('shovel').durability === SHOVEL_DURABILITY;
 *      makeTool('rod').durability === WOOD_TOOL_DURABILITY.
 *   4. ROLE_TINT has distinct swatches for all three new roles (vs every other
 *      role — l-role-legend invariant) and roleTintCss matches.
 *   5. findTarget: fisherman → nearest WATER; diggers → null.
 */

import {
  ROLES,
  ROLE_TINT,
  roleTintCss,
  makeTool,
  canAssign,
  craftToolFor,
  findTarget,
  type RoleName,
} from '../src/game/roles';
import {
  DIG_TICKS,
  FISH_TICKS,
  SHOVEL_WOOD_COST,
  SHOVEL_DURABILITY,
  ROD_WOOD_COST,
  WOOD_TOOL_DURABILITY,
} from '../src/config';
import { addResource, getStockpile, resetStockpile } from '../src/game/resources';
import { set } from '../src/engine/grid';
import { WATER } from '../src/engine/materials';

let totalFailed = 0;
function ok(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    totalFailed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

// ── 1. Role table entries ────────────────────────────────────────────────────
console.log('1. ROLES table registration');
ok(ROLES.diggerDown.requiredTool === 'shovel', 'diggerDown requires shovel');
ok(ROLES.diggerUp.requiredTool === 'shovel', 'diggerUp requires shovel');
ok(ROLES.diggerDown.workTicks === DIG_TICKS, 'diggerDown workTicks === DIG_TICKS');
ok(ROLES.diggerUp.workTicks === DIG_TICKS, 'diggerUp workTicks === DIG_TICKS');
ok(ROLES.diggerDown.output === null && ROLES.diggerUp.output === null,
  'diggers have no stockpile output (access, not resources)');
ok(ROLES.fisherman.requiredTool === 'rod', 'fisherman requires rod');
ok(ROLES.fisherman.workTicks === FISH_TICKS, 'fisherman workTicks === FISH_TICKS');
ok(ROLES.fisherman.output === 'food', 'fisherman outputs food');
ok(ROLES.fisherman.harvestMaterial === WATER, 'fisherman harvestMaterial === WATER');

// ── 2. Tool gating + craft ───────────────────────────────────────────────────
console.log('2. canAssign gating + craftToolFor');
resetStockpile();
ok(!canAssign('diggerDown', []), 'diggerDown not assignable broke with no tool');
ok(!canAssign('fisherman', []), 'fisherman not assignable broke with no tool');
addResource('wood', SHOVEL_WOOD_COST);
ok(canAssign('diggerDown', []), 'diggerDown assignable once shovel affordable');
ok(canAssign('diggerUp', []), 'diggerUp shares the shovel gate');
const shovel = craftToolFor('diggerDown');
ok(shovel !== null && shovel.kind === 'shovel', 'craftToolFor(diggerDown) yields a shovel');
ok(shovel !== null && shovel.durability === SHOVEL_DURABILITY,
  'crafted shovel at SHOVEL_DURABILITY');
ok(getStockpile().wood === 0, 'shovel craft debited the stockpile');
ok(canAssign('diggerUp', ['shovel']), 'owning a shovel bypasses the cost');
addResource('wood', ROD_WOOD_COST);
const rod = craftToolFor('fisherman');
ok(rod !== null && rod.kind === 'rod', 'craftToolFor(fisherman) yields a rod');
ok(getStockpile().wood === 0, 'rod craft debited the stockpile');
ok(canAssign('fisherman', ['rod']), 'owning a rod bypasses the cost');

// ── 3. Durabilities ──────────────────────────────────────────────────────────
console.log('3. makeTool durabilities');
ok(makeTool('shovel').durability === SHOVEL_DURABILITY,
  'shovel gets its own (long-tunnel) durability');
ok(makeTool('rod').durability === WOOD_TOOL_DURABILITY,
  'rod is a standard brittle wood tool');

// ── 4. Tints distinct + css swatches ─────────────────────────────────────────
console.log('4. ROLE_TINT swatches');
const allRoles = Object.keys(ROLE_TINT) as RoleName[];
const working = allRoles.filter(r => r !== 'none');
let distinct = true;
for (let i = 0; i < working.length; i++) {
  for (let j = i + 1; j < working.length; j++) {
    const a = ROLE_TINT[working[i]];
    const b = ROLE_TINT[working[j]];
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) {
      distinct = false;
      console.error(`    duplicate tint: ${working[i]} == ${working[j]}`);
    }
  }
}
ok(distinct, 'every working-role tint is pairwise distinct (incl. the 3 new)');
for (const r of ['diggerDown', 'diggerUp', 'fisherman'] as RoleName[]) {
  const t = ROLE_TINT[r];
  ok(roleTintCss(r) === `rgb(${t[0]},${t[1]},${t[2]})`, `${r} css swatch matches tint`);
}

// ── 5. findTarget ────────────────────────────────────────────────────────────
console.log('5. findTarget');
set(60, 40, WATER); // module grid starts all-AIR; one pond cell
const ft = findTarget('fisherman', 50, 40);
ok(ft !== null && ft.x === 60 && ft.y === 40, 'fisherman findTarget -> nearest WATER');
ok(findTarget('diggerDown', 50, 40) === null, 'diggerDown findTarget -> null (self-driven)');
ok(findTarget('diggerUp', 50, 40) === null, 'diggerUp findTarget -> null (self-driven)');

if (totalFailed > 0) {
  console.error(`\nFAILED: ${totalFailed} assertion(s)`);
  process.exit(1);
}
console.log(
  '\nSUMMARY: digger/fisherman roles registered (shovel/rod tools, gating, durabilities, distinct tints, fisherman targets water, diggers self-driven). ALL PASS',
);
