import { createZombie, updateZombie } from '../src/characters/zombie';
import { createSurvivor } from '../src/characters/survivor';
import { material, set } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { STONE } from '../src/engine/materials';
import { WORLD_W, ZOMBIE_IDLE_RADIUS, SENSE_RADIUS, ZOMBIE_SPAWN_EDGE } from '../src/config';

function clearGrid() { material.fill(0); }
function floor(row: number) { for (let x = 0; x < WORLD_W; x++) set(x, row, STONE); }
function bodyInStone(b: any): boolean {
  for (const bone of b.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const wx = Math.round(b.x) + bone.offset.dx + p.dx;
      const wy = Math.round(b.y) + bone.offset.dy + p.dy;
      if (material[wy * WORLD_W + wx] === STONE) return true;
    }
  }
  return false;
}

const FLOOR = 150;

// =====================================================================
// R1 — survivor OUTSIDE senseRadius: zombie stays idle, x stays local.
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
let tunnel1 = false;
const z1 = createZombie(300, FLOOR - 1);
// Survivor far away (well beyond SENSE_RADIUS), never updated → stationary.
const farSurv = createSurvivor(300 + SENSE_RADIUS + 200, FLOOR - 1);
const startX = Math.round(z1.body.x);
let maxDev = 0, everAttacked = false;
for (let i = 0; i < 600; i++) {
  updateZombie(z1, [farSurv]);
  maxDev = Math.max(maxDev, Math.abs(Math.round(z1.body.x) - startX));
  if (z1.state === 'attack') everAttacked = true;
  if (bodyInStone(z1.body)) tunnel1 = true;
}
const endX = Math.round(z1.body.x);
// New behaviour: idle zombies DRIFT toward the colony (opposite their spawn
// edge) so the horde advances across the map. For a left-edge spawn the colony
// is to the right, so the zombie should advance (endX > startX) by a meaningful
// amount while staying idle (survivor still far beyond SENSE_RADIUS) and never
// tunnelling.
const advanceDir = ZOMBIE_SPAWN_EDGE === 'left' ? 1 : -1;
const advanced = (endX - startX) * advanceDir;
const R1_PASS = !everAttacked && z1.state === 'idle' && advanced >= 25 && !tunnel1;
console.log('R1 idle: startX', startX, 'endX', endX, 'advancedTowardColony', advanced,
  'everAttacked', everAttacked, 'tunnel', tunnel1);
console.log('R1 PASS idle drifts toward colony + no attack + no-tunnel:', R1_PASS);

// =====================================================================
// R2 — survivor INSIDE senseRadius: zombie flips to attack and closes
//      the gap monotonically until adjacent. Also measure pursuit speed.
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
let tunnel2 = false;
const z2 = createZombie(300, FLOOR - 1);
// Stationary survivor 40 cells away — inside SENSE_RADIUS (60). Never updated.
const tgt = createSurvivor(340, FLOOR - 1);
// First tick should detect + switch to attack.
updateZombie(z2, [tgt]);
const flipped = z2.state === 'attack';
const initialGap = Math.abs(Math.round(z2.body.x) - Math.round(tgt.body.x));
let prevGap = initialGap, monotone = true;
let finalGap = initialGap;
// Measure pure-approach pursuit speed: sum displacement only on ticks where the
// zombie is still closing (gap > ADJACENCY), i.e. BEFORE it stops to strike.
// (Combat-integrated updateZombie halts at ~half-body-width adjacency, gap ~6,
//  and stands still to attack — so the old `gap<=2` / post-loop speed were stale.)
const ADJACENCY = 8;
let approachDist = 0, approachTicks = 0;
let prevX = Math.round(z2.body.x);
for (let i = 0; i < 400; i++) {
  updateZombie(z2, [tgt]);
  if (bodyInStone(z2.body)) tunnel2 = true;
  const gap = Math.abs(Math.round(z2.body.x) - Math.round(tgt.body.x));
  if (gap > prevGap + 0.001) monotone = false;
  if (prevGap > ADJACENCY) { // still approaching, not yet striking
    approachDist += Math.abs(Math.round(z2.body.x) - prevX);
    approachTicks++;
  }
  prevX = Math.round(z2.body.x);
  prevGap = gap;
  finalGap = gap;
  if (gap <= ADJACENCY) break; // reached striking adjacency
}
const attackSpeed = approachTicks > 0 ? approachDist / approachTicks : 0;
const R2_PASS = flipped && finalGap < initialGap && finalGap <= ADJACENCY && monotone && !tunnel2;
console.log('R2 attack: flipped', flipped, 'initialGap', initialGap,
  'finalGap', finalGap, 'monotone(non-increasing)', monotone, 'tunnel', tunnel2);
console.log('R2 PASS detect+pursue+close-to-adjacency+no-tunnel:', R2_PASS);

// =====================================================================
// R3 — measured idle speed vs attack speed (cells/tick).
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
const zi = createZombie(300, FLOOR - 1);
// To get a clean ONE-DIRECTION idle speed, drive idle toward a fixed far goal
// by keeping no survivor in range and summing absolute displacement per tick.
let idlePath = 0;
let px = Math.round(zi.body.x);
for (let i = 0; i < 1200; i++) {
  updateZombie(zi, []);
  const nx = Math.round(zi.body.x);
  idlePath += Math.abs(nx - px);
  px = nx;
}
const idleSpeed = idlePath / 1200;
const R3_PASS = attackSpeed > idleSpeed;
console.log('R3 idleSpeed', idleSpeed.toFixed(4), 'attackSpeed(approach)', attackSpeed.toFixed(4));
console.log('R3 PASS pursuit faster than idle:', R3_PASS);

console.log('\nSUMMARY', 'R1', R1_PASS, 'R2', R2_PASS, 'R3', R3_PASS);
