/**
 * p7-t4 — Guard combat AI / target selection (GDD §7.2 / §6.2).
 *
 * Verifies (real modules, no mocks): an armed guard engages the nearest zombie
 * in GUARD_ENGAGE_RADIUS — closes distance, LEGs the intact front rank to slow
 * it, then HEADSHOTs the crawler to finish it; a non-guard never attacks; and
 * the need/fire auto-override still wins (a thirsty guard drinks first).
 */
import { createSurvivor, updateSurvivor, assignRole } from '../src/characters/survivor';
import { createZombie, updateZombie } from '../src/characters/zombie';
import { makeTool } from '../src/game/roles';
import { material, set } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { STONE, WATER } from '../src/engine/materials';
import { WORLD_W, GUARD_ENGAGE_RADIUS, THIRST_THRESHOLD } from '../src/config';

function clearGrid() { material.fill(0); }
function floor(row: number) { for (let x = 0; x < WORLD_W; x++) set(x, row, STONE); }
function dist(a: any, b: any) {
  const dx = a.body.x - b.body.x, dy = a.body.y - b.body.y;
  return Math.sqrt(dx * dx + dy * dy);
}

const FLOOR = 150;

// =====================================================================
// T1 — guard closes the distance and its FIRST damaging hit destroys a LEG
//      of the (intact) zombie → it begins to crawl.
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
const guard1 = createSurvivor(300, FLOOR - 1);
guard1.tool = makeTool('weapon');
assignRole(guard1, 'guard');
// Spawn ONE zombie inside engage radius but not adjacent (must walk to it).
const zomb1 = createZombie(300 + 20, FLOOR - 1);
const startDist = dist(guard1, zomb1);
let closedTick = -1, legLossTick = -1;
let minDist = startDist;
for (let t = 1; t <= 1500; t++) {
  updateSurvivor(guard1, [zomb1]);
  updateZombie(zomb1, [guard1]);
  const d = dist(guard1, zomb1);
  if (d < minDist) { minDist = d; }
  if (closedTick < 0 && d < startDist - 2) closedTick = t;
  if (legLossTick < 0 && (zomb1.body.lLegLost || zomb1.body.rLegLost)) {
    legLossTick = t;
    break;
  }
}
console.log('T1 startDist', startDist.toFixed(1), 'minDist', minDist.toFixed(1),
  'closedTick', closedTick, 'firstLegLossTick', legLossTick,
  'lLegLost', zomb1.body.lLegLost, 'rLegLost', zomb1.body.rLegLost,
  'zombieAlive', zomb1.body.alive);
const t1pass = closedTick > 0 && legLossTick > 0 &&
  (zomb1.body.lLegLost || zomb1.body.rLegLost) && zomb1.body.alive;
console.log('T1 PASS guard closes + LEGs intact zombie (crawler):', t1pass);

// =====================================================================
// T2 — continue: once crawling, the guard's next strikes aim HEAD → death.
// =====================================================================
let deathTick = -1;
for (let t = legLossTick + 1; t <= legLossTick + 2000; t++) {
  updateSurvivor(guard1, [zomb1]);
  updateZombie(zomb1, [guard1]);
  if (!zomb1.body.alive) { deathTick = t; break; }
}
console.log('T2 tick-of-death', deathTick, 'zombieAlive', zomb1.body.alive);
const t2pass = deathTick > 0 && !zomb1.body.alive;
console.log('T2 PASS crawler HEADSHOT → death:', t2pass);

// =====================================================================
// T3 — a NON-guard survivor with a zombie in range does NOT attack it.
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
const civ = createSurvivor(300, FLOOR - 1); // role 'none'
const zomb3 = createZombie(305, FLOOR - 1); // adjacent
// Keep the zombie a NON-survivor target so it doesn't damage the civ back into
// confusing the assertion: we pass NO survivors to the zombie so it stays idle.
function bonesGone(b: any) { return b.rig.filter((bn: any) => bn.destroyed).length; }
const z3before = bonesGone(zomb3.body);
for (let t = 1; t <= 300; t++) {
  updateSurvivor(civ, [zomb3]);
  updateZombie(zomb3, []); // zombie idle: never attacks the civ
}
const z3after = bonesGone(zomb3.body);
console.log('T3 zombie destroyed bones before', z3before, 'after', z3after,
  'zombieAlive', zomb3.body.alive);
const t3pass = z3after === 0 && zomb3.body.alive;
console.log('T3 PASS non-guard does NOT attack:', t3pass);

// =====================================================================
// T4 — priority: a critically-thirsty guard with a zombie in range diverts to
//      seekWater FIRST (does not strike while the need override is active).
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
// Put a water pool to the LEFT of the guard, a zombie to the RIGHT (in range).
for (let x = 250; x < 256; x++) set(x, FLOOR - 1, WATER);
rebuildNavgrid();
const guard4 = createSurvivor(300, FLOOR - 1);
guard4.tool = makeTool('weapon');
assignRole(guard4, 'guard');
guard4.needs.thirst = THIRST_THRESHOLD - 1; // below threshold → seekWater wins
const zomb4 = createZombie(300 + 15, FLOOR - 1); // in engage radius, to the RIGHT
function bonesGone4() { return zomb4.body.rig.filter((b: any) => b.destroyed).length; }
let struck4 = false, behaviours = new Set<string>();
for (let t = 1; t <= 200; t++) {
  updateSurvivor(guard4, [zomb4]);
  updateZombie(zomb4, []); // keep zombie idle so it can't move/attack
  behaviours.add(guard4.behaviour);
  if (bonesGone4() > 0) { struck4 = true; break; }
}
const movedTowardWater = guard4.body.x < 300; // water is to the left
console.log('T4 behaviours seen', [...behaviours], 'struckZombie', struck4,
  'guardX', guard4.body.x.toFixed(1), 'movedTowardWater(left)', movedTowardWater,
  'thirst', guard4.needs.thirst.toFixed(1));
const t4pass = !struck4 && behaviours.has('seekWater') &&
  bonesGone4() === 0;
console.log('T4 PASS need override beats combat (no strike, seekWater):', t4pass);

console.log('\nSUMMARY',
  'T1', t1pass, 'T2', t2pass, 'T3', t3pass, 'T4', t4pass);
