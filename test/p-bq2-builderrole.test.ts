declare const process: any;
/**
 * p-bq2-builderrole.test.ts — BQ-2: builder role registration (GDD §6.2)
 *
 * Headless Node test (real modules, no mocks). Covers all Done-when checks.
 *
 * Done-when:
 *   1. ROLES.builder.requiredTool === 'hammer', workTicks === BUILD_TICKS, output === null.
 *   2. canAssign('builder', []) === false (no tool, no wood); after addResource('wood', HAMMER_WOOD_COST)
 *      canAssign === true; craftToolFor returns hammer at HAMMER_DURABILITY and debits wood;
 *      canAssign('builder', ['hammer']) === true with empty stockpile.
 *   3. makeTool('hammer').durability === HAMMER_DURABILITY; makeTool('axe').durability === WOOD_TOOL_DURABILITY.
 *   4. ROLE_TINT.builder is defined; findTarget('builder', x, y) === null.
 *   5. npm run build green (verified separately).
 */

import {
  ROLES,
  ROLE_TINT,
  makeTool,
  canAssign,
  craftToolFor,
  findTarget,
} from '../src/game/roles';
import {
  BUILD_TICKS,
  HAMMER_WOOD_COST,
  HAMMER_DURABILITY,
  WOOD_TOOL_DURABILITY,
} from '../src/config';
import { addResource, getStockpile, resetStockpile } from '../src/game/resources';

// ---------------------------------------------------------------------------
// Minimal assertion helpers
// ---------------------------------------------------------------------------
let totalFailed = 0;

function ok(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    totalFailed++;
  }
}

function label(title: string): void {
  console.log(`\n── ${title}`);
}

// ---------------------------------------------------------------------------
// A1 — ROLES.builder static definition
// ---------------------------------------------------------------------------
label('A1 ROLES.builder static definition');

ok(ROLES.builder !== undefined, 'ROLES.builder exists');
ok(ROLES.builder.requiredTool === 'hammer', `requiredTool === 'hammer' (got: ${ROLES.builder.requiredTool})`);
ok(ROLES.builder.workTicks === BUILD_TICKS, `workTicks === BUILD_TICKS (${BUILD_TICKS}) (got: ${ROLES.builder.workTicks})`);
ok(ROLES.builder.output === null, `output === null (got: ${ROLES.builder.output})`);
ok(ROLES.builder.harvestMaterial === null, `harvestMaterial === null (got: ${ROLES.builder.harvestMaterial})`);
ok(
  typeof ROLES.builder.craftCost === 'object' && (ROLES.builder.craftCost as Record<string,number>)['wood'] === HAMMER_WOOD_COST,
  `craftCost.wood === HAMMER_WOOD_COST (${HAMMER_WOOD_COST}) (got: ${JSON.stringify(ROLES.builder.craftCost)})`
);

// ---------------------------------------------------------------------------
// A2 — canAssign / craftToolFor (tool-gated assignment)
// ---------------------------------------------------------------------------
label('A2 canAssign / craftToolFor');

// Reset stockpile to a clean state
resetStockpile();

// Empty stockpile, no owned tool → false
ok(canAssign('builder', []) === false, 'canAssign("builder", []) === false with empty stockpile');

// Add exactly enough wood to craft a hammer
addResource('wood', HAMMER_WOOD_COST);
ok(getStockpile().wood === HAMMER_WOOD_COST, `stockpile has ${HAMMER_WOOD_COST} wood after addResource`);
ok(canAssign('builder', []) === true, 'canAssign("builder", []) === true after adding wood');

// craftToolFor → returns hammer, debits wood
const tool = craftToolFor('builder');
ok(tool !== null, 'craftToolFor("builder") returns non-null');
ok(tool?.kind === 'hammer', `craftToolFor returns kind='hammer' (got: ${tool?.kind})`);
ok(tool?.durability === HAMMER_DURABILITY, `craftToolFor returns durability=${HAMMER_DURABILITY} (got: ${tool?.durability})`);
ok(getStockpile().wood === 0, `wood stockpile debited to 0 after craft (got: ${getStockpile().wood})`);

// Already owns hammer → can assign even with empty stockpile
resetStockpile();
ok(canAssign('builder', ['hammer']) === true, 'canAssign("builder", ["hammer"]) === true with empty stockpile (already owns tool)');

// Still can't assign if no tool and empty stockpile (post-craft state)
ok(canAssign('builder', []) === false, 'canAssign("builder", []) === false again with empty stockpile + no owned tool');

// ---------------------------------------------------------------------------
// A3 — makeTool durability
// ---------------------------------------------------------------------------
label('A3 makeTool durability');

const hammer = makeTool('hammer');
ok(hammer.kind === 'hammer', `makeTool('hammer').kind === 'hammer'`);
ok(hammer.durability === HAMMER_DURABILITY, `makeTool('hammer').durability === HAMMER_DURABILITY (${HAMMER_DURABILITY}) (got: ${hammer.durability})`);

const axe = makeTool('axe');
ok(axe.durability === WOOD_TOOL_DURABILITY, `makeTool('axe').durability === WOOD_TOOL_DURABILITY (${WOOD_TOOL_DURABILITY}) (got: ${axe.durability})`);

const pickaxe = makeTool('pickaxe');
ok(pickaxe.durability === WOOD_TOOL_DURABILITY, `makeTool('pickaxe').durability === WOOD_TOOL_DURABILITY (${WOOD_TOOL_DURABILITY}) (got: ${pickaxe.durability})`);

// ---------------------------------------------------------------------------
// A4 — ROLE_TINT.builder + findTarget
// ---------------------------------------------------------------------------
label('A4 ROLE_TINT.builder and findTarget');

ok(ROLE_TINT.builder !== undefined, 'ROLE_TINT.builder is defined');
ok(
  Array.isArray(ROLE_TINT.builder) && ROLE_TINT.builder.length === 3,
  `ROLE_TINT.builder is an [r,g,b] tuple (got: ${JSON.stringify(ROLE_TINT.builder)})`
);
ok(
  ROLE_TINT.builder[0] === 205 && ROLE_TINT.builder[1] === 170 && ROLE_TINT.builder[2] === 95,
  `ROLE_TINT.builder === [205,170,95] (got: ${JSON.stringify(ROLE_TINT.builder)})`
);

const target = findTarget('builder', 100, 100);
ok(target === null, `findTarget('builder', 100, 100) === null (queue-driven, BQ-3) (got: ${JSON.stringify(target)})`);

// ---------------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------------
console.log('\n══════════════════════════════════════════════════════');
const allPass = totalFailed === 0;
console.log(allPass ? 'OVERALL: PASS' : `OVERALL: FAIL (${totalFailed} assertion(s) failed)`);
console.log('══════════════════════════════════════════════════════');
process.exit(allPass ? 0 : 1);
