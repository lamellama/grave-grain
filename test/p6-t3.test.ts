/**
 * Headless verification for p6-t3 (roles, wood-tier tools & tool-gated
 * assignment — GDD §6.2, §6.3, §9). Run via tsc (commonjs) -> node.
 *
 * Done-when checks:
 *  1. makeTool('axe').durability === WOOD_TOOL_DURABILITY; useTool returns
 *     false until the LAST use (durability=5: false,false,false,false,true).
 *  2. Lumberjack is the wood BOOTSTRAP role (playtest v0.9 P): its axe is free
 *     (AXE_WOOD_COST=0) so it is assignable even at 0 wood. The wood gate is
 *     still enforced for costed tools: empty stockpile → canAssign('miner',[])
 *     ===false; after adding PICKAXE_WOOD_COST wood → true; craftToolFor
 *     deducts the wood; canAssign('miner',['pickaxe'])===true even when broke.
 *  3. findTarget over a seeded grid: lumberjack → TRUNK; forager → FOLIAGE; miner →
 *     EXPOSED stone (skips a fully-buried block, picks the one-exposed-face
 *     cell); guard → stockpilePoint.
 *  4. (build is verified separately via `npm run build`).
 */
import {
  makeTool,
  useTool,
  canAssign,
  craftToolFor,
  findTarget,
  mineOutput,
  ROLES,
} from '../src/game/roles';
import {
  addResource,
  getStockpile,
  resetStockpile,
  setStockpilePoint,
} from '../src/game/resources';
import { set, get } from '../src/engine/grid';
import { AIR, STONE, ORE, FOLIAGE, TRUNK } from '../src/engine/materials';
import {
  WOOD_TOOL_DURABILITY,
  PICKAXE_WOOD_COST,
  CHOP_TICKS,
  MINE_TICKS,
  GATHER_TICKS,
} from '../src/config';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
console.log('--- 1. Tool durability & break ---');
const axe = makeTool('axe');
check(axe.durability === WOOD_TOOL_DURABILITY, `fresh axe durability === ${WOOD_TOOL_DURABILITY} (got ${axe.durability})`);
const seq: boolean[] = [];
for (let i = 0; i < WOOD_TOOL_DURABILITY; i++) seq.push(useTool(axe));
console.log('  useTool sequence:', JSON.stringify(seq));
const brokeOnLast = seq[seq.length - 1] === true;
const noEarlyBreak = seq.slice(0, -1).every((b) => b === false);
check(noEarlyBreak, 'useTool returned false on every use before the last');
check(brokeOnLast, 'useTool returned true (broke) on the LAST use');
check(axe.durability <= 0, `axe durability <= 0 after breaking (got ${axe.durability})`);

// ---------------------------------------------------------------------------
console.log('\n--- 2. Tool-gated assignment & auto-craft ---');
resetStockpile();
// Playtest v0.9 P: the axe is free, so the lumberjack can ALWAYS be assigned -
// a colony at 0 wood bootstraps its wood economy through this role.
check(canAssign('lumberjack', []) === true, 'empty stockpile → lumberjack STILL assignable (free axe - wood bootstrap)');
const crafted = craftToolFor('lumberjack');
check(crafted !== null && crafted.kind === 'axe', 'craftToolFor(lumberjack) returns an axe');
check(crafted !== null && crafted.durability === WOOD_TOOL_DURABILITY, 'crafted axe is fresh (full durability)');
check(getStockpile().wood === 0, `free axe craft left wood at 0 (got ${getStockpile().wood})`);
// The wood gate still holds for COSTED tools (miner's pickaxe shown here).
check(canAssign('miner', []) === false, 'empty stockpile + no tools → miner NOT assignable (pickaxe costs wood)');
addResource('wood', PICKAXE_WOOD_COST);
check(canAssign('miner', []) === true, `after +${PICKAXE_WOOD_COST} wood → miner assignable (craftable)`);
const pick = craftToolFor('miner');
check(pick !== null && pick.kind === 'pickaxe', 'craftToolFor(miner) returns a pickaxe');
check(getStockpile().wood === 0, `craft deducted wood back to 0 (got ${getStockpile().wood})`);
check(canAssign('miner', []) === false, 'empty stockpile again → miner not assignable (no spare wood)');
check(canAssign('miner', ['pickaxe']) === true, 'already owns pickaxe → assignable even with empty stockpile');
check(canAssign('guard', []) === false, 'guard needs a weapon → not assignable when broke');
check(canAssign('none', []) === true, "role 'none' always assignable (no tool)");
// none → no tool crafted
check(craftToolFor('none') === null, "craftToolFor('none') returns null");

// ---------------------------------------------------------------------------
console.log('\n--- 3. findTarget over a seeded grid ---');
setStockpilePoint(500, 120);

// Seed a bush (FOLIAGE) and a tree TRUNK at known cells. Probe from a
// DIFFERENT point: the ring-scan starts at radius 1, so a target sitting
// exactly on the probe cell would be missed — survivors never harvest the
// cell they stand on anyway. The TRUNK sits FARTHER from the probe than the
// bush, proving the lumberjack skips bushes for trees.
const FX = 60;
const FY = 50;
set(FX, FY, FOLIAGE);
const TX = 70;
const TY = 50;
set(TX, TY, TRUNK);

// Solid 5x5 STONE block from (108,58)..(112,62), centre (110,60). The inner 3x3
// (109..111, 59..61) is FULLY BURIED — every orthogonal neighbour is stone, no
// AIR face. Only the 5x5 perimeter cells have an AIR face (are exposed).
for (let dy = -2; dy <= 2; dy++) {
  for (let dx = -2; dx <= 2; dx++) {
    set(110 + dx, 60 + dy, STONE);
  }
}
// A separate exposed ORE cell, isolated in AIR (every face is AIR → exposed).
set(180, 60, ORE);

// Lumberjack probes from (40,50): nearest TRUNK is the seeded (70,50) — the
// NEARER bush at (60,50) is not a tree and must be skipped.
const lumb = findTarget('lumberjack', 40, 50);
check(lumb !== null && lumb.x === TX && lumb.y === TY, `lumberjack → TRUNK at (${TX},${TY}), past the nearer bush (got ${JSON.stringify(lumb)})`);

const forg = findTarget('forager', 40, 50);
check(forg !== null && forg.x === FX && forg.y === FY, `forager → FOLIAGE at (${FX},${FY}) (got ${JSON.stringify(forg)})`);

// Miner probes from the BURIED centre (110,60): the closest stone cells (the
// fully-buried interior, chebyshev dist 0 & 1) have no AIR face and MUST be
// skipped; the nearest pick is on the exposed perimeter (chebyshev dist 2).
const mine = findTarget('miner', 110, 60);
check(mine !== null, `miner found a target (got ${JSON.stringify(mine)})`);
const inInterior =
  mine !== null && mine.x >= 109 && mine.x <= 111 && mine.y >= 59 && mine.y <= 61;
check(mine !== null && !inInterior, 'miner SKIPPED the fully-buried interior cells');
// Picked cell must itself be exposed: an orthogonal AIR neighbour exists.
const hasAirFace =
  mine !== null &&
  [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ].some(([dx, dy]) => get(mine.x + dx, mine.y + dy) === AIR);
check(hasAirFace, 'miner pick is genuinely EXPOSED (has an orthogonal AIR neighbour)');
// Nearest exposed rock to (110,60) is on the block perimeter (dist 2), NOT the
// far isolated ore at (180,60) (dist 70).
const onPerimeter =
  mine !== null && Math.max(Math.abs(mine.x - 110), Math.abs(mine.y - 60)) === 2;
check(onPerimeter, `miner picked nearest exposed face on the perimeter (got ${JSON.stringify(mine)})`);
check(mineOutput(STONE) === 'stone' && mineOutput(ORE) === 'ore' && mineOutput(AIR) === null, 'mineOutput maps STONE→stone, ORE→ore, AIR→null');

const guardT = findTarget('guard', 0, 0);
check(guardT !== null && guardT.x === 500 && guardT.y === 120, `guard → stockpilePoint (500,120) (got ${JSON.stringify(guardT)})`);

check(findTarget('none', 0, 0) === null, "findTarget('none') → null");

// Sanity on the role table wiring.
check(ROLES.lumberjack.workTicks === CHOP_TICKS, 'lumberjack workTicks === CHOP_TICKS');
check(ROLES.miner.workTicks === MINE_TICKS, 'miner workTicks === MINE_TICKS');
check(ROLES.forager.workTicks === GATHER_TICKS, 'forager workTicks === GATHER_TICKS');
check(ROLES.miner.harvestMaterial === null && ROLES.miner.output === null, 'miner harvestMaterial/output null (decided at harvest)');

// Clean up grid edits so we don't leak into other modules in the same process.
set(FX, FY, AIR);
for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(110 + dx, 60 + dy, AIR);
set(180, 60, AIR);

// ---------------------------------------------------------------------------
console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
if (failures > 0) throw new Error(`${failures} failure(s)`);
