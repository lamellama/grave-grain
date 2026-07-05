/**
 * p7-t4 - Guard combat AI / target selection (GDD 7.2 / 6.2).
 *
 * Guards are ARCHERS (not brawlers): an armed guard HOLDS its defensive point
 * and looses arcing arrows at any zombie inside GUARD_ENGAGE_RADIUS, wounding
 * whatever body region each arrow lands on (launchArrow -> updateArrows -> THE
 * GATE). Verifies (real modules, no mocks): the guard volleys a zombie down
 * FROM RANGE without chasing it into melee; a non-guard never attacks; and the
 * need/fire auto-override still wins (a thirsty guard drinks first, no shots).
 */
import { createSurvivor, updateSurvivor, assignRole } from '../src/characters/survivor';
import { createZombie, updateZombie } from '../src/characters/zombie';
import { makeTool } from '../src/game/roles';
import { setStockpilePoint } from '../src/game/resources';
import { updateArrows, getArrows, resetArrows } from '../src/game/projectiles';
import { material, set } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { STONE, WATER } from '../src/engine/materials';
import { WORLD_W, THIRST_THRESHOLD } from '../src/config';

function clearGrid() { material.fill(0); }
function floor(row: number) { for (let x = 0; x < WORLD_W; x++) set(x, row, STONE); }
function dist(a: any, b: any) {
  const dx = a.body.x - b.body.x, dy = a.body.y - b.body.y;
  return Math.sqrt(dx * dx + dy * dy);
}
function bonesGone(b: any) { return b.rig.filter((bn: any) => bn.destroyed).length; }

const FLOOR = 150;

// =====================================================================
// T1 - the archer guard HOLDS its point and volleys a zombie down FROM RANGE.
//      The zombie is kept idle (out of its own reach) so the test isolates the
//      guard's ranged kill: an arrow must wound the zombie, it must die, and the
//      guard must NOT have closed to melee (it stays on its hold point).
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
resetArrows();
setStockpilePoint(300, FLOOR - 1); // the guard's defensive hold point == its spawn
const guard1 = createSurvivor(300, FLOOR - 1);
guard1.tool = makeTool('weapon');
assignRole(guard1, 'guard');
// One zombie inside engage radius; kept IDLE (no survivors passed to it) so it
// never advances into bite range - the guard must reach out and drop it.
const zomb1 = createZombie(320, FLOOR - 1);
const startDist = dist(guard1, zomb1);
let woundTick = -1, deathTick = -1, firedTick = -1;
let maxClose = startDist; // smallest gap the guard ever let open (min distance)
for (let t = 1; t <= 4000; t++) {
  updateSurvivor(guard1, [zomb1]);
  updateArrows([zomb1]);       // advance this tick's shots + resolve impacts
  updateZombie(zomb1, []);     // zombie idle: it neither moves nor bites
  if (firedTick < 0 && getArrows().length > 0) firedTick = t;
  const d = dist(guard1, zomb1);
  if (d < maxClose) maxClose = d;
  if (woundTick < 0 && bonesGone(zomb1.body) > 0) woundTick = t;
  if (!zomb1.body.alive) { deathTick = t; break; }
}
console.log('T1 startDist', startDist.toFixed(1), 'minGap', maxClose.toFixed(1),
  'firstFire', firedTick, 'firstWound', woundTick, 'death', deathTick,
  'guardX', guard1.body.x.toFixed(1), 'zombieAlive', zomb1.body.alive);
// Ranged kill: fired an arrow, wounded a region, killed it - all while the guard
// stayed put (it never crossed most of the gap to reach melee range).
const stayedAtRange = Math.abs(guard1.body.x - 300) <= 3 && maxClose > startDist - 6;
const t1pass = firedTick > 0 && woundTick > 0 && deathTick > 0 &&
  !zomb1.body.alive && stayedAtRange;
console.log('T1 PASS archer guard volleys a zombie down from range (no chase):', t1pass);

// =====================================================================
// T2 - region-specific: the killing wound came from arrows destroying body
//      regions (>=1 bone released), i.e. damage flowed through THE GATE rather
//      than a bare HP counter. (Death in T1 already implies dissolve.)
// =====================================================================
const t2pass = bonesGone(zomb1.body) > 0 && !zomb1.body.alive;
console.log('T2 PASS kill came from region wounds (bones released):', t2pass);

// =====================================================================
// T3 - a NON-guard survivor with a zombie in range does NOT attack it.
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
resetArrows();
const civ = createSurvivor(300, FLOOR - 1); // role 'none'
const zomb3 = createZombie(305, FLOOR - 1); // adjacent
const z3before = bonesGone(zomb3.body);
for (let t = 1; t <= 300; t++) {
  updateSurvivor(civ, [zomb3]);
  updateArrows([zomb3]);
  updateZombie(zomb3, []); // zombie idle: never attacks the civ
}
const z3after = bonesGone(zomb3.body);
console.log('T3 zombie destroyed bones before', z3before, 'after', z3after,
  'arrowsInFlight', getArrows().length, 'zombieAlive', zomb3.body.alive);
const t3pass = z3after === 0 && zomb3.body.alive && getArrows().length === 0;
console.log('T3 PASS non-guard does NOT attack (fires nothing):', t3pass);

// =====================================================================
// T4 - priority: a critically-thirsty guard with a zombie in range diverts to
//      seekWater FIRST (does not shoot while the need override is active).
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
resetArrows();
// Put a water pool to the LEFT of the guard, a zombie to the RIGHT (in range).
for (let x = 250; x < 256; x++) set(x, FLOOR - 1, WATER);
rebuildNavgrid();
setStockpilePoint(300, FLOOR - 1);
const guard4 = createSurvivor(300, FLOOR - 1);
guard4.tool = makeTool('weapon');
assignRole(guard4, 'guard');
guard4.needs.thirst = THIRST_THRESHOLD - 1; // below threshold -> seekWater wins
const zomb4 = createZombie(300 + 15, FLOOR - 1); // in engage radius, to the RIGHT
function bonesGone4() { return zomb4.body.rig.filter((b: any) => b.destroyed).length; }
let struck4 = false; const behaviours = new Set<string>();
for (let t = 1; t <= 200; t++) {
  updateSurvivor(guard4, [zomb4]);
  updateArrows([zomb4]);
  updateZombie(zomb4, []); // keep zombie idle so it can't move/attack
  behaviours.add(guard4.behaviour);
  if (bonesGone4() > 0) { struck4 = true; break; }
}
const movedTowardWater = guard4.body.x < 300; // water is to the left
console.log('T4 behaviours seen', [...behaviours], 'struckZombie', struck4,
  'arrowsFired', getArrows().length, 'guardX', guard4.body.x.toFixed(1),
  'movedTowardWater(left)', movedTowardWater, 'thirst', guard4.needs.thirst.toFixed(1));
const t4pass = !struck4 && behaviours.has('seekWater') && bonesGone4() === 0;
console.log('T4 PASS need override beats combat (no shot, seekWater):', t4pass);

console.log('\nSUMMARY',
  'T1', t1pass, 'T2', t2pass, 'T3', t3pass, 'T4', t4pass);
if (!(t1pass && t2pass && t3pass && t4pass)) {
  throw new Error('p7-t4 FAILED');
}
