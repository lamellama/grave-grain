/**
 * Headless verification for p3-t2 (characters/locomotion.ts).
 * Imports the REAL modules (no mocks). Seeds terrain directly into grid.material.
 * Run via tsc (commonjs) -> node.
 */
import { createBody, type Body } from '../src/characters/body';
import { updateBody, bodyCellsSolidAt } from '../src/characters/locomotion';
import { material, idx } from '../src/engine/grid';
import { get } from '../src/engine/grid';
import { isSolidForBody, STONE, AIR } from '../src/engine/materials';
import { WORLD_W, WORLD_H } from '../src/config';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}

function clearWorld(): void {
  material.fill(AIR);
}

// Lowest non-destroyed pixel world-row of the body (the feet contact row).
function lowestPixelRow(body: Body): number {
  const ry = Math.round(body.y);
  let lowest = -Infinity;
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      lowest = Math.max(lowest, ry + bone.offset.dy + p.dy);
    }
  }
  return lowest;
}

// Assert NO body pixel currently sits in a solid cell (no-tunnel invariant).
function assertNoOverlap(body: Body, tick: number, scenario: string): void {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const wx = rx + bone.offset.dx + p.dx;
      const wy = ry + bone.offset.dy + p.dy;
      if (isSolidForBody(get(wx, wy))) {
        fail(
          `${scenario}: pixel overlapped solid at (${wx},${wy}) on tick ${tick}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: flat STONE floor; body spawns in air; falls and rests on top.
// ---------------------------------------------------------------------------
clearWorld();
const FLOOR_R = WORLD_H - 20; // first solid stone row
for (let r = FLOOR_R; r < WORLD_H; r++) {
  for (let x = 0; x < WORLD_W; x++) material[idx(x, r)] = STONE;
}

const SPAWN_X = 200;
const SPAWN_Y = 100; // well above the floor
const body: Body = createBody(SPAWN_X, SPAWN_Y);

let invariantHeld = true;
let overlapTick = -1;
for (let t = 0; t < 120; t++) {
  updateBody(body);
  try {
    assertNoOverlap(body, t, 'scenario1');
  } catch {
    invariantHeld = false;
    overlapTick = t;
    break;
  }
}

if (!invariantHeld) fail(`scenario1 invariant broke at tick ${overlapTick}`);
console.log('Scenario 1: no-tunnel invariant held all 120 ticks');

if (!body.grounded) fail(`scenario1 body.grounded = ${body.grounded}, expected true`);
const low1 = lowestPixelRow(body);
if (low1 !== FLOOR_R - 1) {
  fail(`scenario1 lowest foot pixel at row ${low1}, expected ${FLOOR_R - 1}`);
}
if (!Number.isInteger(body.y)) fail(`scenario1 body.y not integer: ${body.y}`);
console.log(
  `Scenario 1: grounded=true, body.y=${body.y}, lowest foot row=${low1} (floor top=${FLOOR_R}) PASS`,
);

// ---------------------------------------------------------------------------
// Scenario 2: dig a pit beneath the body down to a deeper floor; body refalls.
// ---------------------------------------------------------------------------
// Pit spans the full body width (and margin) centred on the body; clear stone
// from the old floor top down to a new deeper floor row.
const PIT_BOTTOM_R = WORLD_H - 6; // deeper floor: keep rows >= this as STONE
const rx = Math.round(body.x);
let minX = Infinity;
let maxX = -Infinity;
for (const bone of body.rig) {
  for (const p of bone.pixels) {
    minX = Math.min(minX, rx + bone.offset.dx + p.dx);
    maxX = Math.max(maxX, rx + bone.offset.dx + p.dx);
  }
}
// Clear a generous column so the body falls freely into the pit.
for (let x = minX - 2; x <= maxX + 2; x++) {
  for (let r = FLOOR_R; r < PIT_BOTTOM_R; r++) material[idx(x, r)] = AIR;
}

let invariant2 = true;
let overlap2 = -1;
for (let t = 0; t < 120; t++) {
  updateBody(body);
  try {
    assertNoOverlap(body, t, 'scenario2');
  } catch {
    invariant2 = false;
    overlap2 = t;
    break;
  }
}
if (!invariant2) fail(`scenario2 invariant broke at tick ${overlap2}`);
console.log('Scenario 2: no-tunnel invariant held all 120 ticks');

if (!body.grounded) fail(`scenario2 body.grounded = ${body.grounded}, expected true`);
const low2 = lowestPixelRow(body);
if (low2 !== PIT_BOTTOM_R - 1) {
  fail(`scenario2 lowest foot pixel at row ${low2}, expected ${PIT_BOTTOM_R - 1}`);
}
if (low2 <= low1) fail(`scenario2 did not fall deeper: ${low2} vs ${low1}`);
if (!Number.isInteger(body.y)) fail(`scenario2 body.y not integer: ${body.y}`);
console.log(
  `Scenario 2: grounded=true, body.y=${body.y}, lowest foot row=${low2} (pit bottom=${PIT_BOTTOM_R}) PASS`,
);

void bodyCellsSolidAt; // referenced to confirm export exists

console.log('\nALL PASS');
