/**
 * Headless verification for p6-t2 (global colony stockpile — GDD §8).
 * Run via tsc (commonjs) -> node.
 *
 * Done-when checks:
 *  1. addResource('wood',5) + canAfford({wood:3}) === true
 *  2. spend({wood:3}) returns true, leaves wood === 2
 *  3. spend({wood:99}) returns false, leaves wood === 2 (atomic)
 *  4. food/stone/ore unaffected by wood ops
 *  5. canAfford with multi-kind cost
 *  6. setStockpilePoint(100,50) -> stockpilePoint reflects {x:100, y:50}
 */
import {
  addResource,
  canAfford,
  spend,
  getStockpile,
  stockpilePoint,
  setStockpilePoint,
  resetStockpile,
} from '../src/game/resources';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Reset before each group so tests are independent
// ---------------------------------------------------------------------------
resetStockpile();
console.log('--- 1. addResource and canAfford ---');
addResource('wood', 5);
check(canAfford({ wood: 3 }) === true, 'canAfford({wood:3}) is true after adding 5');
check(canAfford({ wood: 5 }) === true, 'canAfford({wood:5}) is true (exact)');
check(canAfford({ wood: 6 }) === false, 'canAfford({wood:6}) is false (over budget)');

console.log('\n--- 2. spend succeeds, leaves correct remainder ---');
const spendResult = spend({ wood: 3 });
check(spendResult === true, 'spend({wood:3}) returns true');
check(getStockpile().wood === 2, `wood is 2 after spend (got ${getStockpile().wood})`);

console.log('\n--- 3. spend fails atomically, nothing deducted ---');
const spendFail = spend({ wood: 99 });
check(spendFail === false, 'spend({wood:99}) returns false (insufficient)');
check(getStockpile().wood === 2, `wood still 2 after failed spend (got ${getStockpile().wood})`);

console.log('\n--- 4. Other resources unaffected ---');
check(getStockpile().stone === 0, 'stone unaffected by wood ops');
check(getStockpile().food === 0, 'food unaffected by wood ops');
check(getStockpile().ore === 0, 'ore unaffected by wood ops');

// Adding one resource doesn't change others
addResource('stone', 7);
check(getStockpile().wood === 2, 'wood still 2 after adding stone');
check(getStockpile().stone === 7, 'stone is 7');

console.log('\n--- 5. Multi-kind canAfford and spend ---');
resetStockpile();
addResource('wood', 10);
addResource('stone', 5);
addResource('food', 3);
addResource('ore', 1);

check(canAfford({ wood: 2, stone: 1 }) === true, 'canAfford({wood:2,stone:1}) true');
check(canAfford({ wood: 2, stone: 6 }) === false, 'canAfford({wood:2,stone:6}) false (stone insufficient)');
check(canAfford({ wood: 2, stone: 1, food: 3, ore: 1 }) === true, 'canAfford all four kinds true');
check(canAfford({ wood: 2, stone: 1, food: 4 }) === false, 'canAfford multi-kind false if one over');

// Atomic: wood:2 stone:6 should fail without touching wood or stone
const beforeWood = getStockpile().wood;
const beforeStone = getStockpile().stone;
const atomicFail = spend({ wood: 2, stone: 6 });
check(atomicFail === false, 'spend({wood:2,stone:6}) returns false');
check(getStockpile().wood === beforeWood, `wood unchanged after failed multi-kind spend (${getStockpile().wood} === ${beforeWood})`);
check(getStockpile().stone === beforeStone, `stone unchanged after failed multi-kind spend (${getStockpile().stone} === ${beforeStone})`);

// Successful multi-kind spend
const multiSpend = spend({ wood: 2, stone: 1 });
check(multiSpend === true, 'spend({wood:2,stone:1}) returns true');
check(getStockpile().wood === 8, `wood is 8 after spend (got ${getStockpile().wood})`);
check(getStockpile().stone === 4, `stone is 4 after spend (got ${getStockpile().stone})`);

console.log('\n--- 6. stockpilePoint / setStockpilePoint ---');
check(stockpilePoint.x === 0 && stockpilePoint.y === 0, 'stockpilePoint starts at (0,0)');
setStockpilePoint(100, 50);
check(stockpilePoint.x === 100, `stockpilePoint.x === 100 (got ${stockpilePoint.x})`);
check(stockpilePoint.y === 50, `stockpilePoint.y === 50 (got ${stockpilePoint.y})`);

// Verify it's the same live object (not a copy)
setStockpilePoint(7, 13);
check(stockpilePoint.x === 7 && stockpilePoint.y === 13, 'stockpilePoint reflects subsequent setStockpilePoint calls');

// ---------------------------------------------------------------------------
console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
if (failures > 0) throw new Error(`${failures} failure(s)`);
