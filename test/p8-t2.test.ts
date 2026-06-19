/**
 * p8-t2 — Place-from-stockpile (GDD §8, §15-Q4).
 *
 * Verifies (real modules, no mocks): atomic spend + grid write + navgrid edit,
 * in the correctness-critical order. Scarcity exhaustion, atomic failed-wall
 * (no spend), successful wall with epoch bump, canPlace affordability, OOB.
 */
import {
  placeStructure,
  canPlace,
  structureCost,
  STRUCTURES,
} from '../src/game/building';
import {
  getStockpile,
  resetStockpile,
  addResource,
} from '../src/game/resources';
import { get, getIntegrity } from '../src/engine/grid';
import { WOOD, WALL } from '../src/engine/materials';
import { coarseOf, epochAt } from '../src/engine/navgrid';
import { WOOD_INTEGRITY, WALL_INTEGRITY } from '../src/config';

declare const process: any;

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log('  PASS:', msg);
  } else {
    console.error('  FAIL:', msg);
    failed++;
  }
}

// --- Done-when 1: scarcity exhaustion (fence draws wood to 0, then fails) ---
resetStockpile();
addResource('wood', 2);
assert(getStockpile().wood === 2, 'setup: wood === 2, stone === 0');
assert(getStockpile().stone === 0, 'setup: stone === 0');

const f1 = placeStructure(10, 10, 'fence');
const f2 = placeStructure(11, 10, 'fence');
assert(f1 === true && f2 === true, 'first two fences return true');
assert(getStockpile().wood === 0, 'wood drawn down to 0 after two fences');

const f3 = placeStructure(12, 10, 'fence');
assert(f3 === false, 'third fence returns false (stockpile exhausted)');
assert(get(12, 10) !== WOOD, 'no cell placed when unaffordable');

assert(get(10, 10) === WOOD && get(11, 10) === WOOD, 'placed cells are WOOD');
assert(
  getIntegrity(10, 10) === WOOD_INTEGRITY && getIntegrity(11, 10) === WOOD_INTEGRITY,
  `fence cells have full WOOD integrity (${WOOD_INTEGRITY})`,
);

// --- Done-when 2: atomic failed wall — no spend, wood unchanged ---
const woodBefore = getStockpile().wood; // 0
const stoneBefore = getStockpile().stone; // 0
const wFail = placeStructure(20, 20, 'wall');
assert(wFail === false, 'wall with stone:0 returns false');
assert(getStockpile().wood === woodBefore, 'failed wall spends no wood (atomic)');
assert(getStockpile().stone === stoneBefore, 'failed wall spends no stone (atomic)');
assert(get(20, 20) !== WALL, 'failed wall placed no cell');

// --- Done-when 4 (part): canPlace reflects affordability ---
assert(canPlace('wall') === false, 'canPlace(wall) === false with no stone');

// --- Done-when 3: successful wall + integrity + navgrid epoch bump ---
addResource('stone', 1);
assert(canPlace('wall') === true, 'canPlace(wall) === true after adding stone');

const wc = coarseOf(20, 20);
const epochBefore = epochAt(wc.cx, wc.cy);
const wOk = placeStructure(20, 20, 'wall');
assert(wOk === true, 'wall placed returns true with stone available');
assert(get(20, 20) === WALL, 'cell === WALL');
assert(getIntegrity(20, 20) === WALL_INTEGRITY, `wall integrity === WALL_INTEGRITY (${WALL_INTEGRITY})`);
assert(getStockpile().stone === 0, 'stone drawn down to 0 after wall');
const epochAfter = epochAt(wc.cx, wc.cy);
assert(epochAfter > epochBefore, `navgrid epoch bumped (markTerrainEdit fired): ${epochBefore} -> ${epochAfter}`);

// --- No-op repaint guard: placing same material again does not charge ---
addResource('stone', 1);
const repaint = placeStructure(20, 20, 'wall');
assert(repaint === false, 'repaint of identical WALL cell returns false');
assert(getStockpile().stone === 1, 'repaint charged nothing (stone unchanged)');

// --- Done-when 5: out of bounds → false, no spend ---
addResource('wood', 5);
const woodPreOob = getStockpile().wood;
const oob = placeStructure(-1, 5, 'fence');
assert(oob === false, 'out-of-bounds placeStructure returns false');
assert(getStockpile().wood === woodPreOob, 'out-of-bounds spends nothing');

// --- structureCost / STRUCTURES sanity ---
assert(structureCost('fence').wood === 1, 'structureCost(fence) === {wood:1}');
assert(structureCost('wall').stone === 1, 'structureCost(wall) === {stone:1}');
assert(STRUCTURES.fence.material === WOOD && STRUCTURES.wall.material === WALL, 'STRUCTURES map to WOOD/WALL');

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
