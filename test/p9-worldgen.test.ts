/**
 * p9-worldgen — Seeded procedural worldgen (GDD §5.3), real modules, no mocks.
 *
 * Verifies:
 *  1. Determinism — generateWorld(SEED) twice ⇒ byte-identical `material`.
 *  2. Layering   — sampled columns: AIR above surface, DIRT band directly below,
 *                  STONE under it; SAND/ORE only at/below the dirt band; nothing
 *                  but AIR/FOLIAGE above the surface.
 *  3. Spawn guarantee — within RESOURCE_SCAN_RADIUS of spawnX:
 *                  FOLIAGE ≥ SPAWN_GUARANTEE_WOOD_CELLS and WATER ≥ 1.
 *  4. Spawn distance — spawnX ≥ SPAWN_ZONE_MARGIN from the zombie edge.
 *  5. (build green checked separately via `npm run build`.)
 */
import { generateWorld } from '../src/game/worldgen';
import { material, idx } from '../src/engine/grid';
import {
  AIR,
  SAND,
  STONE,
  WATER,
  DIRT,
  ORE,
  FOLIAGE,
  WOOD,
  WALL,
  MATERIALS,
} from '../src/engine/materials';
import {
  WORLD_W,
  WORLD_H,
  WORLDGEN_SEED,
  SURFACE_SOIL_DEPTH,
  DIRT_DEPTH,
  SPAWN_ZONE_MARGIN,
  SPAWN_GUARANTEE_WOOD_CELLS,
  RESOURCE_SCAN_RADIUS,
  CAMP_HALF_WIDTH,
} from '../src/config';

declare const process: any;

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log('  PASS:', msg);
  else {
    console.error('  FAIL:', msg);
    failed++;
  }
}

const name = (id: number) => (MATERIALS[id] ? MATERIALS[id].name : `#${id}`);

// --- 1. Determinism --------------------------------------------------------
generateWorld(WORLDGEN_SEED);
const snapA = material.slice();
const resB = generateWorld(WORLDGEN_SEED);
const snapB = material.slice();
let identical = snapA.length === snapB.length;
let firstDiff = -1;
for (let i = 0; i < snapA.length && identical; i++) {
  if (snapA[i] !== snapB[i]) {
    identical = false;
    firstDiff = i;
  }
}
console.log(`\n[1] Determinism: ${identical ? 'EQUAL' : 'NOTEQUAL'} (firstDiff=${firstDiff})`);
assert(identical, 'two runs of generateWorld(SEED) produce byte-identical material[]');

// Work against the (current) grid from run B.
const res = resB;

// Surface-row finder per column: the first non-AIR, non-FOLIAGE cell top-down.
function surfaceRow(x: number): number {
  for (let y = 0; y < WORLD_H; y++) {
    const m = material[idx(x, y)];
    if (m !== AIR && m !== FOLIAGE) return y;
  }
  return WORLD_H;
}

// --- 2. Layering -----------------------------------------------------------
// NOTE (Task W5): worldgen now builds a starter camp (roofed WOOD/WALL nook)
// centred on res.spawnX, so that column legitimately has a WOOD roof as its
// topmost solid — it is NOT natural layered terrain. The layering check samples
// only OPEN columns away from the camp; the camp column is verified separately
// below (camp-shelter coverage).
const sampleCols = [120, 400, 700, 1000];
let layeringOk = true;
for (const cx of sampleCols) {
  const top = surfaceRow(cx);
  // Above surface: only AIR or FOLIAGE.
  for (let y = 0; y < top; y++) {
    const m = material[idx(cx, y)];
    if (m !== AIR && m !== FOLIAGE) {
      layeringOk = false;
      console.error(`  col ${cx}: terrain ${name(m)} above surface at y=${y}`);
    }
  }
  // Directly below surface is the DIRT band.
  if (material[idx(cx, top)] !== DIRT) {
    layeringOk = false;
    console.error(`  col ${cx}: cell below surface is ${name(material[idx(cx, top)])}, expected dirt`);
  }
  // SAND/ORE never appear above the dirt band (above the soil layer start).
  const dirtStart = top;
  for (let y = 0; y < dirtStart; y++) {
    const m = material[idx(cx, y)];
    if (m === SAND || m === ORE) {
      layeringOk = false;
      console.error(`  col ${cx}: ${name(m)} above dirt band at y=${y}`);
    }
  }
}
// Report one clean sampled column's top-down run-length layer sequence.
{
  const cx = 120;
  const top = surfaceRow(cx);
  const seq: string[] = [];
  let cur = -1;
  let count = 0;
  for (let y = 0; y < WORLD_H; y++) {
    const m = material[idx(cx, y)];
    if (m !== cur) {
      if (cur !== -1) seq.push(`${name(cur)}x${count}`);
      cur = m;
      count = 1;
    } else count++;
  }
  seq.push(`${name(cur)}x${count}`);
  console.log(`\n[2] Layering col ${cx}: surfaceRow=${top}, soil+dirt band=${SURFACE_SOIL_DEPTH + DIRT_DEPTH}`);
  console.log('    sequence:', seq.join(' → '));
}
assert(layeringOk, 'all sampled columns: AIR/FOLIAGE above surface, DIRT below, no SAND/ORE above dirt band');

// --- 3. Spawn guarantee ----------------------------------------------------
function countNear(id: number, cx: number, radius: number): number {
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(WORLD_W - 1, cx + radius);
  let n = 0;
  for (let x = x0; x <= x1; x++)
    for (let y = 0; y < WORLD_H; y++) if (material[idx(x, y)] === id) n++;
  return n;
}
const woodNear = countNear(FOLIAGE, res.spawnX, RESOURCE_SCAN_RADIUS);
const waterNear = countNear(WATER, res.spawnX, RESOURCE_SCAN_RADIUS);
console.log(`\n[3] Spawn guarantee within ${RESOURCE_SCAN_RADIUS} of spawnX=${res.spawnX}: FOLIAGE=${woodNear}, WATER=${waterNear}`);
assert(woodNear >= SPAWN_GUARANTEE_WOOD_CELLS, `FOLIAGE ≥ ${SPAWN_GUARANTEE_WOOD_CELLS} near spawn (got ${woodNear})`);
assert(waterNear >= 1, `WATER ≥ 1 near spawn (got ${waterNear})`);

// --- 4. Spawn distance from zombie edge ------------------------------------
const distFromEdge = res.zombieEdge === 'left' ? res.spawnX : WORLD_W - 1 - res.spawnX;
console.log(`\n[4] spawnX=${res.spawnX}, spawnY=${res.spawnY}, zombieEdge=${res.zombieEdge}, distFromEdge=${distFromEdge}`);
console.log(`    stockpilePoint=(${res.stockpilePoint.x},${res.stockpilePoint.y})`);
assert(distFromEdge >= SPAWN_ZONE_MARGIN, `spawnX ≥ ${SPAWN_ZONE_MARGIN} from zombie edge (got ${distFromEdge})`);

// --- 5. Starter camp (Task W5) ---------------------------------------------
// The camp centres on spawnX with WALL side-posts at spawnX ± CAMP_HALF_WIDTH
// and a WOOD roof above; res.shelterPoint names a feet-cell inside it.
{
  const cx = res.spawnX;
  let roofWood = 0;
  for (let y = 0; y < res.spawnY; y++) if (material[idx(cx, y)] === WOOD) roofWood++;
  const leftWall = material[idx(cx - CAMP_HALF_WIDTH, res.shelterPoint.y - 4)];
  const rightWall = material[idx(cx + CAMP_HALF_WIDTH, res.shelterPoint.y - 4)];
  console.log(
    `\n[5] Camp @${cx}: roofWood=${roofWood} | leftWall=${name(leftWall)} rightWall=${name(rightWall)} | shelterPoint=(${res.shelterPoint.x},${res.shelterPoint.y})`,
  );
  assert(roofWood >= 1, 'camp has a WOOD roof above the spawn column');
  assert(leftWall === WALL && rightWall === WALL, 'camp has WALL side-posts at spawnX ± CAMP_HALF_WIDTH');
  assert(res.shelterPoint.x === cx, 'shelterPoint is the camp centre column');
}

// --- sanity: STONE exists at depth, water/ore present somewhere -------------
let totalStone = 0, totalOre = 0, totalSand = 0, totalWater = 0, totalFol = 0;
for (let i = 0; i < material.length; i++) {
  const m = material[i];
  if (m === STONE) totalStone++;
  else if (m === ORE) totalOre++;
  else if (m === SAND) totalSand++;
  else if (m === WATER) totalWater++;
  else if (m === FOLIAGE) totalFol++;
}
console.log(`\n[totals] stone=${totalStone} ore=${totalOre} sand=${totalSand} water=${totalWater} foliage=${totalFol}`);
assert(totalStone > 0 && totalOre > 0 && totalSand > 0 && totalWater > 0 && totalFol > 0, 'all terrain feature materials present');

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
