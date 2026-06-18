/**
 * Headless verification for p4-t2 (Damage→cells handoff — THE GATE).
 * Imports the REAL modules (no mocks). Run via tsc (commonjs) -> node.
 */
import { WORLD_W, WORLD_H } from '../src/config';
import {
  FLESH,
  BONE,
  BLOOD,
  STONE,
  AIR,
} from '../src/engine/materials';
import { material, idx, set } from '../src/engine/grid';
import { step } from '../src/engine/simulation';
import { createBody, type Bone } from '../src/characters/body';
import { releaseBone } from '../src/characters/damage';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}
function getBone(body: ReturnType<typeof createBody>, name: string): Bone {
  const b = body.rig.find((r) => r.name === name);
  if (!b) fail(`bone ${name} not found`);
  return b!;
}

const FLOOR_Y = 130;

function isBodyMat(m: number): boolean {
  return m === FLESH || m === BONE;
}

// --- Setup: stone floor + a body resting on it -----------------------------
material.fill(0);
// Solid stone floor row.
for (let x = 0; x < WORLD_W; x++) set(x, FLOOR_Y, STONE);

// Place the body grounded: feet-centre just above the floor.
const body = createBody(120, FLOOR_Y - 1);
const rx = Math.round(body.x);
const ry = Math.round(body.y);

const lLeg = getBone(body, 'lLeg');

// Record the leg's intended world cells + the floor cells it overlaps in x.
const legCells: Array<{ x: number; y: number; mat: number }> = [];
for (const p of lLeg.pixels) {
  legCells.push({
    x: rx + lLeg.offset.dx + p.dx,
    y: ry + lLeg.offset.dy + p.dy,
    mat: p.material,
  });
}

// Snapshot the entire floor row before release (must be untouched after).
const floorBefore: number[] = [];
for (let x = 0; x < WORLD_W; x++) floorBefore.push(material[idx(x, FLOOR_Y)]);

// --- 1. Release the leg ----------------------------------------------------
const released = releaseBone(body, lLeg);
console.log(`released cell count = ${released}`);
if (released <= 0) fail('releaseBone returned 0 on a fresh bone');
if (lLeg.destroyed !== true) fail('lLeg.destroyed !== true after release');
ok(`lLeg released ${released} cells, destroyed=true`);

// Released cells present in grid (≈ released count).
let presentBody = 0;
for (const c of legCells) {
  if (isBodyMat(material[idx(c.x, c.y)])) presentBody++;
}
if (presentBody < released) {
  fail(`only ${presentBody} body cells present, expected >= ${released}`);
}
ok(`${presentBody} FLESH/BONE cells present at the leg footprint`);

// >= 1 BLOOD cell present.
let bloodCount = 0;
for (let i = 0; i < material.length; i++) if (material[i] === BLOOD) bloodCount++;
if (bloodCount < 1) fail('no BLOOD cell emitted');
ok(`${bloodCount} BLOOD cell(s) emitted`);

// Floor not overwritten.
for (let x = 0; x < WORLD_W; x++) {
  if (material[idx(x, FLOOR_Y)] !== floorBefore[x]) {
    fail(`floor cell (${x},${FLOOR_Y}) changed from ${floorBefore[x]} to ${material[idx(x, FLOOR_Y)]}`);
  }
}
ok('stone floor row unchanged (no terrain clobbered)');

// --- 2. Step the sim: cells fall + pile, mass conserved, no tunnelling ------
function countBodyMat(): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (isBodyMat(material[i])) n++;
  return n;
}
function meanBodyY(): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      if (isBodyMat(material[idx(x, y)])) {
        sum += y;
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}

const massBefore = countBodyMat();
const meanYBefore = meanBodyY();

for (let t = 0; t < 40; t++) step();

const massAfter = countBodyMat();
const meanYAfter = meanBodyY();

if (massAfter !== massBefore) {
  fail(`body-material mass changed ${massBefore} -> ${massAfter} (not conserved)`);
}
ok(`body-material mass conserved (${massAfter})`);

if (!(meanYAfter > meanYBefore)) {
  fail(`cells did not fall: meanY ${meanYBefore.toFixed(2)} -> ${meanYAfter.toFixed(2)}`);
}
ok(`cells fell + piled (meanY ${meanYBefore.toFixed(2)} -> ${meanYAfter.toFixed(2)})`);

// No tunnelling: no body cell below the floor row.
let belowFloor = 0;
for (let y = FLOOR_Y + 1; y < WORLD_H; y++) {
  for (let x = 0; x < WORLD_W; x++) {
    if (isBodyMat(material[idx(x, y)])) belowFloor++;
  }
}
if (belowFloor > 0) fail(`${belowFloor} body cells tunnelled below the floor`);
ok('no tunnelling: 0 body cells below the floor');

// Floor still intact after stepping.
let floorIntact = 0;
for (let x = 0; x < WORLD_W; x++) if (material[idx(x, FLOOR_Y)] === STONE) floorIntact++;
if (floorIntact !== WORLD_W) fail(`floor degraded: ${floorIntact}/${WORLD_W} STONE cells remain`);
ok(`floor intact after 40 steps (${floorIntact}/${WORLD_W} STONE)`);

// --- 3. Idempotent re-release ----------------------------------------------
const massPreRe = countBodyMat();
const bloodPreRe = (() => {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === BLOOD) n++;
  return n;
})();
const again = releaseBone(body, lLeg);
if (again !== 0) fail(`re-release returned ${again}, expected 0`);
const massPostRe = countBodyMat();
let bloodPostRe = 0;
for (let i = 0; i < material.length; i++) if (material[i] === BLOOD) bloodPostRe++;
if (massPostRe !== massPreRe) fail('re-release changed body-material mass');
if (bloodPostRe !== bloodPreRe) fail('re-release changed blood count');
ok('idempotent: re-release returned 0, no grid change');

console.log('\nALL PASS');
console.log(`SUMMARY: released=${released}, blood=${bloodCount}, mass=${massAfter}, belowFloor=${belowFloor}`);
