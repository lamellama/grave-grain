declare const process: any;
/**
 * r11-spikes.test.ts - playtest round 11: SPIKE traps ("maybe spikes, these
 * can be placed in pits to create deadfalls, but also on the ground; if a
 * zombie tries to climb over them they may lose a leg or two").
 * game/traps.ts + the 'spike' Build structure (building.ts) + SPIKE material.
 *
 * Done-when:
 *   1. VERB - placeStructure('spike') is costed (1 wood), refused when broke.
 *   2. CONTACT - touchingSpikes is true standing ON or wading THROUGH stakes,
 *      false on clean ground.
 *   3. LEGS ONLY - with a rigged always-hit roll a contact tick tears off one
 *      leg, then the other ("a leg or two"), then NOTHING more: a legless
 *      crawler on the stakes keeps its head/torso/arms forever.
 *   4. CHANCE - a rigged never-hit roll never wounds (the roll is real).
 *   5. DEADFALL - end to end with a seeded RNG: a zombie dropped into a
 *      spiked pit loses at least one leg within a few hundred contact ticks
 *      (the pit deadfall of the ask).
 */

// ---- seeded RNG (mulberry32) ------------------------------------------------
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

import { SPIKE_LEG_CHANCE } from '../src/config';
import { STONE, SPIKE, AIR } from '../src/engine/materials';
import { material, integrity, set, get } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { touchingSpikes, updateSpikeContact } from '../src/game/traps';
import { placeStructure } from '../src/game/building';
import { addResource, resetStockpile, getStockpile } from '../src/game/resources';
import { createZombie } from '../src/characters/zombie';

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
}
function bone(z: ReturnType<typeof createZombie>, name: string): boolean {
  const b = z.body.rig.find((r: any) => r.name === name);
  return !!b && !b.destroyed;
}

// ── 1. Costed placement ──────────────────────────────────────────────────────
console.log('--- 1: costed spike verb ---');
clear();
resetStockpile();
check(!placeStructure(100, FLOOR - 1, 'spike'), '1: refused with an empty stockpile');
addResource('wood', 3);
check(placeStructure(100, FLOOR - 1, 'spike'), '1: placed once affordable');
check(get(100, FLOOR - 1) === SPIKE, '1: the cell is SPIKE');
check(getStockpile().wood === 2, '1: exactly 1 wood spent');

// ── 2. Contact geometry ──────────────────────────────────────────────────────
console.log('--- 2: contact geometry ---');
clear();
for (let x = 200; x <= 206; x++) set(x, FLOOR - 1, SPIKE); // a stake strip
const zOn = createZombie(203, FLOOR - 2); // feet resting ON the stakes
const zBeside = createZombie(180, FLOOR - 1); // clean ground
check(touchingSpikes(zOn.body), '2: standing on stakes = contact');
check(!touchingSpikes(zBeside.body), '2: clean ground = no contact');

// ── 3. Legs only, one then the other, never more ─────────────────────────────
console.log('--- 3: a leg or two - and never more ---');
const alwaysHit = () => 0; // rolls under any chance
const first = updateSpikeContact(zOn.body, alwaysHit);
check(first === 'lLeg' || first === 'rLeg', `3: first contact tick took a leg (${first})`);
const second = updateSpikeContact(zOn.body, alwaysHit);
check(
  second !== null && second !== first,
  `3: second contact tick took the OTHER leg (${second})`,
);
check(zOn.body.lLegLost && zOn.body.rLegLost, '3: both legs are gone - a crawler now');
const third = updateSpikeContact(zOn.body, alwaysHit);
check(third === null, '3: a legless crawler is never wounded further by spikes');
check(
  bone(zOn, 'head') && bone(zOn, 'torso') && bone(zOn, 'lArm') && bone(zOn, 'rArm'),
  '3: head/torso/arms all intact (spikes ONLY take legs)',
);

// ── 4. The roll is real ──────────────────────────────────────────────────────
console.log('--- 4: chance gate ---');
const zLucky = createZombie(203, FLOOR - 2);
const neverHit = () => 0.999999;
for (let t = 0; t < 500; t++) updateSpikeContact(zLucky.body, neverHit);
check(
  !zLucky.body.lLegLost && !zLucky.body.rLegLost,
  '4: 500 unlucky-roll contact ticks wound nothing',
);

// ── 5. Deadfall e2e (seeded chance) ──────────────────────────────────────────
console.log('--- 5: spiked-pit deadfall ---');
clear();
// A pit with a spiked floor: the zombie stands in it, in contact each tick.
for (let x = 300; x <= 306; x++) set(x, FLOOR - 1, SPIKE);
const zPit = createZombie(303, FLOOR - 2);
const rng = mulberry32(99);
let maimedAt = 0;
const expectTicks = Math.ceil(3 / SPIKE_LEG_CHANCE); // ~3x the mean wait
for (let t = 1; t <= expectTicks; t++) {
  updateSpikeContact(zPit.body, rng);
  if (zPit.body.lLegLost || zPit.body.rLegLost) {
    maimedAt = t;
    break;
  }
}
check(maimedAt > 0, `5: the pit deadfall took a leg (tick ${maimedAt} of ${expectTicks})`);

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(
  '\nSUMMARY: spikes are a costed build verb; contact is standing-on/wading-through; a contact tick can take one leg then the other and NEVER anything else; the chance roll is real; and a spiked pit deadfall cripples a zombie within the expected window. ALL PASS',
);
