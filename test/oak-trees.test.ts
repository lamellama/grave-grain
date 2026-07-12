/**
 * test/oak-trees.test.ts — Oak trees: growth stages, full crowns, felling
 * (GDD §9 trees; user request: trees exist from worldgen, grow into full
 * oaks over the game, and lumberjacks NEED trees to collect wood).
 *
 * New behaviour under test:
 *  - A SAPLING is an oak's GROWING TIP: it matures into TRUNK (id 20), sprouts
 *    a fresh tip above, and flanks the top with FOLIAGE tufts - stage by stage
 *    until the trunk reaches TREE_TRUNK_MAX, when it crowns with the full oak
 *    canopy blob and stops (simulation.growSapling + engine/trees.ts).
 *  - Worldgen plants oaks at mixed growth stages (short trees carry a tip and
 *    keep growing in-game) plus low FOLIAGE bushes; the spawn wood guarantee
 *    is re-keyed to TRUNK cells.
 *  - Reproduction (applyReproduction) now seeds only from FULL-GROWN oaks
 *    (TRUNK column >= TREE_TRUNK_MAX under a sky-open crown).
 *  - The LUMBERJACK targets TRUNK (never bare FOLIAGE) and FELLS the whole
 *    tree: trunk + tip + crown removed, wood = trunk cells * WOOD_PER_CHOP.
 *    Zero trees in range -> zero wood, ever.
 *  - Chunk-equivalence: the whole growth arc is byte-identical chunked vs full.
 *
 * Real engine modules, fresh module graph per scenario. tsc → node.
 */

import '../src/engine/simulation';
import '../src/game/worldgen';
import '../src/characters/survivor';

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
// Scene: a STONE shelf carrying a capped DIRT bed (the eco-repro pattern - the
// caps keep the bed settled so the latent updateDirt equivalence gap logged in
// PROGRESS.md stays out of frame).
// ---------------------------------------------------------------------------
const GROUND_Y = 150;
const BED_X0 = 400;
const BED_X1 = 560;
const OAK_X = 480;

function seedPlain(s: Sim): void {
  const { grid, mats } = s;
  grid.material.fill(0);
  grid.integrity.fill(0);
  for (let x = BED_X0 - 4; x <= BED_X1 + 4; x++) {
    for (let y = GROUND_Y + 3; y <= GROUND_Y + 5; y++) grid.set(x, y, mats.STONE);
  }
  for (let x = BED_X0; x <= BED_X1; x++) {
    for (let y = GROUND_Y; y < GROUND_Y + 3; y++) grid.set(x, y, mats.DIRT);
  }
  for (let dx = 1; dx <= 2; dx++) {
    for (let y = GROUND_Y; y < GROUND_Y + 3; y++) {
      grid.set(BED_X0 - dx, y, mats.STONE);
      grid.set(BED_X1 + dx, y, mats.STONE);
    }
  }
}

/** Contiguous TRUNK column height whose base rests on the bed at column x. */
function trunkHeight(s: Sim, x: number): number {
  const { grid, mats, config } = s;
  let h = 0;
  for (let y = GROUND_Y - 1; y >= 0; y--) {
    if (grid.material[y * config.WORLD_W + x] === mats.TRUNK) h++;
    else if (h > 0) break;
  }
  return h;
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
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

// ===========================================================================
// 1. GROWTH ARC — one planted sapling grows stage-by-stage into a full oak,
//    carries a tip mid-growth, crowns at TREE_TRUNK_MAX, then STOPS.
// ===========================================================================
{
  const s = freshSim();
  s.sim.setChunkingEnabled(true);
  s.weather.__setWeatherForTest('clear');
  seedPlain(s);
  s.grid.placeMaterial(OAK_X, GROUND_Y - 1, s.mats.SAPLING);

  const STAGE = s.config.GROW_TICKS + s.config.GROW_JITTER + 5;

  // Mid-growth checkpoint: after ~3 stages the tree is a short trunk with a
  // live SAPLING growing tip directly above its top.
  for (let t = 0; t < STAGE * 3; t++) s.sim.step();
  const midH = trunkHeight(s, OAK_X);
  if (midH < 2 || midH >= s.config.TREE_TRUNK_MAX)
    fail(`mid-growth trunk height ${midH} not in [2, ${s.config.TREE_TRUNK_MAX})`);
  const tipY = GROUND_Y - 1 - midH;
  if (s.grid.material[tipY * s.config.WORLD_W + OAK_X] !== s.mats.SAPLING)
    fail('mid-growth tree has no SAPLING growing tip above its trunk top');

  // Run out the rest of the arc (+ generous slack), then assert FULL OAK.
  for (let t = 0; t < STAGE * (s.config.TREE_TRUNK_MAX + 2); t++) s.sim.step();
  const fullH = trunkHeight(s, OAK_X);
  if (fullH !== s.config.TREE_TRUNK_MAX)
    fail(`grown trunk height ${fullH} !== TREE_TRUNK_MAX ${s.config.TREE_TRUNK_MAX}`);
  if (countMat(s, s.mats.SAPLING) !== 0)
    fail('a crowned oak must retire its growing tip (SAPLING count != 0)');
  const crown = countMat(s, s.mats.FOLIAGE);
  if (crown < 12) fail(`full oak crown too sparse (${crown} FOLIAGE cells)`);

  // STOPS: another 3 stage-lengths change nothing.
  const before = snapshot(s);
  for (let t = 0; t < STAGE * 3; t++) s.sim.step();
  const d = firstDiff(before, snapshot(s));
  if (d !== -1) fail(`full oak kept changing (first diff at flat index ${d})`);
  ok(`growth arc: sapling -> trunk ${midH} w/ tip -> full oak (${fullH} trunk, ${crown} leaf cells), then stable`);
}

// ===========================================================================
// 2. REPRODUCTION — only a FULL-GROWN oak seeds; children at legal distance.
// ===========================================================================
{
  const s = freshSim();
  s.sim.setChunkingEnabled(true);
  s.weather.__setWeatherForTest('clear');
  seedPlain(s);
  // Hand-build a full oak: TREE_TRUNK_MAX trunk + crown, exactly as growth
  // leaves it (shared geometry from engine/trees.ts).
  const H = s.config.TREE_TRUNK_MAX;
  for (let k = 1; k <= H; k++) s.grid.placeMaterial(OAK_X, GROUND_Y - k, s.mats.TRUNK);
  s.trees.forEachCanopyCell(OAK_X, GROUND_Y - H, H, (cx: number, cy: number) => {
    if (s.grid.material[cy * s.config.WORLD_W + cx] === s.mats.AIR)
      s.grid.placeMaterial(cx, cy, s.mats.FOLIAGE);
  });
  // And a GROWING (juvenile) tree that must NOT seed: 3 trunk + tip.
  const JUV_X = OAK_X + 40;
  for (let k = 1; k <= 3; k++) s.grid.placeMaterial(JUV_X, GROUND_Y - k, s.mats.TRUNK);

  const ROUNDS = 30;
  for (let t = 0; t < s.config.REPRO_INTERVAL * ROUNDS; t++) s.sim.step();

  // New stems (SAPLING or TRUNK base) somewhere on the bed besides the two
  // hand-built trees - and the first generation lands SEED_MIN..MAX from the
  // parent OAK, never from the juvenile.
  const stems: number[] = [];
  for (let x = BED_X0; x <= BED_X1; x++) {
    const m = s.grid.material[(GROUND_Y - 1) * s.config.WORLD_W + x];
    if (m === s.mats.SAPLING || m === s.mats.TRUNK) stems.push(x);
  }
  const children = stems.filter((x) => x !== OAK_X && x !== JUV_X);
  if (children.length < 1) fail(`full oak never reproduced (stems: [${stems.join(', ')}])`);
  const gen1 = children.filter(
    (x) =>
      Math.abs(x - OAK_X) >= s.config.SEED_MIN_DIST &&
      Math.abs(x - OAK_X) <= s.config.SEED_MAX_DIST,
  );
  if (gen1.length < 1)
    fail(`no child at a legal first-generation distance from the oak (children: [${children.join(', ')}])`);
  // Crowding cap still holds pairwise.
  for (let i = 0; i < stems.length; i++)
    for (let j = i + 1; j < stems.length; j++)
      if (Math.abs(stems[i] - stems[j]) <= s.config.PLANT_MIN_SPACING)
        fail(`crowding cap violated: stems ${stems[i]} / ${stems[j]}`);
  ok(`reproduction: full oak seeded ${children.length} child(ren), gen-1 at legal distance, spacing cap holds`);

  // The juvenile alone must NOT seed: fresh scene, juvenile only.
  const s2 = freshSim();
  s2.sim.setChunkingEnabled(true);
  s2.weather.__setWeatherForTest('clear');
  seedPlain(s2);
  for (let k = 1; k <= 3; k++) s2.grid.placeMaterial(OAK_X, GROUND_Y - k, s2.mats.TRUNK);
  s2.trees.forEachCanopyCell(OAK_X, GROUND_Y - 3, 3, (cx: number, cy: number) => {
    if (s2.grid.material[cy * s2.config.WORLD_W + cx] === s2.mats.AIR)
      s2.grid.placeMaterial(cx, cy, s2.mats.FOLIAGE);
  });
  for (let t = 0; t < s2.config.REPRO_INTERVAL * 10; t++) s2.sim.step();
  if (countMat(s2, s2.mats.SAPLING) !== 0)
    fail('a juvenile (sub-max trunk) tree seeded - only full oaks may reproduce');
  ok('reproduction: juvenile trees never seed');
}

// ===========================================================================
// 3. WORLDGEN — oaks from tick zero: trunks rooted on soil, mixed stages with
//    live growing tips, bushes for the forager, trunk guarantee near spawn.
// ===========================================================================
{
  const s = freshSim();
  const worldgen = require('../src/game/worldgen');
  const res = worldgen.generateWorld();

  const trunks = countMat(s, s.mats.TRUNK);
  const leaves = countMat(s, s.mats.FOLIAGE);
  const tips = countMat(s, s.mats.SAPLING);
  if (trunks < 20) fail(`worldgen planted almost no trees (${trunks} TRUNK cells)`);
  if (leaves < 20) fail(`worldgen planted almost no foliage (${leaves} cells)`);
  if (tips < 1) fail('worldgen planted no growing tips - forests could never grow');

  // Every trunk column must be rooted: walk each trunk chain down - the cell
  // under its base is DIRT (surface soil), never AIR.
  const W = s.config.WORLD_W;
  const Hh = s.config.WORLD_H;
  let checked = 0;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < Hh; y++) {
      const i = y * W + x;
      if (s.grid.material[i] !== s.mats.TRUNK) continue;
      // walk to the chain's bottom
      let by = y;
      while (by + 1 < Hh && s.grid.material[(by + 1) * W + x] === s.mats.TRUNK) by++;
      const under = s.grid.material[(by + 1) * W + x];
      if (under !== s.mats.DIRT) fail(`trunk at (${x}, ${y}) rooted on material ${under}, not DIRT`);
      checked++;
      y = by; // skip the rest of this chain
    }
  }
  // Spawn guarantee: enough trunk within reach of home for the lumberjack.
  let nearTrunks = 0;
  for (let x = Math.max(0, res.spawnX - s.config.RESOURCE_SCAN_RADIUS);
       x <= Math.min(W - 1, res.spawnX + s.config.RESOURCE_SCAN_RADIUS); x++) {
    for (let y = 0; y < Hh; y++) if (s.grid.material[y * W + x] === s.mats.TRUNK) nearTrunks++;
  }
  if (nearTrunks < s.config.SPAWN_GUARANTEE_TRUNK_CELLS)
    fail(`only ${nearTrunks} TRUNK cells near spawn (< ${s.config.SPAWN_GUARANTEE_TRUNK_CELLS})`);
  ok(`worldgen: ${trunks} trunk cells across ${checked} rooted chains, ${leaves} leaves, ${tips} growing tips, ${nearTrunks} trunk near spawn`);
}

// ===========================================================================
// 4. LUMBERJACK FELLS TREES — one work action takes the whole oak (trunk, tip
//    and crown), wood scales with height; bushes alone yield NOTHING.
// ===========================================================================
{
  const s = freshSim();
  const survivorMod = require('../src/characters/survivor');
  const navgrid = require('../src/engine/navgrid');
  const resources = require('../src/game/resources');
  s.sim.setChunkingEnabled(true);
  s.weather.__setWeatherForTest('clear');

  const { grid, mats, config } = s;
  grid.material.fill(0);
  grid.integrity.fill(0);
  const FLOOR = 150;
  for (let x = 100; x <= 400; x++)
    for (let y = FLOOR; y < FLOOR + 20; y++) grid.set(x, y, mats.STONE);

  // One young oak (3 trunk + tip + tufts) near the survivor.
  const TREE_X = 250;
  const TH = 3;
  for (let k = 1; k <= TH; k++) grid.placeMaterial(TREE_X, FLOOR - k, mats.TRUNK);
  grid.placeMaterial(TREE_X, FLOOR - TH - 1, mats.SAPLING);
  s.trees.forEachCanopyCell(TREE_X, FLOOR - TH, TH, (cx: number, cy: number) => {
    if (grid.material[cy * config.WORLD_W + cx] === mats.AIR)
      grid.placeMaterial(cx, cy, mats.FOLIAGE);
  });
  // A fat bush NEARER than the tree - the lumberjack must walk PAST it.
  for (let x = 220; x <= 223; x++) grid.placeMaterial(x, FLOOR - 1, mats.FOLIAGE);

  navgrid.rebuildNavgrid();
  resources.resetStockpile();
  resources.setStockpilePoint(180, FLOOR - 1);

  const sv = survivorMod.createSurvivor(200, FLOOR - 1);
  if (survivorMod.assignRole(sv, 'lumberjack') !== true) fail('assignRole(lumberjack) failed');

  let firstWood = -1;
  for (let i = 0; i < 20000 && firstWood < 0; i++) {
    sv.needs.thirst = config.NEED_MAX;
    sv.needs.hunger = config.NEED_MAX;
    sv.needs.warmth = config.NEED_MAX;
    survivorMod.updateSurvivor(sv);
    if (resources.getStockpile().wood > 0) firstWood = resources.getStockpile().wood;
  }
  if (firstWood !== TH * config.WOOD_PER_CHOP)
    fail(`felling a ${TH}-trunk oak deposited ${firstWood} wood (expected ${TH * config.WOOD_PER_CHOP})`);
  if (trunkHeightAt(TREE_X) !== 0) fail('felled tree still has trunk cells');
  if (countMat(s, mats.SAPLING) !== 0) fail('felled tree left its growing tip behind');
  // No leaves left hanging in the crown box; the decoy bush survives.
  for (let cx = TREE_X - 4; cx <= TREE_X + 4; cx++)
    for (let cy = FLOOR - TH - 5; cy < FLOOR - 1; cy++)
      if (grid.material[cy * config.WORLD_W + cx] === mats.FOLIAGE)
        fail(`floating leaves left at (${cx}, ${cy}) after felling`);
  if (grid.material[(FLOOR - 1) * config.WORLD_W + 220] !== mats.FOLIAGE)
    fail('the ground bush was consumed by the LUMBERJACK (bushes are forager business)');
  ok(`lumberjack fells the whole oak: ${firstWood} wood from ${TH} trunk cells, no remnants, bush untouched`);

  function trunkHeightAt(x: number): number {
    let n = 0;
    for (let y = 0; y < config.WORLD_H; y++)
      if (grid.material[y * config.WORLD_W + x] === mats.TRUNK) n++;
    return n;
  }

  // Bushes-only scene -> the lumberjack NEVER collects wood.
  grid.material.fill(0);
  grid.integrity.fill(0);
  for (let x = 100; x <= 400; x++)
    for (let y = FLOOR; y < FLOOR + 20; y++) grid.set(x, y, mats.STONE);
  for (let x = 230; x <= 260; x++)
    for (let y = FLOOR - 2; y <= FLOOR - 1; y++) grid.placeMaterial(x, y, mats.FOLIAGE);
  navgrid.rebuildNavgrid();
  resources.resetStockpile();
  resources.setStockpilePoint(180, FLOOR - 1);
  const sv2 = survivorMod.createSurvivor(200, FLOOR - 1);
  if (survivorMod.assignRole(sv2, 'lumberjack') !== true) fail('assignRole #2 failed');
  const foliageBefore = countMat(s, mats.FOLIAGE);
  for (let i = 0; i < 6000; i++) {
    sv2.needs.thirst = config.NEED_MAX;
    sv2.needs.hunger = config.NEED_MAX;
    sv2.needs.warmth = config.NEED_MAX;
    survivorMod.updateSurvivor(sv2);
  }
  if (resources.getStockpile().wood !== 0)
    fail(`lumberjack conjured ${resources.getStockpile().wood} wood from a treeless world`);
  if (countMat(s, mats.FOLIAGE) !== foliageBefore)
    fail('lumberjack chopped bushes despite having no tree target');
  ok('no trees -> no wood: lumberjack idles in a bushes-only world, bushes intact');
}

// ===========================================================================
// 5. CHUNK EQUIVALENCE — the full growth arc (sapling -> crowned oak, incl. a
//    reproduction round) is byte-identical chunked vs full-scan.
// ===========================================================================
{
  const CHECKPOINTS = [240, 720, 1300, 2600, 3600];
  const runs: Uint8Array[][] = [];
  for (const chunking of [false, true]) {
    const s = freshSim();
    s.sim.setChunkingEnabled(chunking);
    s.weather.__setWeatherForTest('clear');
    seedPlain(s);
    s.grid.placeMaterial(OAK_X, GROUND_Y - 1, s.mats.SAPLING);
    const snaps: Uint8Array[] = [];
    let t = 0;
    for (const cp of CHECKPOINTS) {
      for (; t < cp; t++) s.sim.step();
      snaps.push(snapshot(s));
    }
    runs.push(snaps);
  }
  for (let i = 0; i < CHECKPOINTS.length; i++) {
    const d = firstDiff(runs[0][i], runs[1][i]);
    if (d !== -1)
      fail(`chunked vs full diverged at checkpoint t=${CHECKPOINTS[i]} (flat index ${d})`);
  }
  ok(`chunk equivalence: OFF == ON byte-for-byte at t=[${CHECKPOINTS.join(', ')}] across the growth arc`);
}

console.log('ALL OAK-TREE TESTS PASSED');
