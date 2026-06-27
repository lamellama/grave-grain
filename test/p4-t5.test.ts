/**
 * Headless verification for p4-t5 (THE GATE, gate point 4: bury/submerge → the
 * body reacts and can die). Imports the REAL modules (no mocks). Seeds terrain
 * directly into grid.material. Run via tsc (commonjs) -> node.
 *
 * Covers GDD §5.2 ("water drowns bodies when head submerged too long") + §7.3
 * ("buried by collapsing sand, drowned in water"):
 *   1. DROWN: head held under WATER in a sealed stone tank → drownTicks climbs,
 *      and at ~DROWN_TICKS the body lays down as a prone CORPSE (revised death
 *      model, GDD §5.1: drowning is a QUIET death → corpse=true, alive=false,
 *      bones stay WHOLE — NOT the cell-dissolve path).
 *      Control: head in AIR for the same ticks → alive, drownTicks stays 0.
 *   2. PIN: SAND piled directly on the head → moveDir=+1 makes ~0 progress vs a
 *      free body that walks away.
 *   3. NO REGRESSION: a dry, unburied, intact body walks/falls normally and
 *      never accrues drownTicks.
 */
import { createBody, type Body } from '../src/characters/body';
import { updateBody } from '../src/characters/locomotion';
import { step } from '../src/engine/simulation';
import { material, idx, get } from '../src/engine/grid';
import { STONE, WATER, SAND, AIR } from '../src/engine/materials';
import { WORLD_W, WORLD_H, DROWN_TICKS } from '../src/config';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}

const FLOOR = 160;

function clear(): void {
  material.fill(AIR);
}
function fillCol(x: number, fromRow: number, mat: number): void {
  for (let r = fromRow; r < WORLD_H; r++) material[idx(x, r)] = mat;
}
function buildFlat(): void {
  clear();
  for (let x = 0; x < WORLD_W; x++) fillCol(x, FLOOR, STONE);
}

// Settle a body onto the floor (no horizontal drive, no sim).
function settle(body: Body, scenario: string): void {
  for (let t = 0; t < 60; t++) updateBody(body);
  if (!body.grounded) fail(`${scenario}: body never grounded while settling`);
}

// World cells of the (intact) head bone.
function headCells(body: Body): { x: number; y: number }[] {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  const head = body.rig.find((b) => b.name === 'head')!;
  return head.pixels.map((p) => ({
    x: rx + head.offset.dx + p.dx,
    y: ry + head.offset.dy + p.dy,
  }));
}
function allBonesDestroyed(body: Body): boolean {
  return body.rig.every((b) => b.destroyed);
}

// === Scenario 1a: DROWN — head sealed under water in a stone tank ===========
buildFlat();
const drowner = createBody(80, 100);
settle(drowner, 'drown-settle');
// Seal a tank: stone walls flanking the body, flood it well above the head so
// the water can't drain out from under sim.step() (it just seeks its level).
const cells = headCells(drowner);
const minHeadY = Math.min(...cells.map((c) => c.y));
const lx = 70;
const rx2 = 90;
fillCol(lx, FLOOR - 30, STONE); // left wall up from below the water surface
fillCol(rx2, FLOOR - 30, STONE); // right wall
for (let y = minHeadY - 4; y < FLOOR; y++) {
  for (let x = lx + 1; x < rx2; x++) {
    if (material[idx(x, y)] === AIR) material[idx(x, y)] = WATER;
  }
}
// Confirm the head is actually submerged at t0.
if (!headCells(drowner).every((c) => get(c.x, c.y) === WATER)) {
  fail('drown setup: head cells are not all WATER at t0');
}

let deathTick = -1;
for (let t = 0; t < DROWN_TICKS + 5; t++) {
  updateBody(drowner);
  step();
  if (!drowner.alive && deathTick < 0) deathTick = t;
}
if (drowner.alive) fail('submerged body never drowned');
// Revised death model (GDD §5.1): drowning is a QUIET death → prone corpse,
// not the cell-dissolve. The body must be flagged a corpse and its skeleton
// must stay WHOLE (the dissolve path is reserved for EXTREME deaths).
if (!drowner.corpse) fail('drowned body is not a corpse (quiet-death model)');
if (allBonesDestroyed(drowner)) fail('drowned body dissolved (should lay down a whole corpse)');
console.log(
  `DROWN: died on tick ${deathTick} (DROWN_TICKS=${DROWN_TICKS}); ` +
    `alive=${drowner.alive}, corpse=${drowner.corpse}, allBonesDestroyed=${allBonesDestroyed(drowner)}`,
);
if (deathTick < DROWN_TICKS - 1 || deathTick > DROWN_TICKS + 2) {
  fail(`death tick ${deathTick} not within ~DROWN_TICKS`);
}
ok('water over head past DROWN_TICKS → drown → prone corpse (quiet death, bones whole)');

// === Scenario 1b: control — head in AIR, same tick budget, never drowns =====
buildFlat();
const dry = createBody(80, 100);
settle(dry, 'dry-settle');
for (let t = 0; t < DROWN_TICKS + 5; t++) {
  updateBody(dry);
  step();
}
if (!dry.alive) fail('dry body died with head in open AIR');
if (dry.drownTicks !== 0) fail(`dry body accrued drownTicks=${dry.drownTicks} in AIR`);
console.log(`DRY CONTROL: alive=${dry.alive}, drownTicks=${dry.drownTicks} after ${DROWN_TICKS + 5} ticks`);
ok('head in AIR → never drowns, drownTicks stays 0');

// === Scenario 2: PIN — sand piled on the head suppresses the walk ===========
const PIN_TICKS = 60;
// Free body: clean flat ground, walks freely.
buildFlat();
const free = createBody(80, 100);
settle(free, 'free-settle');
const freeStart = free.x;
for (let t = 0; t < PIN_TICKS; t++) {
  free.moveDir = 1;
  updateBody(free);
}
const D_free = free.x - freeStart;

// Pinned body: bury the head under a solid block of SAND (no sim.step so the
// pile stays put — this is the locomotion pin gate, not a settling test).
buildFlat();
const pinned = createBody(80, 100);
settle(pinned, 'pin-settle');
const pc = headCells(pinned);
const pMinY = Math.min(...pc.map((c) => c.y));
const pMinX = Math.min(...pc.map((c) => c.x));
const pMaxX = Math.max(...pc.map((c) => c.x));
for (let y = pMinY - 6; y <= pMinY - 1; y++) {
  for (let x = pMinX - 1; x <= pMaxX + 1; x++) material[idx(x, y)] = SAND;
}
const pinStart = pinned.x;
for (let t = 0; t < PIN_TICKS; t++) {
  pinned.moveDir = 1;
  updateBody(pinned);
}
const D_pinned = pinned.x - pinStart;
console.log(
  `PIN: D_free=${D_free.toFixed(2)} cells vs D_pinned=${D_pinned.toFixed(2)} cells over ${PIN_TICKS} ticks`,
);
if (D_free < 5) fail('free body did not walk (setup broken)');
if (Math.abs(D_pinned) > 0.001) fail(`pinned body moved ${D_pinned} (should be ~0)`);
ok('sand on the head pins the body: horizontal progress ~0 vs a free body that walks');

// === Scenario 3: NO REGRESSION — dry intact body walks/falls, no drownTicks =
buildFlat();
const walker = createBody(80, 100);
settle(walker, 'walk-settle');
const wStart = walker.x;
for (let t = 0; t < 200; t++) {
  walker.moveDir = 1;
  updateBody(walker);
  step();
  if (walker.drownTicks !== 0) fail(`walker accrued drownTicks=${walker.drownTicks} on dry ground`);
}
const D_walk = walker.x - wStart;
if (!walker.alive) fail('dry walker died');
if (D_walk < 5) fail('dry walker did not advance');
console.log(`NO-REGRESSION: dry walker advanced ${D_walk.toFixed(2)} cells, grounded=${walker.grounded}, drownTicks=${walker.drownTicks}`);
ok('unburied dry intact body walks normally and never accrues drownTicks');

console.log('\nALL PASS');
