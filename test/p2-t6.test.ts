/**
 * Headless verification for p2-t6 (reactions.ts).
 * Run via: tsc (commonjs) -> node. See run-test.sh.
 *
 * Tests the real engine modules (no mocks):
 *  1. Extinguish: watered burn reaches 0 FIRE faster than a free burn + steam.
 *  2. Collapse: an undermined sand overhang fully settles (nothing floats).
 */
import { material, set } from '../src/engine/grid';
import { step } from '../src/engine/simulation';
import { WORLD_W, WORLD_H } from '../src/config';
import { AIR, STONE, WATER, WOOD, FIRE, SMOKE, SAND } from '../src/engine/materials';
import { FIRE_LIFETIME } from '../src/config';

function clearWorld(): void {
  material.fill(AIR);
}

function count(id: number): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === id) n++;
  return n;
}

// --- Test 1: extinguish vs free burn ----------------------------------------
import { ignite } from '../src/engine/simulation';

// A single horizontal WOOD strip, fully ignited so it is actively burning from
// tick 0. A thin strip lets run B put WATER in orthogonal contact with EVERY
// fire cell, so the extinguish effect is visible across the whole front rather
// than at one edge (otherwise interior cells just age out at FIRE_LIFETIME in
// both runs and the two runs tie).
const STRIP_X0 = 40;
const STRIP_Y = 40;
const STRIP_W = 24;

function buildBurningStrip(): void {
  clearWorld();
  for (let x = STRIP_X0; x < STRIP_X0 + STRIP_W; x++) set(x, STRIP_Y, WOOD);
  for (let x = STRIP_X0; x < STRIP_X0 + STRIP_W; x++) ignite(x, STRIP_Y);
}

function runBurn(water: boolean): { ticks: number; maxSmoke: number; sawSteamAtContact: boolean } {
  buildBurningStrip();
  if (water) {
    // A WATER cell directly ABOVE every fire cell: each fire cell is then
    // orthogonally adjacent to water and extinguishes to steam on tick 1.
    for (let x = STRIP_X0; x < STRIP_X0 + STRIP_W; x++) set(x, STRIP_Y - 1, WATER);
  }
  let ticks = 0;
  let maxSmoke = 0;
  let sawSteamAtContact = false;
  const MAX = 2000;
  while (count(FIRE) > 0 && ticks < MAX) {
    step();
    ticks++;
    maxSmoke = Math.max(maxSmoke, count(SMOKE));
    // Steam-at-contact: a SMOKE cell appearing on the burning row.
    if (water && !sawSteamAtContact) {
      for (let x = STRIP_X0; x < STRIP_X0 + STRIP_W; x++) {
        if (material[STRIP_Y * WORLD_W + x] === SMOKE) {
          sawSteamAtContact = true;
          break;
        }
      }
    }
  }
  return { ticks, maxSmoke, sawSteamAtContact };
}

// --- Test 2: undermined overhang collapse -----------------------------------
function highestRestingRow(): number {
  // Return the topmost row index that contains any SAND (smaller y = higher).
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      if (material[y * WORLD_W + x] === SAND) return y;
    }
  }
  return -1;
}

function anyFloatingSand(): boolean {
  // A SAND cell "floats" if the cell directly below it is AIR (unsupported).
  for (let y = 0; y < WORLD_H - 1; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      if (material[y * WORLD_W + x] === SAND && material[(y + 1) * WORLD_W + x] === AIR) {
        return true;
      }
    }
  }
  return false;
}

function testCollapse(): { floating: boolean; settledTopRow: number; floorTop: number } {
  clearWorld();
  const floorTop = WORLD_H - 10;
  // Solid stone floor.
  for (let x = 0; x < WORLD_W; x++) {
    for (let y = floorTop; y < WORLD_H; y++) set(x, y, STONE);
  }
  // A single stone pillar that supports a wide sand ledge above it.
  const pillarX = 60;
  for (let y = floorTop - 8; y < floorTop; y++) set(pillarX, y, STONE);
  // Sand ledge balanced on top of the pillar, overhanging both sides (air below).
  const ledgeY = floorTop - 9;
  for (let x = pillarX - 6; x <= pillarX + 6; x++) set(x, ledgeY, SAND);
  // Remove the pillar -> the ledge is now fully undermined (air below all of it).
  for (let y = floorTop - 8; y < floorTop; y++) set(pillarX, y, AIR);

  for (let t = 0; t < 400; t++) step();

  return {
    floating: anyFloatingSand(),
    settledTopRow: highestRestingRow(),
    floorTop,
  };
}

// --- Run ---------------------------------------------------------------------
console.log('FIRE_LIFETIME =', FIRE_LIFETIME);

const free = runBurn(false);
const wet = runBurn(true);
console.log('Run A (free burn)   ticks-to-zero-FIRE:', free.ticks, ' maxSmoke:', free.maxSmoke);
console.log('Run B (watered)     ticks-to-zero-FIRE:', wet.ticks, ' maxSmoke:', wet.maxSmoke,
  ' steam-at-contact:', wet.sawSteamAtContact);

const extinguishFaster = wet.ticks < free.ticks;
const steamMade = wet.sawSteamAtContact;
console.log('ASSERT extinguish faster (B < A):', extinguishFaster);
console.log('ASSERT steam (SMOKE) created at water/fire contact:', steamMade);

const col = testCollapse();
console.log('Collapse: floorTop row =', col.floorTop, ' settled top SAND row =', col.settledTopRow,
  ' floating-unsupported-sand:', col.floating);
const collapseOk = !col.floating && col.settledTopRow >= col.floorTop - 2;
console.log('ASSERT no floating ledge & sand settled onto floor:', collapseOk);

const pass = extinguishFaster && steamMade && collapseOk;
console.log(pass ? '\nALL PASS' : '\nFAIL');
if (!pass) throw new Error('p2-t6 assertions failed');
