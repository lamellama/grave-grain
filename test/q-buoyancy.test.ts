declare const process: any;
/**
 * q-buoyancy.test.ts - playtest v0.9 Q+O: per-body buoyancy in locomotion
 * (GDD 5.1/5.2/7.3). Survivors FLOAT (head above the waterline - a rain/melt
 * sheet no longer drowns the colony, playtest O); zombies sink and walk the
 * lake BOTTOM with the drown clock never running (undead don't breathe).
 * Headless Node test over REAL modules; the grid is STATIC (no sim.step) so
 * every run is deterministic - updateBody is the unit under test.
 *
 * Done-when:
 *   1. FLOAT - a survivor dropped into a deep pool rises until its head clears
 *      the water, bobs at the float line (torso wet, head dry), never drowns
 *      over 3x DROWN_TICKS, and never overlaps solid (no-tunnel).
 *   2. BOTTOM-WALK - a zombie in the same pool sinks to the pool floor,
 *      grounds there, walks ACROSS the bottom when driven, and its drown clock
 *      never starts (breathes=false) - it crosses the lake bed intact.
 *   3. TRAPPED DROWNING PRESERVED - a buoyant survivor sealed in a flooded box
 *      (solid ceiling, no air pocket) cannot rise clear and still drowns into
 *      a prone corpse at DROWN_TICKS (drowning stays a real threat).
 *   4. FLOOD (the O scenario) - a survivor standing on the ground that gets
 *      sheeted over with deep water floats up off its feet and survives.
 *   5. PRE-Q DEFAULT PINNED - a raw createBody (buoyant=false, breathes=true)
 *      sinks AND drowns exactly as before (p4-t5's contract unchanged).
 *   6. TURNED = UNDEAD WATER RULES - reanimateAsZombie flips the wrapped
 *      body's flags (stops floating, stops breathing).
 */

import { WORLD_W, DROWN_TICKS, P3_GROUND_Y } from '../src/config';
import { STONE, WATER, AIR } from '../src/engine/materials';
import { material, integrity, set, get } from '../src/engine/grid';
import { createBody } from '../src/characters/body';
import type { Body } from '../src/characters/body';
import { updateBody, bodyCellsSolidAt } from '../src/characters/locomotion';
import { createSurvivor } from '../src/characters/survivor';
import { createZombie, reanimateAsZombie } from '../src/characters/zombie';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

const FLOOR = P3_GROUND_Y; // solid row the pool bottom sits on
const DEPTH = 20; // pool depth (cells of water above the floor)
const TOP = FLOOR - DEPTH; // highest water row
const PX0 = 100; // pool left interior column
const PX1 = 160; // pool right interior column

/**
 * Wipe the world and build a contained pool: STONE floor, STONE side walls,
 * WATER filling [PX0..PX1] x [TOP..FLOOR-1]. Static grid - nothing steps it.
 */
function poolScene(): void {
  material.fill(AIR);
  integrity.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  for (let y = TOP - 8; y < FLOOR; y++) {
    set(PX0 - 1, y, STONE);
    set(PX1 + 1, y, STONE);
  }
  for (let y = TOP; y < FLOOR; y++) {
    for (let x = PX0; x <= PX1; x++) set(x, y, WATER);
  }
}

/** ANY head cell in WATER? (test-side mirror of the locomotion probe) */
function headInWater(body: Body): boolean {
  const head = body.rig.find((b) => b.name === 'head')!;
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  for (const p of head.pixels) {
    if (get(rx + head.offset.dx + p.dx, ry + head.offset.dy + p.dy) === WATER) return true;
  }
  return false;
}

/** ANY body pixel in WATER? */
function anyPixelInWater(body: Body): boolean {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      if (get(rx + bone.offset.dx + p.dx, ry + bone.offset.dy + p.dy) === WATER) return true;
    }
  }
  return false;
}

// ===========================================================================
// 1. FLOAT - survivor rises to the surface and bobs there, never drowns.
// ===========================================================================
console.log('\n=== 1 survivor FLOATS in a deep pool ===');
{
  poolScene();
  const s = createSurvivor(130, FLOOR - 1); // feet on the pool bottom, fully submerged
  check(s.body.buoyant === true, 'createSurvivor body is buoyant');
  check(headInWater(s.body), 'setup: head starts underwater (pool deeper than the body)');

  // Rise phase: within DEPTH ticks (1 cell/tick) the head must clear the water.
  let surfacedAt = -1;
  let overlap = false;
  for (let t = 0; t < DEPTH + 10; t++) {
    updateBody(s.body);
    if (bodyCellsSolidAt(s.body, 0, 0)) overlap = true;
    if (surfacedAt < 0 && !headInWater(s.body)) surfacedAt = t;
  }
  check(surfacedAt >= 0, `head cleared the waterline (tick ${surfacedAt})`);
  check(!overlap, 'no-tunnel: never overlapped solid while rising');

  // Bob phase: hold the float line for 3x DROWN_TICKS - alive, dry-headed,
  // still in the water (not levitating), position stable.
  const settleY = Math.round(s.body.y);
  let maxDrown = 0;
  let headWet = 0;
  let drift = 0;
  for (let t = 0; t < DROWN_TICKS * 3; t++) {
    updateBody(s.body);
    maxDrown = Math.max(maxDrown, s.body.drownTicks);
    if (headInWater(s.body)) headWet++;
    drift = Math.max(drift, Math.abs(Math.round(s.body.y) - settleY));
  }
  check(s.body.alive, `alive after ${DROWN_TICKS * 3} ticks afloat`);
  check(maxDrown < DROWN_TICKS / 2, `drown clock never built up (max ${maxDrown} < ${DROWN_TICKS / 2})`);
  check(headWet === 0, 'head stayed dry the whole bob phase');
  check(anyPixelInWater(s.body), 'body still IN the water (floating, not levitating)');
  check(drift <= 1, `float line is stable (max drift ${drift} <= 1 cell)`);
}

// ===========================================================================
// 2. BOTTOM-WALK - zombie sinks, grounds on the pool floor, crosses it.
// ===========================================================================
console.log('\n=== 2 zombie sinks and walks the BOTTOM ===');
{
  poolScene();
  const z = createZombie(110, TOP - 2); // dropped onto the pool surface
  check(z.body.buoyant === false, 'zombie body is not buoyant');
  check(z.body.breathes === false, 'zombie body does not breathe');

  // Sink phase: no drive - it must settle on the pool FLOOR (feet row FLOOR-1).
  for (let t = 0; t < 80; t++) updateBody(z.body);
  check(Math.round(z.body.y) === FLOOR - 1, `sank to the pool bottom (feet row ${Math.round(z.body.y)} === ${FLOOR - 1})`);
  check(z.body.grounded, 'grounded on the lake bed');
  check(headInWater(z.body), 'fully submerged down there');

  // Walk phase: drive it across the bottom for far longer than DROWN_TICKS.
  z.body.moveDir = 1;
  const x0 = Math.round(z.body.x);
  let overlap = false;
  for (let t = 0; t < DROWN_TICKS * 3; t++) {
    updateBody(z.body);
    if (bodyCellsSolidAt(z.body, 0, 0)) overlap = true;
  }
  const x1 = Math.round(z.body.x);
  check(x1 > x0 + 10, `walked the bottom (${x0} -> ${x1})`);
  check(z.body.alive, 'never drowned (undead)');
  check(z.body.drownTicks === 0, 'drown clock never ran (breathes=false)');
  check(!overlap, 'no-tunnel: never overlapped solid on the lake bed');
}

// ===========================================================================
// 3. TRAPPED DROWNING PRESERVED - flooded sealed box still kills.
// ===========================================================================
console.log('\n=== 3 trapped under a ceiling: drowning still kills ===');
{
  material.fill(AIR);
  integrity.fill(0);
  const BX0 = 200;
  const BX1 = 214;
  const CEIL = FLOOR - 15; // interior FLOOR-14..FLOOR-1 (14 rows; body is 12)
  for (let x = BX0 - 1; x <= BX1 + 1; x++) {
    set(x, FLOOR, STONE);
    set(x, CEIL, STONE);
  }
  for (let y = CEIL; y <= FLOOR; y++) {
    set(BX0 - 1, y, STONE);
    set(BX1 + 1, y, STONE);
  }
  for (let y = CEIL + 1; y < FLOOR; y++) {
    for (let x = BX0; x <= BX1; x++) set(x, y, WATER); // flooded to the ceiling
  }
  const s = createSurvivor(207, FLOOR - 1);
  check(headInWater(s.body), 'setup: sealed box is flooded over the head');
  let died = -1;
  for (let t = 0; t < DROWN_TICKS + 20 && died < 0; t++) {
    updateBody(s.body);
    if (!s.body.alive) died = t;
  }
  check(died >= 0, `buoyant survivor with no surface DROWNED (tick ${died})`);
  check(died >= DROWN_TICKS - 2, `death took the full breath (${died} >= ${DROWN_TICKS - 2})`);
  check(s.body.corpse, 'drowning stayed a QUIET death (prone corpse, GDD 5.1)');
}

// ===========================================================================
// 4. FLOOD (playtest O) - water sheets over a standing survivor -> floats up.
// ===========================================================================
console.log('\n=== 4 flood sheet: standing survivor floats up and lives ===');
{
  poolScene();
  // Stand it on the pool floor first with the water already there (the sheet
  // has just flowed in over it - same end state as rain/melt flooding).
  const s = createSurvivor(140, FLOOR - 1);
  check(headInWater(s.body), 'setup: flood covers the standing survivor');
  for (let t = 0; t < DROWN_TICKS * 2; t++) updateBody(s.body);
  check(s.body.alive, 'survived the flood (floated up, playtest O)');
  check(!headInWater(s.body), 'head is above the flood water');
  check(Math.round(s.body.y) < FLOOR - 1, 'lifted OFF the ground by the water');
}

// ===========================================================================
// 5. PRE-Q DEFAULT PINNED - a raw body still sinks and drowns (p4-t5 contract).
// ===========================================================================
console.log('\n=== 5 default body: sinks + drowns exactly as before ===');
{
  poolScene();
  const b = createBody(130, FLOOR - 1);
  check(b.buoyant === false && b.breathes === true, 'createBody defaults: sink + breathe');
  let died = -1;
  for (let t = 0; t < DROWN_TICKS + 20 && died < 0; t++) {
    updateBody(b);
    if (!b.alive) died = t;
  }
  check(Math.round(b.y) === FLOOR - 1 || !b.alive, 'never floated');
  check(died >= 0, `drowned at the bottom (tick ${died})`);
}

// ===========================================================================
// 6. TURNED = UNDEAD WATER RULES - reanimate flips the wrapped body's flags.
// ===========================================================================
console.log('\n=== 6 turned survivor adopts undead water rules ===');
{
  poolScene();
  const s = createSurvivor(130, FLOOR - 5);
  check(s.body.buoyant && s.body.breathes, 'setup: living survivor floats + breathes');
  const z = reanimateAsZombie(s.body);
  check(z.body === s.body, 'reanimate wraps the SAME body (THE GATE contract)');
  check(!s.body.buoyant, 'turned body stops floating (sinks like the horde)');
  check(!s.body.breathes, 'turned body stops breathing (drown clock off)');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
