/**
 * test/eco-repro.test.ts — Tree reproduction + snow slows/kills plants
 * (GDD §9 ecology, Beyond item 2 of the user-prioritized order).
 *
 * New sim behaviour under test:
 *  - REPRODUCE: every REPRO_INTERVAL ticks each FULL-GROWN OAK (a sky-open
 *    FOLIAGE crown over a TRUNK column ≥ TREE_TRUNK_MAX) rolls REPRO_CHANCE to
 *    drop a seed SEED_MIN_DIST..SEED_MAX_DIST columns away; the seed germinates
 *    into a SAPLING only on open DIRT with no plant within PLANT_MIN_SPACING
 *    columns (crowding cap).
 *  - WINTER: under 'snow' weather no seeds drop and sapling growth PAUSES
 *    (countdown holds, resumes on thaw); a sapling in CONTACT with a SNOW cell
 *    withers to AIR at SAPLING_SNOW_KILL_CHANCE/tick. Grown FOLIAGE is hardy.
 *
 * Done-when:
 *   1. Reproduces: a lone mature tree on a dirt plain spawns new plants at
 *      legal distances; the forest SPREADS over generations.
 *   2. Bounded: every plant stem respects the crowding cap (pairwise column
 *      distance > PLANT_MIN_SPACING) — the forest never carpets the bed.
 *   3. Winter gate: pinned snow → zero new plants; a shielded sapling's
 *      countdown holds exactly (pause), then resumes on thaw; a snow-touching
 *      sapling withers to AIR; the parent FOLIAGE survives.
 *   4. Determinism / chunk-equivalence: OFF == ON byte-for-byte at checkpoints
 *      across reproduction rounds AND a snow scene (pause + kill + sky snow).
 *
 * Real engine modules, fresh module graph per run (busts the require-cache so
 * tick / grid / chunk bitsets / weather reset). tsc → node.
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
  const weather = require('../src/engine/weather');
  const sim = require('../src/engine/simulation');
  const trees = require('../src/engine/trees');
  return { config, grid, mats, weather, sim, trees };
}
type Sim = ReturnType<typeof freshSim>;

// ---------------------------------------------------------------------------
// Scene: a STONE shelf carrying a wide DIRT plain, with ONE hand-built mature
// tree (a FOLIAGE column well above REPRO_MIN_HEIGHT) in the middle. Wide
// enough that several seed generations can land inside the bed.
// ---------------------------------------------------------------------------
const GROUND_Y = 150; // top dirt row (plant stems sit at GROUND_Y - 1)
const BED_X0 = 400;
const BED_X1 = 560;
const PARENT_X = 480;
const TREE_H = 9; // = TREE_TRUNK_MAX -> a full-grown, seeding oak

function seedPlain(s: Sim): void {
  const { grid, mats } = s;
  grid.material.fill(0);
  grid.integrity.fill(0);
  // Stone shelf so the powder DIRT can never cascade off the ends.
  for (let x = BED_X0 - 4; x <= BED_X1 + 4; x++) {
    for (let y = GROUND_Y + 3; y <= GROUND_Y + 5; y++) grid.set(x, y, mats.STONE);
  }
  for (let x = BED_X0; x <= BED_X1; x++) {
    for (let y = GROUND_Y; y < GROUND_Y + 3; y++) grid.set(x, y, mats.DIRT);
  }
  // STONE caps on both bed ends, flush with the surface, so every DIRT cell is
  // fully enclosed and the bed settles IMMEDIATELY (like contiguous worldgen
  // terrain). Without them the edge dirt has an open diagonal and dribbles off
  // probabilistically - which trips a LATENT pre-existing updateDirt
  // chunk-equivalence gap (a dirt cell whose spill roll fails does not
  // self-mark, so its chunk can settle while the full scan later spills it).
  // That gap reproduces on HEAD with a bare dirt bed and is logged in
  // PROGRESS.md; it is NOT what this suite tests.
  for (let dx = 1; dx <= 2; dx++) {
    for (let y = GROUND_Y; y < GROUND_Y + 3; y++) {
      grid.set(BED_X0 - dx, y, mats.STONE);
      grid.set(BED_X1 + dx, y, mats.STONE);
    }
  }
}

function seedParentTree(s: Sim, x: number): void {
  // A FULL-GROWN OAK exactly as growth leaves it: TREE_TRUNK_MAX trunk cells
  // plus the crown (shared geometry from engine/trees.ts) - only full oaks
  // seed under the oak-trees contract.
  for (let k = 1; k <= TREE_H; k++) s.grid.placeMaterial(x, GROUND_Y - k, s.mats.TRUNK);
  s.trees.forEachCanopyCell(x, GROUND_Y - TREE_H, TREE_H, (cx: number, cy: number) => {
    if (s.grid.material[cy * s.config.WORLD_W + cx] === s.mats.AIR)
      s.grid.placeMaterial(cx, cy, s.mats.FOLIAGE);
  });
}

/** Column x-positions of every plant STEM (SAPLING or TRUNK on the soil row —
 * FOLIAGE at that row is a canopy tuft flanking a stem, not a stem itself). */
function stems(s: Sim): number[] {
  const { grid, mats, config } = s;
  const out: number[] = [];
  const y = GROUND_Y - 1;
  for (let x = BED_X0; x <= BED_X1; x++) {
    const m = grid.material[y * config.WORLD_W + x];
    if (m === mats.SAPLING || m === mats.TRUNK) out.push(x);
  }
  return out;
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
// 1+2. REPRODUCES & BOUNDED — the tree seeds new plants; spacing cap holds.
// ===========================================================================
{
  const s = freshSim();
  s.sim.setChunkingEnabled(true); // production path; equivalence proven in §4
  s.weather.__setWeatherForTest('clear'); // growing season, deterministic
  seedPlain(s);
  seedParentTree(s, PARENT_X);

  const ROUNDS = 40; // reproduction rounds (~3 plant generations)
  const TOTAL = s.config.REPRO_INTERVAL * ROUNDS;
  const curve: Array<{ t: number; stems: number }> = [];
  for (let t = 1; t <= TOTAL; t++) {
    s.sim.step();
    if (t % (s.config.REPRO_INTERVAL * 2) === 0) curve.push({ t, stems: stems(s).length });
  }

  const finalStems = stems(s);
  console.log('FOREST SPREAD (tick : stems):');
  for (const p of curve) console.log(`  t=${String(p.t).padStart(5)}  stems=${p.stems}`);
  console.log(`  final stems at x = [${finalStems.join(', ')}] (parent ${PARENT_X})`);

  // (a) It reproduced: new plants beyond the original parent stem.
  if (finalStems.length < 3) fail(`forest did not spread (${finalStems.length} stems after ${ROUNDS} rounds)`);
  // (b) Every child germinated at a legal offset from SOME stem: within the
  //     bed on DIRT (stems() enforces soil) — and the FIRST generation child
  //     must sit SEED_MIN_DIST..SEED_MAX_DIST from the parent by construction.
  //     (Later generations chain, so global distance grows — that's spread.)
  const gen1 = finalStems.filter(
    (x) => x !== PARENT_X &&
      Math.abs(x - PARENT_X) >= s.config.SEED_MIN_DIST &&
      Math.abs(x - PARENT_X) <= s.config.SEED_MAX_DIST
  );
  if (gen1.length < 1) fail('no child at a legal first-generation distance from the parent');
  // (c) Multi-generation SPREAD: some stem lies beyond one seed-hop from the
  //     parent (a child of a child), proving reproduction chains.
  const maxDist = Math.max(...finalStems.map((x) => Math.abs(x - PARENT_X)));
  if (maxDist <= s.config.SEED_MAX_DIST)
    fail(`no second-generation spread (max distance ${maxDist} <= ${s.config.SEED_MAX_DIST})`);
  // (d) BOUNDED (crowding cap): pairwise stem distance > PLANT_MIN_SPACING.
  for (let i = 0; i < finalStems.length; i++) {
    for (let j = i + 1; j < finalStems.length; j++) {
      const d = Math.abs(finalStems[i] - finalStems[j]);
      if (d <= s.config.PLANT_MIN_SPACING)
        fail(`crowding cap violated: stems at ${finalStems[i]} and ${finalStems[j]} are ${d} apart (<= ${s.config.PLANT_MIN_SPACING})`);
    }
  }
  // (e) Sanity ceiling: spacing bounds the bed's carrying capacity.
  const capacity = Math.floor((BED_X1 - BED_X0) / (s.config.PLANT_MIN_SPACING + 1)) + 1;
  if (finalStems.length > capacity)
    fail(`stem count ${finalStems.length} exceeds spacing capacity ${capacity}`);
  ok(`reproduces + bounded: ${finalStems.length} stems after ${ROUNDS} rounds, gen-1 child(ren) at legal distance, spread to ${maxDist} cols, all pairs > ${s.config.PLANT_MIN_SPACING} apart`);
}

// ===========================================================================
// 3. WINTER — no seeding under snow; pause holds + resumes; contact kills.
// ===========================================================================
{
  // (a) No reproduction under pinned snow, and the parent FOLIAGE survives.
  const s = freshSim();
  s.sim.setChunkingEnabled(true);
  s.weather.__setWeatherForTest('snow');
  seedPlain(s);
  seedParentTree(s, PARENT_X);
  const before = stems(s).length;
  const TOTAL = s.config.REPRO_INTERVAL * 6;
  for (let t = 1; t <= TOTAL; t++) s.sim.step();
  const after = stems(s).length;
  if (after > before) fail(`plants reproduced under snow (${before} -> ${after} stems)`);
  // The parent's trunk column is still standing (snow kills saplings, not trees).
  let col = 0;
  for (let k = 1; k <= TREE_H; k++) {
    if (s.grid.material[(GROUND_Y - k) * s.config.WORLD_W + PARENT_X] === s.mats.TRUNK) col++;
  }
  if (col !== TREE_H) fail(`grown TRUNK died in winter (${col}/${TREE_H} cells left)`);
  ok(`winter gate: 0 new plants over ${TOTAL} snow ticks; grown trunk survives`);
}

{
  // (b) PAUSE: a sapling under a wide stone roof (shielded from sky snow, no
  //     snow contact) holds its countdown EXACTLY while it snows, then resumes
  //     and matures after the thaw.
  const s = freshSim();
  s.sim.setChunkingEnabled(true);
  s.weather.__setWeatherForTest('snow');
  seedPlain(s);
  const SAP_X = PARENT_X;
  s.grid.set(SAP_X, GROUND_Y - 1, s.mats.SAPLING);
  // Wide roof 4 rows above the sapling: sky snow lands there and piles; the
  // overhang is wide enough that no diagonal spill reaches the sapling.
  for (let x = SAP_X - 30; x <= SAP_X + 30; x++) s.grid.set(x, GROUND_Y - 5, s.mats.STONE);

  s.sim.step(); // first visit seeds the countdown
  const W = s.config.WORLD_W;
  const seeded = s.grid.integrity[(GROUND_Y - 1) * W + SAP_X];
  if (seeded === 0) fail('countdown did not auto-seed on first visit');
  for (let t = 0; t < 700; t++) s.sim.step(); // > GROW_TICKS of snow
  const held = s.grid.integrity[(GROUND_Y - 1) * W + SAP_X];
  const stillSapling = s.grid.material[(GROUND_Y - 1) * W + SAP_X] === s.mats.SAPLING;
  if (!stillSapling) fail('shielded sapling did not survive the snow pause');
  if (held !== seeded) fail(`countdown moved during snow (${seeded} -> ${held}) — growth not paused`);
  // Thaw: growth resumes and the sapling matures into FOLIAGE.
  s.weather.__setWeatherForTest('clear');
  for (let t = 0; t < s.config.GROW_TICKS + s.config.GROW_JITTER + 5; t++) s.sim.step();
  const matured = s.grid.material[(GROUND_Y - 1) * W + SAP_X] === s.mats.TRUNK;
  if (!matured) fail('sapling did not resume growing after the thaw');
  ok(`pause: countdown held at ${held} across 700 snow ticks, resumed and matured after thaw`);
}

{
  // (c) KILL: a sapling with a SNOW cell resting on it withers to AIR.
  const s = freshSim();
  s.sim.setChunkingEnabled(true);
  s.weather.__setWeatherForTest('snow');
  seedPlain(s);
  const SAP_X = PARENT_X;
  s.grid.set(SAP_X, GROUND_Y - 1, s.mats.SAPLING);
  s.grid.set(SAP_X, GROUND_Y - 2, s.mats.SNOW); // rests on the sapling: contact
  // P(survive 3000 ticks) = (1 - 0.005)^3000 ~ 3e-7 — deterministic seed, but
  // the horizon is deep enough that any healthy RNG stream kills well inside it.
  let died = false;
  for (let t = 0; t < 3000 && !died; t++) {
    s.sim.step();
    died = s.grid.material[(GROUND_Y - 1) * s.config.WORLD_W + SAP_X] !== s.mats.SAPLING;
  }
  if (!died) fail('snow-touching sapling never withered (kill roll broken)');
  const cell = s.grid.material[(GROUND_Y - 1) * s.config.WORLD_W + SAP_X];
  // The freed cell is AIR the moment it withers (the snow above may then fall
  // into it on a later tick — either material is acceptable evidence of death,
  // but FOLIAGE would mean it matured instead).
  if (cell === s.mats.TRUNK) fail('snow-touching sapling MATURED instead of withering');
  ok('kill: snow contact withers the sapling (no maturation)');
}

// ===========================================================================
// 4. DETERMINISM / CHUNK-EQUIVALENCE (CRITICAL) — OFF == ON byte-for-byte,
//    across reproduction rounds and the winter (pause + kill + sky-snow) path.
// ===========================================================================
{
  function run(chunking: boolean, w: 'clear' | 'snow', ticks: number, checkpoints: number[]): Record<number, Uint8Array> {
    const s = freshSim();
    s.sim.setChunkingEnabled(chunking);
    s.weather.__setWeatherForTest(w);
    seedPlain(s);
    seedParentTree(s, PARENT_X);
    // A growing sapling + a snow-touched sapling in the same scene, so both
    // paths exercise seeding, pause, kill and reproduction together.
    s.grid.set(PARENT_X + 20, GROUND_Y - 1, s.mats.SAPLING);
    s.grid.set(PARENT_X - 20, GROUND_Y - 1, s.mats.SAPLING);
    s.grid.set(PARENT_X - 20, GROUND_Y - 2, s.mats.SNOW);
    const out: Record<number, Uint8Array> = {};
    for (let t = 1; t <= ticks; t++) {
      s.sim.step();
      if (checkpoints.indexOf(t) !== -1) out[t] = snapshot(s);
    }
    return out;
  }

  const W = freshSim().config.WORLD_W;
  for (const scene of [
    { w: 'clear' as const, ticks: 1300, cps: [50, 599, 601, 900, 1300] }, // spans 2 repro rounds
    { w: 'snow' as const, ticks: 800, cps: [50, 300, 599, 601, 800] },
  ]) {
    const ref = run(false, scene.w, scene.ticks, scene.cps);
    const chk = run(true, scene.w, scene.ticks, scene.cps);
    for (const t of scene.cps) {
      const d = firstDiff(ref[t], chk[t]);
      if (d !== -1) {
        const n = ref[t].length / 2;
        const where = d < n ? `material[${d % W},${(d / W) | 0}]` : `integrity@${d - n}`;
        fail(`(${scene.w}) tick ${t}: chunked run DIVERGED at byte ${d} (${where}) ref=${ref[t][d]} chk=${chk[t][d]}`);
      }
    }
    ok(`chunk-equivalence (${scene.w}): byte-identical OFF==ON at ${scene.cps.join('/')}`);
  }
}

console.log('\nALL PASS');
if (typeof process !== 'undefined') process.exit(0);
