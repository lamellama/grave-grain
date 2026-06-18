/**
 * Headless verification for p3-t1 (characters/body.ts).
 * Imports the REAL module (no mocks). Run via tsc (commonjs) -> node.
 */
import { createBody, type Body } from '../src/characters/body';
import { BODY_W, BODY_H } from '../src/config';

const SPAWN_X = 200;
const SPAWN_Y = 100;
const body: Body = createBody(SPAWN_X, SPAWN_Y);

const REQUIRED = ['head', 'torso', 'lArm', 'rArm', 'lLeg', 'rLeg'];

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}

// 1. rig.length === 6 with all six named bones present.
if (body.rig.length !== 6) fail(`rig.length = ${body.rig.length}, expected 6`);
const names: string[] = body.rig.map((b) => b.name).sort();
for (const r of REQUIRED) {
  if (!names.includes(r)) fail(`missing bone: ${r}`);
}
console.log('PASS: 6 bones present:', body.rig.map((b) => b.name).join(', '));

// 2. Every bone has non-empty pixels and destroyed === false.
let total = 0;
for (const b of body.rig) {
  if (b.pixels.length === 0) fail(`bone ${b.name} has no pixels`);
  if (b.destroyed !== false) fail(`bone ${b.name} destroyed !== false`);
  total += b.pixels.length;
}
console.log('PASS: all bones non-empty & destroyed=false');

// 3. Total pixel count is chunky (40–120).
if (total < 40 || total > 120) fail(`total pixels = ${total}, expected 40–120`);
console.log('Total pixel count =', total);

// 4. No two pixels share the same world cell (sum offsets across all bones).
const rx = Math.round(body.x);
const ry = Math.round(body.y);
const seen = new Set<string>();
let minDX = Infinity;
let maxDX = -Infinity;
let minDY = Infinity;
let maxDY = -Infinity;
let lowestDY = -Infinity; // most-positive dy = lowest pixel (feet)
for (const b of body.rig) {
  for (const p of b.pixels) {
    const wx = rx + b.offset.dx + p.dx;
    const wy = ry + b.offset.dy + p.dy;
    const key = `${wx},${wy}`;
    if (seen.has(key)) fail(`duplicate world cell at ${key} (bone ${b.name})`);
    seen.add(key);
    const odx = b.offset.dx + p.dx;
    const ody = b.offset.dy + p.dy;
    minDX = Math.min(minDX, odx);
    maxDX = Math.max(maxDX, odx);
    minDY = Math.min(minDY, ody);
    maxDY = Math.max(maxDY, ody);
    lowestDY = Math.max(lowestDY, ody);
  }
}
console.log('PASS: all', seen.size, 'world cells unique');

// 5. Bounding box ≈ BODY_W × BODY_H (within ~1–2 cells).
const bw = maxDX - minDX + 1;
const bh = maxDY - minDY + 1;
console.log(`Bounding box = ${bw} × ${bh}  (config BODY_W×BODY_H = ${BODY_W}×${BODY_H})`);
if (Math.abs(bw - BODY_W) > 2) fail(`width ${bw} not ≈ BODY_W ${BODY_W}`);
if (Math.abs(bh - BODY_H) > 2) fail(`height ${bh} not ≈ BODY_H ${BODY_H}`);
console.log(`Feet (lowest) pixel offset dy = ${lowestDY} (anchor = feet-centre, expect ≈0)`);

// 6. Initial dynamic state.
if (body.alive !== true) fail('alive !== true');
if (body.grounded !== false) fail('grounded !== false');
if (body.vy !== 0) fail('vy !== 0');
if (body.facing !== 1) fail('facing !== 1');
if (body.moveDir !== 0) fail('moveDir !== 0');
console.log('PASS: alive=true grounded=false vy=0 facing=1 moveDir=0');

console.log('\nALL PASS');
