/**
 * Headless verification for p4-t1 (body materials — THE GATE foundation).
 * Imports the REAL modules (no mocks). Run via tsc (commonjs) -> node.
 */
import {
  MATERIALS,
  FLESH,
  BONE,
  BLOOD,
  WATER,
  FIRE,
  SMOKE,
  isSolidForBody,
} from '../src/engine/materials';
import { material, idx, set } from '../src/engine/grid';
import { reactions } from '../src/engine/reactions';
import { setChunkingEnabled } from '../src/engine/chunks';
import { createBody } from '../src/characters/body';

// This test calls reactions() DIRECTLY (not via step()/beginTick()), so the
// chunked active-set is never rolled. Use the full-scan reactions path here.
// (Production extinguish is covered through step() by p2-t6 + the 11-2 fire
// equivalence battery.)
setChunkingEnabled(false);

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}

// 1. Material flags.
if (MATERIALS[FLESH].flammable !== true) fail('FLESH.flammable !== true');
if (MATERIALS[BLOOD].isFluid !== true) fail('BLOOD.isFluid !== true');
if (MATERIALS[BONE].flammable !== false) fail('BONE.flammable !== false');
ok('FLESH.flammable=true, BLOOD.isFluid=true, BONE.flammable=false');

// 2. isSolidForBody.
if (isSolidForBody(BLOOD) !== false) fail('isSolidForBody(BLOOD) !== false');
if (isSolidForBody(FLESH) !== true) fail('isSolidForBody(FLESH) !== true');
ok('isSolidForBody(BLOOD)=false, isSolidForBody(FLESH)=true');

// 3a. BLOOD does NOT extinguish fire.
material.fill(0);
set(10, 10, FIRE);
set(11, 10, BLOOD); // blood adjacent to fire
reactions();
if (material[idx(10, 10)] !== FIRE) {
  fail(`FIRE next to BLOOD became ${material[idx(10, 10)]} (expected still FIRE)`);
}
ok('BLOOD does NOT extinguish fire (cell still FIRE after reactions)');

// 3b. WATER still DOES extinguish fire.
material.fill(0);
set(20, 10, FIRE);
set(21, 10, WATER);
reactions();
if (material[idx(20, 10)] !== SMOKE) {
  fail(`FIRE next to WATER became ${material[idx(20, 10)]} (expected SMOKE)`);
}
ok('WATER still extinguishes fire (FIRE -> SMOKE)');

// 4. Every createBody pixel has valid material ∈ {FLESH,BONE} and color match.
const body = createBody(200, 100);
let fleshCount = 0;
let boneCount = 0;
let total = 0;
const seen = new Set<string>();
const rx = Math.round(body.x);
const ry = Math.round(body.y);
for (const b of body.rig) {
  for (const p of b.pixels) {
    total++;
    if (p.material !== FLESH && p.material !== BONE) {
      fail(`pixel material ${p.material} not in {FLESH,BONE} (bone ${b.name})`);
    }
    if (p.color !== MATERIALS[p.material].color) {
      fail(`pixel color ${p.color} != MATERIALS[${p.material}].color (bone ${b.name})`);
    }
    if (p.material === FLESH) fleshCount++;
    else boneCount++;
    // 5. No two pixels share a world cell (regression).
    const key = `${rx + b.offset.dx + p.dx},${ry + b.offset.dy + p.dy}`;
    if (seen.has(key)) fail(`duplicate world cell ${key} (bone ${b.name})`);
    seen.add(key);
  }
}
ok(`all ${total} pixels valid material & color-matched; ${seen.size} unique world cells`);
console.log(`Counts: FLESH=${fleshCount}, BONE=${boneCount}, total=${total}`);

console.log('\nALL PASS');
