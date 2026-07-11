declare const process: any;
/**
 * r11-arrows.test.ts - playtest round 11: "guards shoot further and not just
 * one vector - smart enough to shoot over walls, limited only by the velocity
 * of the arrow" (game/projectiles.ts + the guard branch in survivor.ts).
 *
 * Done-when:
 *   1. SOLVER - solveArcs returns the low+high pair for a reachable target,
 *      and both integrated flights actually arrive (the closed form and the
 *      tick integrator agree); an out-of-range target returns no solutions.
 *   2. RANGE - a guard wounds a zombie ~80 cells away (double the old melee
 *      engage bubble) on open ground, end to end through updateSurvivor:
 *      arrow spawned, flies, releases real cells via THE GATE.
 *   3. OVER THE WALL - with a tall native-stone wall between them, the flat
 *      shot is blocked but aimArrow returns the HIGH lob, and the live loop
 *      still wounds the zombie behind the wall - while the wall itself stays
 *      unmarked (arrows arc over, they don't chew through).
 *   4. TERRAIN STOPS ARROWS - an arrow flying into a solid face is removed
 *      (no tunnelling, no wraparound wounds).
 */

// ---- seeded RNG (mulberry32) - updateZombie meanders via Math.random -------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(1234);

import { ARROW_SPEED, ARROW_GRAVITY, GUARD_ARROW_RANGE } from '../src/config';
import { STONE, AIR } from '../src/engine/materials';
import { material, integrity, get, set, getIntegrity } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { setChunkingEnabled } from '../src/engine/chunks';
import { __setWeatherForTest } from '../src/engine/weather';
import {
  solveArcs,
  aimArrow,
  clearShot,
  spawnArrow,
  updateArrows,
  getArrows,
  resetArrows,
} from '../src/game/projectiles';
import { createSurvivor, updateSurvivor, assignRole } from '../src/characters/survivor';
import { createZombie } from '../src/characters/zombie';
import type { Zombie } from '../src/characters/zombie';
import { makeTool } from '../src/game/roles';
import { setStockpilePoint } from '../src/game/resources';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
const FLOOR = 150;
function clear(): void {
  material.fill(AIR);
  integrity.fill(0);
  for (let x = 0; x < 500; x++) {
    set(x, FLOOR, STONE);
    set(x, FLOOR + 1, STONE);
  }
  rebuildNavgrid();
  resetArrows();
}
function bonesLost(z: Zombie): number {
  let n = 0;
  for (const b of z.body.rig) if (b.destroyed) n++;
  return n;
}

setChunkingEnabled(false);
__setWeatherForTest('clear');

// ── 1. Solver sanity ─────────────────────────────────────────────────────────
console.log('--- 1: ballistic solver ---');
clear();
const sols = solveArcs(60, 0);
check(sols.length === 2, `1: two arcs for a flat 60-cell shot (got ${sols.length})`);
if (sols.length === 2) {
  check(sols[0].vy > sols[1].vy, '1: first solution is the LOW arc (less upward launch)');
  // Both integrated flights arrive on an empty range (clearShot = the same
  // integrator the live arrows use).
  check(clearShot(100, 100, sols[0].vx, sols[0].vy, 160, 100), '1: low arc arrives');
  check(clearShot(100, 100, sols[1].vx, sols[1].vy, 160, 100), '1: high arc arrives');
}
const maxRange = (ARROW_SPEED * ARROW_SPEED) / ARROW_GRAVITY;
check(solveArcs(maxRange * 1.2, 0).length === 0, '1: a target past max range has NO solution');

// ── 2. Long-range kill on open ground (end to end) ───────────────────────────
console.log('--- 2: open-ground range ---');
clear();
setStockpilePoint(100, FLOOR - 1);
const guard = createSurvivor(100, FLOOR - 1);
guard.tool = makeTool('weapon');
assignRole(guard, 'guard');
const zFar = createZombie(180, FLOOR - 1); // 80 cells out - the old radius was 40
const zombies = [zFar];
check(180 - 100 <= GUARD_ARROW_RANGE, '2: scenario inside the arrow engage ring');
let sawArrow = false;
let woundTick = 0;
for (let t = 1; t <= 900 && woundTick === 0; t++) {
  updateSurvivor(guard, zombies);
  updateArrows(zombies);
  if (getArrows().length > 0) sawArrow = true;
  if (bonesLost(zFar) > 0) woundTick = t;
}
check(sawArrow, '2: the guard loosed arrows (ranged, not walking in to stab)');
check(woundTick > 0, `2: the zombie 80 cells out was WOUNDED through THE GATE (tick ${woundTick})`);
check(
  Math.abs(guard.body.x - 100) < 8,
  `2: the guard held its ground while shooting (moved ${Math.abs(guard.body.x - 100).toFixed(1)} cells)`,
);

// ── 3. Lob over a wall ───────────────────────────────────────────────────────
console.log('--- 3: over the wall ---');
clear();
setStockpilePoint(200, FLOOR - 1);
// A tall NATIVE stone wall between guard (200) and zombie (245).
for (let y = FLOOR - 14; y < FLOOR; y++) set(222, y, STONE);
rebuildNavgrid();
const sy = FLOOR - 1 - 9; // roughly where the guard's chest sits
const flat = solveArcs(45, 0);
check(flat.length === 2, '3: both arcs exist for the 45-cell shot');
check(
  !clearShot(200, sy, flat[0].vx, flat[0].vy, 245, sy),
  '3: the LOW arc is blocked by the wall',
);
const aim = aimArrow(200, sy, 245, sy);
check(aim !== null, '3: aimArrow still finds a solution (the HIGH lob)');
if (aim && flat.length === 2) {
  check(
    aim.vy < flat[0].vy,
    '3: the chosen solution launches steeper upward than the blocked flat arc',
  );
}
// End to end: the guard behind the wall wounds the zombie beyond it.
const guard3 = createSurvivor(200, FLOOR - 1);
guard3.tool = makeTool('weapon');
assignRole(guard3, 'guard');
const zWall = createZombie(245, FLOOR - 1);
const zombies3 = [zWall];
let woundTick3 = 0;
for (let t = 1; t <= 1200 && woundTick3 === 0; t++) {
  updateSurvivor(guard3, zombies3);
  updateArrows(zombies3);
  if (bonesLost(zWall) > 0) woundTick3 = t;
}
check(woundTick3 > 0, `3: zombie BEHIND the wall wounded by a lobbed arrow (tick ${woundTick3})`);
let wallIntact = true;
for (let y = FLOOR - 14; y < FLOOR; y++) {
  if (get(222, y) !== STONE || getIntegrity(222, y) !== 0) wallIntact = false;
}
check(wallIntact, '3: the wall itself is untouched (arrows arc over it)');

// ── 4. Terrain stops arrows ──────────────────────────────────────────────────
console.log('--- 4: terrain stops arrows ---');
clear();
for (let y = 80; y < FLOOR; y++) set(300, y, STONE); // a sheer face
resetArrows();
spawnArrow(280, 120, 3, 0); // flat shot straight into the face
const zBehind = createZombie(320, FLOOR - 1);
for (let t = 0; t < 60; t++) updateArrows([zBehind]);
check(getArrows().length === 0, '4: the arrow was removed at the face');
check(bonesLost(zBehind) === 0, '4: nothing behind the face was hurt');

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(
  '\nSUMMARY: guards are archers now - closed-form low/high arcs that the integrator confirms, an 80-cell open-ground kill while holding position, an automatic lob over a wall that never touches the wall itself, and terrain that stops every arrow dead. ALL PASS',
);
