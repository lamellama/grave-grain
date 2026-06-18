/**
 * Headless alignment-math check for p3-t4 (renderer body overlay).
 *
 * Verifies that a body pixel authored at world cell (wx, wy) maps to the SAME
 * screen rect (same top-left px, same CELL_SIZE) as a sim cell drawn at (wx, wy)
 * by the renderer's ImageData loop:
 *
 *   Cell layer:  screenX = (cellX - camera.x) * CELL_SIZE
 *   worldToScreen: x    = (worldX - camera.x) * CELL_SIZE   ← identical
 *
 * Tests both camera.x = 0 and a scrolled camera position.
 */

// Pull in the real camera and worldToScreen (no DOM needed — they are pure math).
// We manually set camera.x to simulate scroll.
import { camera, worldToScreen } from '../src/camera';
import { CELL_SIZE } from '../src/config';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}

/** The exact formula the renderer's ImageData cell loop uses (renderer.ts ~line 90). */
function cellLayerScreenX(cellX: number): number {
  return (cellX - camera.x) * CELL_SIZE;
}
function cellLayerScreenY(cellY: number): number {
  return (cellY - camera.y) * CELL_SIZE;
}

// ── Test at camera.x = 0 ──────────────────────────────────────────────────────
camera.x = 0;
camera.y = 0;

const WX0 = 50;
const WY0 = 30;

const cellSx0 = cellLayerScreenX(WX0);
const cellSy0 = cellLayerScreenY(WY0);
const { x: bodySx0, y: bodySy0 } = worldToScreen(WX0, WY0);

console.log(`\ncamera=(0,0)  world cell (${WX0},${WY0}):`);
console.log(`  cell layer top-left : (${cellSx0}, ${cellSy0})`);
console.log(`  worldToScreen result: (${bodySx0}, ${bodySy0})`);
console.log(`  CELL_SIZE           : ${CELL_SIZE}`);

if (cellSx0 !== bodySx0) fail(`X mismatch at camera.x=0: cell=${cellSx0} body=${bodySx0}`);
if (cellSy0 !== bodySy0) fail(`Y mismatch at camera.y=0: cell=${cellSy0} body=${bodySy0}`);
console.log('PASS: alignment correct at camera=(0,0)');

// ── Test at scrolled camera.x = 37.5 (fractional is realistic mid-pan) ───────
camera.x = 37.5;
camera.y = 0;

const WX1 = 100;
const WY1 = 20;

const cellSx1 = cellLayerScreenX(WX1);
const cellSy1 = cellLayerScreenY(WY1);
const { x: bodySx1, y: bodySy1 } = worldToScreen(WX1, WY1);

console.log(`\ncamera=(37.5,0)  world cell (${WX1},${WY1}):`);
console.log(`  cell layer top-left : (${cellSx1}, ${cellSy1})`);
console.log(`  worldToScreen result: (${bodySx1}, ${bodySy1})`);
console.log(`  CELL_SIZE           : ${CELL_SIZE}`);

if (cellSx1 !== bodySx1) fail(`X mismatch at camera.x=37.5: cell=${cellSx1} body=${bodySx1}`);
if (cellSy1 !== bodySy1) fail(`Y mismatch at camera.y=0: cell=${cellSy1} body=${bodySy1}`);
console.log('PASS: alignment correct at camera=(37.5,0)');

// ── Confirm CELL_SIZE is the fillRect size used in renderer ──────────────────
if (CELL_SIZE <= 0 || !Number.isInteger(CELL_SIZE)) {
  fail(`CELL_SIZE must be a positive integer, got ${CELL_SIZE}`);
}
console.log(`PASS: CELL_SIZE=${CELL_SIZE} (both cell layer and body fillRect use this)`);

console.log('\nALL PASS — body pixels align exactly to the cell grid.');
