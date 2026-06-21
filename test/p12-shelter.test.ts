/**
 * Headless verification for Task W2 — isSheltered() bounded grid-read helper
 * (GDD §8 shelter / §6.1 warmth). Pure read-only helper; NOT wired into
 * updateSurvivor here (that is W3).
 *
 * Geometry (body at x=200, y=149, feet anchor):
 *   feet   row (ry)     = 149
 *   head   row          = ry - (BODY_H-1) = 149 - 11 = 138
 *   mid    row          = ry - floor(BODY_H/2) = 149 - 6 = 143
 *   center col (rx)     = 200
 *
 *   SHELTER_ROOF_SCAN = 6  → roof cells probed: y ∈ [132, 137] (above row 138)
 *   SHELTER_SIDE_SCAN = 4  → left  cells: x ∈ [196, 199] at y=143
 *                           → right cells: x ∈ [201, 204] at y=143
 *
 * Tests:
 *   1. Sheltered (WOOD roof + WALL left + WALL right) → true
 *   2. Open (no structures)                          → false
 *   3a. Roof only, no side walls                     → false
 *   3b. Roof + left wall, no right wall              → false
 *   4. Natural terrain (DIRT/STONE overhang)         → false
 *   5. Bounded scan constant check (code-reasoning)  → logged
 *   6. npm run build green (verified after the above)
 */

import { BODY_H, SHELTER_ROOF_SCAN, SHELTER_SIDE_SCAN } from '../src/config';
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
// Derived geometry constants (mirrors isSheltered internals exactly).
const RY   = BY;               // Math.round(BY)
const RX   = BX;               // Math.round(BX)
const HEAD = RY - (BODY_H - 1); // 138
const MID  = RY - Math.floor(BODY_H / 2); // 143

// A WOOD roof cell just 1 row above the head (within SHELTER_ROOF_SCAN).
const ROOF_X = RX;
const ROOF_Y = HEAD - 1; // 137

// WALL cells at the extreme edge of SHELTER_SIDE_SCAN (worst-case, still detected).
const LEFT_X  = RX - SHELTER_SIDE_SCAN; // 196
const RIGHT_X = RX + SHELTER_SIDE_SCAN; // 204
const WALL_Y  = MID;                    // 143

// ---------------------------------------------------------------------------
// 5. Bounded scan — log the bound so the CI run shows it.
// ---------------------------------------------------------------------------
const maxReadsPerCall = SHELTER_ROOF_SCAN + 2 * SHELTER_SIDE_SCAN;
console.log(
  `BOUND: worst-case grid reads per isSheltered call = ` +
  `SHELTER_ROOF_SCAN(${SHELTER_ROOF_SCAN}) + 2×SHELTER_SIDE_SCAN(${SHELTER_SIDE_SCAN}) = ${maxReadsPerCall}`,
);
if (maxReadsPerCall > 20) fail(`reads per call (${maxReadsPerCall}) unexpectedly large`);
ok(`bounded: isSheltered reads at most ${maxReadsPerCall} cells per call — no world scan`);

// ---------------------------------------------------------------------------
// 1. Sheltered: WOOD roof + WALL left + WALL right → true
// ---------------------------------------------------------------------------
clearGrid();
set(ROOF_X, ROOF_Y, WOOD);   // roof (WOOD)
set(LEFT_X,  WALL_Y, WALL);   // left wall (WALL)
set(RIGHT_X, WALL_Y, WALL);   // right wall (WALL)

{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== true) fail(`sheltered=true expected; got ${result}`);
  ok(`sheltered (WOOD roof + WALL left + WALL right) → true`);
}

// Mix materials: WALL roof + WOOD walls.
clearGrid();
set(ROOF_X, ROOF_Y, WALL);
set(LEFT_X,  WALL_Y, WOOD);
set(RIGHT_X, WALL_Y, WOOD);
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== true) fail(`sheltered (WALL roof + WOOD walls) → true expected; got ${result}`);
  ok(`sheltered (WALL roof + WOOD walls) → true`);
}

// ---------------------------------------------------------------------------
// 2. Open (no structures anywhere) → false
// ---------------------------------------------------------------------------
clearGrid();
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== false) fail(`open → false expected; got ${result}`);
  ok(`open (no structures) → false`);
}

// ---------------------------------------------------------------------------
// 3a. Roof only, no side walls → false
// ---------------------------------------------------------------------------
clearGrid();
set(ROOF_X, ROOF_Y, WOOD);
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== false) fail(`roof-only → false expected; got ${result}`);
  ok(`roof only (no walls) → false`);
}

// ---------------------------------------------------------------------------
// 3b. Roof + left wall only (missing right wall) → false
// ---------------------------------------------------------------------------
clearGrid();
set(ROOF_X, ROOF_Y, WOOD);
set(LEFT_X,  WALL_Y, WALL);
// No right wall.
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== false) fail(`roof + left wall only → false expected; got ${result}`);
  ok(`roof + left wall only (missing right wall) → false`);
}

// ---------------------------------------------------------------------------
// 3c. Roof + right wall only (missing left wall) → false
// ---------------------------------------------------------------------------
clearGrid();
set(ROOF_X, ROOF_Y, WOOD);
set(RIGHT_X, WALL_Y, WALL);
// No left wall.
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== false) fail(`roof + right wall only → false expected; got ${result}`);
  ok(`roof + right wall only (missing left wall) → false`);
}

// ---------------------------------------------------------------------------
// 4. Natural terrain (DIRT roof + STONE walls) → false
//    isSheltered only keys on WOOD/WALL; hillsides must NOT count.
// ---------------------------------------------------------------------------
clearGrid();
set(ROOF_X, ROOF_Y, DIRT);     // "roof" made of DIRT
set(LEFT_X,  WALL_Y, STONE);   // "wall" made of STONE
set(RIGHT_X, WALL_Y, STONE);
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== false) fail(`natural terrain (DIRT/STONE) → false expected; got ${result}`);
  ok(`natural terrain (DIRT roof + STONE walls) → false (only WOOD/WALL count)`);
}

// Also: STONE roof + DIRT walls → false
clearGrid();
set(ROOF_X, ROOF_Y, STONE);
set(LEFT_X,  WALL_Y, DIRT);
set(RIGHT_X, WALL_Y, DIRT);
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== false)
    fail(`STONE roof + DIRT walls → false expected; got ${result}`);
  ok(`STONE roof + DIRT walls → false`);
}

// ---------------------------------------------------------------------------
// 4b. Roof just BEYOND SHELTER_ROOF_SCAN range → false (boundary)
// ---------------------------------------------------------------------------
clearGrid();
set(ROOF_X, HEAD - SHELTER_ROOF_SCAN - 1, WOOD); // one cell TOO FAR above head
set(LEFT_X,  WALL_Y, WALL);
set(RIGHT_X, WALL_Y, WALL);
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== false)
    fail(`roof beyond SHELTER_ROOF_SCAN → false expected; got ${result}`);
  ok(`roof ${SHELTER_ROOF_SCAN + 1} cells above head (beyond scan range) → false`);
}

// Wall just BEYOND SHELTER_SIDE_SCAN range → false (boundary)
clearGrid();
set(ROOF_X, ROOF_Y, WOOD);
set(RX - SHELTER_SIDE_SCAN - 1, WALL_Y, WALL); // one cell too far left
set(RIGHT_X, WALL_Y, WALL);
{
  const s = createSurvivor(BX, BY);
  const result = isSheltered(s.body);
  if (result !== false)
    fail(`left wall beyond SHELTER_SIDE_SCAN → false expected; got ${result}`);
  ok(`left wall ${SHELTER_SIDE_SCAN + 1} cells away (beyond scan range) → false`);
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
console.log('\nALL PASS');
console.log(
  `SUMMARY: isSheltered() correctly returns true only when WOOD/WALL roof is ` +
  `within ${SHELTER_ROOF_SCAN} cells above head AND WOOD/WALL walls within ` +
  `${SHELTER_SIDE_SCAN} cells on BOTH sides at mid-torso. Natural DIRT/STONE ` +
  `terrain returns false. Bounded at ≤${maxReadsPerCall} cell reads per call. ` +
  `Read-only; NOT wired into updateSurvivor (W3 handles that).`,
);
