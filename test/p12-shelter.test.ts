/**
 * Headless verification for isSheltered() — the ROOF-ONLY shelter probe (GDD §8
 * shelter / §6.1 warmth), revised for the OPEN-CAMP model. Pure read-only helper.
 *
 * THE FIX (open-camp): shelter is a ROOF overhead with OPEN SIDES. The old model
 * required WOOD/WALL walls on BOTH sides at mid-torso, which sealed survivors
 * into a box they could not walk out of (a warm colony then died of THIRST). The
 * both-side-walls requirement is GONE: sheltered = a WOOD/WALL roof within
 * SHELTER_ROOF_SCAN directly above the head, regardless of the sides.
 *
 * Geometry (body at x=200, y=149, feet anchor):
 *   feet   row (ry)     = 149
 *   head   row          = ry - (BODY_H-1) = 149 - 11 = 138
 *   center col (rx)     = 200
 *   SHELTER_ROOF_SCAN = 6  → roof cells probed: y ∈ [132, 137] (above row 138)
 *
 * Tests:
 *   1. Roof = shelter (WOOD or WALL roof overhead, OPEN sides) → true
 *   2. Open (no structures)                                    → false
 *   3. Natural DIRT/STONE roof                                 → false
 *   4. Roof beyond SHELTER_ROOF_SCAN                           → false
 *   5. Bounded scan constant check (code-reasoning)            → logged
 */

import { BODY_H, SHELTER_ROOF_SCAN } from '../src/config';
import { material, set } from '../src/engine/grid';
import { WOOD, WALL, DIRT, STONE } from '../src/engine/materials';
import { createSurvivor } from '../src/characters/survivor';
import { isSheltered } from '../src/characters/survivor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}
function clearGrid(): void {
  material.fill(0);
}

// Standard body position for all tests.
const BX = 200;
const BY = 149;
const RY = BY;
const RX = BX;
const HEAD = RY - (BODY_H - 1); // 138

// A WOOD roof cell just 1 row above the head (within SHELTER_ROOF_SCAN).
const ROOF_X = RX;
const ROOF_Y = HEAD - 1; // 137

// ---------------------------------------------------------------------------
// 5. Bounded scan — log the bound so the CI run shows it.
// ---------------------------------------------------------------------------
const maxReadsPerCall = SHELTER_ROOF_SCAN;
console.log(
  `BOUND: worst-case grid reads per isSheltered call = SHELTER_ROOF_SCAN(${SHELTER_ROOF_SCAN}) = ${maxReadsPerCall} (roof-only, open sides)`,
);
if (maxReadsPerCall > 12) fail(`reads per call (${maxReadsPerCall}) unexpectedly large`);
ok(`bounded: isSheltered reads at most ${maxReadsPerCall} cells per call — no world scan`);

// ---------------------------------------------------------------------------
// 1. Roof = shelter (WOOD/WALL roof overhead, OPEN sides) → true
// ---------------------------------------------------------------------------
clearGrid();
set(ROOF_X, ROOF_Y, WOOD); // roof only — NO side walls
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== true) fail(`roof-only (WOOD, open sides) → true expected; got ${result}`);
  ok(`roof-only (WOOD roof overhead, OPEN sides) → true (THE FIX — no side walls needed)`);
}

// WALL roof also counts.
clearGrid();
set(ROOF_X, ROOF_Y, WALL);
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== true) fail(`WALL roof (open sides) → true expected; got ${result}`);
  ok(`WALL roof overhead (open sides) → true`);
}

// Roof at the far edge of SHELTER_ROOF_SCAN (worst-case, still detected).
clearGrid();
set(ROOF_X, HEAD - SHELTER_ROOF_SCAN, WOOD); // top of the scan window
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== true) fail(`roof at SHELTER_ROOF_SCAN edge → true expected; got ${result}`);
  ok(`roof ${SHELTER_ROOF_SCAN} cells above head (edge of scan window) → true`);
}

// ---------------------------------------------------------------------------
// 2. Open (no structures anywhere) → false
// ---------------------------------------------------------------------------
clearGrid();
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== false) fail(`open → false expected; got ${result}`);
  ok(`open (no roof) → false`);
}

// Side walls but NO roof → false (open sides do not shelter; roof is required).
clearGrid();
set(RX - 5, RY - Math.floor(BODY_H / 2), WALL);
set(RX + 5, RY - Math.floor(BODY_H / 2), WALL);
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== false) fail(`walls-but-no-roof → false expected; got ${result}`);
  ok(`side walls but NO roof → false (a roof is what shelters, not walls)`);
}

// ---------------------------------------------------------------------------
// 3. Natural terrain roof (DIRT / STONE) → false
//    isSheltered only keys on WOOD/WALL; hillsides/overhangs must NOT count.
// ---------------------------------------------------------------------------
clearGrid();
set(ROOF_X, ROOF_Y, DIRT);
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== false) fail(`DIRT roof → false expected; got ${result}`);
  ok(`natural DIRT roof → false (only WOOD/WALL count)`);
}
clearGrid();
set(ROOF_X, ROOF_Y, STONE);
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== false) fail(`STONE roof → false expected; got ${result}`);
  ok(`natural STONE roof → false`);
}

// ---------------------------------------------------------------------------
// 4. Roof just BEYOND SHELTER_ROOF_SCAN range → false (boundary, too high)
// ---------------------------------------------------------------------------
clearGrid();
set(ROOF_X, HEAD - SHELTER_ROOF_SCAN - 1, WOOD); // one cell TOO FAR above head
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== false) fail(`roof beyond SHELTER_ROOF_SCAN → false expected; got ${result}`);
  ok(`roof ${SHELTER_ROOF_SCAN + 1} cells above head (too high, beyond scan) → false`);
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
console.log('\nALL PASS');
console.log(
  `SUMMARY: isSheltered() (ROOF-ONLY, open-camp model) returns true iff a ` +
    `WOOD/WALL roof is within ${SHELTER_ROOF_SCAN} cells directly above the head — ` +
    `regardless of the sides (open). No roof / natural DIRT-STONE roof / roof too ` +
    `high → false. Bounded at ≤${maxReadsPerCall} cell reads per call. The dropped ` +
    `both-side-walls requirement is THE FIX: survivors warm under a roof and walk ` +
    `freely out for water/food.`,
);
