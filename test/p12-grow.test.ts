/**
 * test/p12-grow.test.ts — plant-a-seed foliage growth (post-MVP backlog,
 * playtest v0.6 #G; GDD §9). The player plants a SAPLING (id 15) on soil; it
 * matures into FOLIAGE over time and sprouts upward into a bush, capped at
 * FOLIAGE_GROW_MAX_HEIGHT. This is a NEW cellular-sim rule, so the bar is the
 * same as every other sim rule: it must be DETERMINISTIC and the chunked /
 * dirty-rect scan (chunking ON) must stay BYTE-IDENTICAL to a full scan
 * (chunking OFF).
 *
 * Done-when:
 *   1. Grows: a sapling on DIRT becomes FOLIAGE and the plant grows upward; the
 *      FOLIAGE count climbs over time up to the max height, then stops.
 *   2. Determinism / chunk-equivalence: OFF == ON byte-for-byte at checkpoints.
 *   3. Soil rule: a floating sapling (no soil below) does NOT tower — it withers.
 *
 * Real engine modules, fresh module graph per run (busts the require-cache so
 * tick / grid / chunk bitsets reset to tick-0). tsc → node.
 */

import '../src/engine/simulation';

declare const require: {
  (m: string): any;
  cache: Record<string, unknown>;
  resolve(m: string): string;
};
declare const process: any;

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}

function freshSim() {
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf('.test-out') !== -1) delete require.cache[k];
  }
  const config = require('../src/config');
  const grid = require('../src/engine/grid');
  const mats = require('../src/engine/materials');
  const chunks = require('../src/engine/chunks');
  const sim = require('../src/engine/simulation');
  return { config, grid, mats, chunks, sim };
}
type Sim = ReturnType<typeof freshSim>;

// ---------------------------------------------------------------------------
// Scene: a DIRT soil bed with ONE sapling planted on top of its centre column.
// Fixed constants → both chunking modes seed byte-identically.
// ---------------------------------------------------------------------------
const SOIL_Y = 150; // top dirt row
const SOIL_X0 = 100;
const SOIL_X1 = 140;
const PLANT_X = 120; // the single sapling sits at (PLANT_X, SOIL_Y - 1)
const PLANT_Y = SOIL_Y - 1;

function seedSoil(s: Sim): void {
  const { grid, mats } = s;
  grid.material.fill(0);
  grid.integrity.fill(0);
  // STONE floor so the (powder) DIRT bed rests instead of cascading away.
  for (let x = SOIL_X0; x <= SOIL_X1 + 4; x++) grid.set(x, SOIL_Y + 4, mats.STONE);
  // A few rows of DIRT soil so the sapling has somewhere to root.
  for (let y = SOIL_Y; y < SOIL_Y + 4; y++)
    for (let x = SOIL_X0; x <= SOIL_X1; x++) grid.set(x, y, mats.DIRT);
}

function seedPlant(s: Sim): void {
  seedSoil(s);
  // Plant one sapling on the soil (integrity 0 → updateSapling auto-seeds timer).
  s.grid.set(PLANT_X, PLANT_Y, s.mats.SAPLING);
}

// A FLOATING sapling: sapling in mid-air with AIR below (no soil) → must wither.
const FLOAT_X = 200;
const FLOAT_Y = 80;
function seedFloating(s: Sim): void {
  const { grid, mats } = s;
  grid.material.fill(0);
  grid.integrity.fill(0);
  grid.set(FLOAT_X, FLOAT_Y, mats.SAPLING);
}

function countMat(s: Sim, id: number): number {
  let n = 0;
  for (let i = 0; i < s.grid.material.length; i++) if (s.grid.material[i] === id) n++;
  return n;
}

function snapshot(s: Sim): Uint8Array {
  const n = s.grid.material.length;
  const snap = new Uint8Array(n * 2);
  snap.set(s.grid.material, 0);
  snap.set(s.grid.integrity, n);
  return snap;
}

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

// ===========================================================================
// 1. GROWS — sapling → oak trunk, climbing upward to TREE_TRUNK_MAX, then stops.
// ===========================================================================
{
  const s = freshSim();
  s.sim.setChunkingEnabled(false);
  seedPlant(s);
  const MAX = s.config.TREE_TRUNK_MAX;

  // Sample the trunk count over time so we can report the growth curve.
  const SAMPLE_EVERY = 240;
  // > MAX stages × (GROW_TICKS+jitter) so it fully matures.
  const TOTAL = (MAX + 2) * (s.config.GROW_TICKS + s.config.GROW_JITTER);
  const curve: Array<{ t: number; trunk: number; sapling: number }> = [];
  let everSapling = false;
  for (let t = 1; t <= TOTAL; t++) {
    s.sim.step();
    if (countMat(s, s.mats.SAPLING) > 0) everSapling = true;
    if (t % SAMPLE_EVERY === 0) {
      curve.push({ t, trunk: countMat(s, s.mats.TRUNK), sapling: countMat(s, s.mats.SAPLING) });
    }
  }

  const finalTrunk = countMat(s, s.mats.TRUNK);
  const finalSapling = countMat(s, s.mats.SAPLING);
  const finalFoliage = countMat(s, s.mats.FOLIAGE);

  console.log('GROWTH CURVE (tick : trunk cells : live saplings):');
  for (const p of curve) console.log(`  t=${String(p.t).padStart(4)}  trunk=${p.trunk}  sapling=${p.sapling}`);
  console.log(`  final: trunk=${finalTrunk} foliage=${finalFoliage} sapling=${finalSapling} (cap=${MAX})`);

  // (a) The tree actually grew: trunk exists.
  if (finalTrunk < 1) fail('sapling never matured into TRUNK');
  // (b) It grew UPWARD into a multi-cell trunk (more than just the seed cell).
  if (finalTrunk < 2) fail('tree did not grow upward (only one trunk cell)');
  // (c) Trunk climbed over time (monotonic non-decreasing across samples).
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].trunk < curve[i - 1].trunk)
      fail(`trunk count went DOWN (t=${curve[i].t}: ${curve[i].trunk} < ${curve[i - 1].trunk})`);
  }
  // (d) It STOPPED at the cap (trunk column === MAX, no live growing tip left).
  if (finalTrunk !== MAX) fail(`trunk height ${finalTrunk} !== TREE_TRUNK_MAX ${MAX}`);
  if (finalSapling !== 0) fail(`tree never stopped — ${finalSapling} live saplings remain at the cap`);
  if (!everSapling) fail('SAPLING never observed (auto-seed/dispatch broken)');
  // (e) A crowned oak wears leaves.
  if (finalFoliage < 12) fail(`crowned oak has a sparse canopy (${finalFoliage} FOLIAGE cells)`);

  // The growth must form a contiguous vertical TRUNK column above the soil.
  let col = 0;
  for (let y = PLANT_Y; y >= 0 && s.grid.material[y * s.config.WORLD_W + PLANT_X] === s.mats.TRUNK; y--) col++;
  if (col !== finalTrunk) fail(`trunk is not a single contiguous column (col=${col}, total=${finalTrunk})`);
  ok(`grows: sapling → ${finalTrunk}-cell TRUNK oak with ${finalFoliage}-leaf canopy (cap ${MAX}), climbed monotonically, then stopped`);
}

// ===========================================================================
// 2. DETERMINISM / CHUNK-EQUIVALENCE (CRITICAL) — OFF == ON byte-for-byte.
// ===========================================================================
{
  const CHECKPOINTS = [50, 300, 900, 1800, 3000];
  const last = CHECKPOINTS[CHECKPOINTS.length - 1];

  function run(chunking: boolean): Record<number, Uint8Array> {
    const s = freshSim();
    s.sim.setChunkingEnabled(chunking);
    // Combined scene: a growing plant AND a floating sapling AND a water-fed
    // plant, so the equivalence covers maturation, sprouting, withering and the
    // water-speedup branch all at once.
    seedSoil(s);
    s.grid.set(PLANT_X, PLANT_Y, s.mats.SAPLING);
    s.grid.set(FLOAT_X, FLOAT_Y, s.mats.SAPLING); // floating → withers
    // Water-fed plant: a sapling on dirt with a WATER cell beside it.
    s.grid.set(130, PLANT_Y, s.mats.SAPLING);
    s.grid.set(131, PLANT_Y, s.mats.WATER);
    const out: Record<number, Uint8Array> = {};
    for (let t = 1; t <= last; t++) {
      s.sim.step();
      if (CHECKPOINTS.indexOf(t) !== -1) out[t] = snapshot(s);
    }
    return out;
  }

  const ref = run(false);
  const chk = run(true);
  let equal = true;
  const W = freshSim().config.WORLD_W;
  for (const t of CHECKPOINTS) {
    const d = firstDiff(ref[t], chk[t]);
    if (d !== -1) {
      equal = false;
      const n = ref[t].length / 2;
      const where = d < n ? `material[${d % W},${(d / W) | 0}]` : `integrity@${d - n}`;
      console.log(`  tick ${t}: DIVERGED at byte ${d} (${where}) ref=${ref[t][d]} chk=${chk[t][d]}`);
    }
  }
  if (!equal) fail('chunked growth run diverged from full-scan reference');
  ok(`chunk-equivalence: growth scene byte-identical OFF==ON at ${CHECKPOINTS.join('/')}`);
}

// ===========================================================================
// 3. SOIL RULE — a floating sapling withers (no infinite tower).
// ===========================================================================
{
  const s = freshSim();
  s.sim.setChunkingEnabled(false);
  seedFloating(s);
  // Run well past the max possible countdown so the sapling has expired.
  for (let t = 0; t < 600; t++) s.sim.step();
  const sap = countMat(s, s.mats.SAPLING);
  const fol = countMat(s, s.mats.FOLIAGE);
  const cell = s.grid.material[FLOAT_Y * s.config.WORLD_W + FLOAT_X];
  if (sap !== 0) fail(`floating sapling persisted (${sap} saplings) — not withered`);
  if (fol !== 0) fail(`floating sapling produced ${fol} FOLIAGE with no soil — should wither`);
  if (cell !== s.mats.AIR) fail(`floating sapling cell is ${cell}, expected AIR (withered)`);
  ok('soil rule: a floating sapling (no soil below) withers to AIR — no tower, no foliage');
}

console.log('\nALL PASS');
if (typeof process !== 'undefined') process.exit(0);
