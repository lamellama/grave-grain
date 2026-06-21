/**
 * game/worldgen.ts — Seeded procedural world generation (GDD §5.3).
 *
 * AUTHORITATIVE behaviour: GDD §5.3 "World generation":
 *   - Largely procedural, **seeded for replayability** (same seed ⇒ same map).
 *   - Wide world, several viewports across; the survivor start zone sits AWAY
 *     from the zombie edge.
 *   - Layered terrain: surface soil/grass → dirt → mixed sand pockets → stone
 *     with ore veins at depth, plus water tables / underground pools.
 *   - Surface features: woodland clusters (trees + bushes).
 *   - Spawn guarantees: the start zone is reasonably safe, with at least a
 *     minimum guaranteed wood + water source within reach.
 *
 * Data-oriented (AGENTS §4): this module writes straight into the flat typed
 * `material`/`integrity` arrays — no per-cell objects, no DOM. It is the only
 * worldgen entry point; the hand-seeded Phase-3 test scenes it replaces are
 * wired out of main.ts separately (task 9-7).
 */

import {
  WORLD_W,
  WORLD_H,
  WORLDGEN_SEED,
  SURFACE_BASE_Y,
  SURFACE_AMPLITUDE,
  SURFACE_SOIL_DEPTH,
  DIRT_DEPTH,
  SAND_POCKET_CHANCE,
  SAND_POCKET_MAX,
  ORE_VEIN_DENSITY,
  ORE_VEIN_LEN,
  WATER_TABLE_DEPTH,
  WATER_POOL_CHANCE,
  WATER_POOL_MAX,
  WOODLAND_CLUSTERS,
  WOODLAND_CLUSTER_W,
  FOLIAGE_HEIGHT,
  SPAWN_ZONE_MARGIN,
  SPAWN_GUARANTEE_WOOD_CELLS,
  SPAWN_GUARANTEE_WATER,
  RESOURCE_SCAN_RADIUS,
  ZOMBIE_SPAWN_EDGE,
  BODY_H,
  CAMP_HALF_WIDTH,
  CAMP_ROOF_CLEARANCE,
} from '../config';
import { material, integrity, idx, inBounds, placeMaterial } from '../engine/grid';
import {
  AIR,
  SAND,
  STONE,
  WATER,
  DIRT,
  ORE,
  FOLIAGE,
  WOOD,
  MATERIALS,
  isSolidForBody,
} from '../engine/materials';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface WorldGenResult {
  /** Column the survivor colony spawns at (away from the zombie edge). */
  spawnX: number;
  /** Row to drop survivors at — a little above the local surface so they fall on. */
  spawnY: number;
  /** Surface point inside the spawn zone for the colony stockpile. */
  stockpilePoint: { x: number; y: number };
  /** Which horizontal edge the zombies stream in from (GDD §5.3 edge zones). */
  zombieEdge: 'left' | 'right';
  /**
   * A standable, SHELTERED feet-cell inside the starter camp (Task W5, GDD §8).
   * main.ts clusters the colony here so survivors live in the warm nook on the
   * cold world. `x` is the camp centre (= spawnX); `y` is the camp floor feet row.
   */
  shelterPoint: { x: number; y: number };
}

// ---------------------------------------------------------------------------
// Seeded RNG — mulberry32 (GDD §5.3 "seeded for replayability").
// A self-contained 32-bit PRNG: the SAME seed yields a byte-identical grid.
// Never use Math.random in worldgen.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smoothstep ease for gentle value-noise interpolation. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Local tuning (worldgen-only shape constants; gameplay knobs live in config).
// ---------------------------------------------------------------------------

// Wavelengths (cells) of the two value-noise octaves that roll the surface.
const NOISE_WAVELENGTH_LONG = 96;
const NOISE_WAVELENGTH_SHORT = 28;
// Mix weights for the two octaves (sum 1.0) — long rolls dominate.
const NOISE_W_LONG = 0.72;
const NOISE_W_SHORT = 0.28;

// Extra inset (cells) the spawn column keeps from the far (non-zombie) wall so
// the RESOURCE_SCAN_RADIUS scan around it stays inside the world.
const SPAWN_FAR_INSET = 0;

// Offsets (cells) of the guaranteed wood cluster and water pool from spawnX, so
// the stockpile, woodland and pond sit near home without stacking.
const GUARANTEE_WOOD_OFFSET = -56;
const GUARANTEE_WATER_OFFSET = 56;

// Geometry of the guaranteed open-topped spawn pond (reachable + contained).
const SPAWN_POND_HALF_W = 4; // interior half-width (cells)
const SPAWN_POND_DEPTH = 5;  // interior depth (cells)

// ---------------------------------------------------------------------------
// One value-noise octave: seeded control points interpolated with smoothstep.
// Returns a continuous value in roughly [-1, 1].
// ---------------------------------------------------------------------------

function buildOctave(rng: () => number, wavelength: number): Float64Array {
  const nodes = Math.ceil(WORLD_W / wavelength) + 2;
  const ctrl = new Float64Array(nodes);
  for (let i = 0; i < nodes; i++) ctrl[i] = rng() * 2 - 1; // [-1, 1]
  const out = new Float64Array(WORLD_W);
  for (let x = 0; x < WORLD_W; x++) {
    const fx = x / wavelength;
    const i0 = Math.floor(fx);
    const frac = smoothstep(fx - i0);
    out[x] = ctrl[i0] * (1 - frac) + ctrl[i0 + 1] * frac;
  }
  return out;
}

// ---------------------------------------------------------------------------
// generateWorld — the seeded build (GDD §5.3).
// ---------------------------------------------------------------------------

export function generateWorld(seed: number = WORLDGEN_SEED): WorldGenResult {
  const rng = mulberry32(seed);

  // 1. Clear the grid to AIR (material + integrity), so re-gen is from scratch.
  material.fill(AIR);
  integrity.fill(0);

  // 2. Surface: a smooth per-column horizon from two value-noise octaves,
  //    scaled to ±SURFACE_AMPLITUDE rows around SURFACE_BASE_Y. Smoothstep
  //    interpolation keeps it rolling, never jagged (GDD §5.3 surface flatness).
  const longOct = buildOctave(rng, NOISE_WAVELENGTH_LONG);
  const shortOct = buildOctave(rng, NOISE_WAVELENGTH_SHORT);
  const surfaceY = new Int32Array(WORLD_W);
  for (let x = 0; x < WORLD_W; x++) {
    const n = longOct[x] * NOISE_W_LONG + shortOct[x] * NOISE_W_SHORT; // ~[-1,1]
    let row = SURFACE_BASE_Y + Math.round(n * SURFACE_AMPLITUDE);
    if (row < 1) row = 1;
    if (row > WORLD_H - 2) row = WORLD_H - 2;
    surfaceY[x] = row;
  }

  // 3. Layers per column (GDD §5.3): above surface = AIR; then SURFACE_SOIL_DEPTH
  //    rows of soil/grass DIRT, then DIRT_DEPTH rows of DIRT, then STONE to the
  //    world floor. Soil and dirt share the DIRT material; foliage marks trees.
  const dirtBottom = new Int32Array(WORLD_W); // first STONE row in each column
  for (let x = 0; x < WORLD_W; x++) {
    const top = surfaceY[x];
    const dirtEnd = top + SURFACE_SOIL_DEPTH + DIRT_DEPTH; // exclusive
    dirtBottom[x] = dirtEnd;
    for (let y = top; y < WORLD_H; y++) {
      material[idx(x, y)] = y < dirtEnd ? DIRT : STONE;
    }
  }

  // 4. Sand pockets — seeded lens blobs of SAND in the dirt/stone, at/below the
  //    dirt band so none ever sit above the surface (GDD §5.3 mixed sand pockets).
  for (let x = 0; x < WORLD_W; x++) {
    if (rng() >= SAND_POCKET_CHANCE) continue;
    const r = 2 + Math.floor(rng() * (SAND_POCKET_MAX - 1)); // 2..SAND_POCKET_MAX
    // Centre at/below the soil band, with room to fit the blob below ground.
    const minCy = surfaceY[x] + SURFACE_SOIL_DEPTH + r;
    const maxCy = WORLD_H - 1 - r;
    if (minCy > maxCy) continue;
    const cy = minCy + Math.floor(rng() * (maxCy - minCy + 1));
    fillBlob(x, cy, r, SAND, /*onlySolid*/ true);
  }

  // 5. Ore veins — short ORE random-walks embedded ONLY in stone below the dirt
  //    band (GDD §5.3 ore veins at depth). Never enters dirt/sand/air.
  for (let x = 0; x < WORLD_W; x++) {
    for (let y = dirtBottom[x]; y < WORLD_H; y++) {
      if (material[idx(x, y)] !== STONE) continue;
      if (rng() >= ORE_VEIN_DENSITY) continue;
      walkVein(rng, x, y);
    }
  }

  // 6. Water table — contained underground pools carved into the stone around
  //    WATER_TABLE_DEPTH below the surface (GDD §5.3 water tables). Only STONE
  //    cells become WATER, so each pool keeps a stone floor + side walls and
  //    will NOT drain across the map when the sim runs (a sealed pocket).
  for (let x = 0; x < WORLD_W; x++) {
    if (rng() >= WATER_POOL_CHANCE) continue;
    const halfW = 3 + Math.floor(rng() * (WATER_POOL_MAX - 2)); // 3..WATER_POOL_MAX
    const halfH = Math.max(2, Math.floor(halfW * 0.45)); // flatter than wide
    const cy = surfaceY[x] + WATER_TABLE_DEPTH;
    carveSealedPool(x, cy, halfW, halfH);
  }

  // 7. Woodland — FOLIAGE clusters spread across the width, each ~CLUSTER_W wide
  //    and FOLIAGE_HEIGHT tall, sitting ON the surface (GDD §5.3 woodland).
  const spacing = WORLD_W / WOODLAND_CLUSTERS;
  for (let c = 0; c < WOODLAND_CLUSTERS; c++) {
    const jitter = Math.floor((rng() * 2 - 1) * spacing * 0.35);
    const cx = Math.floor((c + 0.5) * spacing) + jitter;
    placeWoodland(rng, cx, surfaceY);
  }

  // 8. Zombie edge + spawn zone (GDD §5.3): survivors start at the OPPOSITE end
  //    of the map from the zombie edge, ≥ SPAWN_ZONE_MARGIN away.
  const zombieEdge = ZOMBIE_SPAWN_EDGE;
  let spawnX =
    zombieEdge === 'left'
      ? WORLD_W - SPAWN_ZONE_MARGIN - SPAWN_FAR_INSET
      : SPAWN_ZONE_MARGIN + SPAWN_FAR_INSET;
  spawnX = clampX(spawnX);
  const spawnSurface = surfaceY[spawnX];
  // The starter camp flattens the floor to spawnSurface, so the colony stands
  // with its feet on the row just above it (Task W5). Survivors are spawned
  // STANDING inside the camp (no long fall onto a roof), so spawnY is the feet
  // row, not a drop row above the surface.
  const spawnY = Math.max(0, spawnSurface - 1);
  const stockpilePoint = { x: spawnX, y: spawnSurface };

  // 9. Spawn-zone guarantees (GDD §5.3): a survivor must always be able to chop
  //    wood and drink water near home, within RESOURCE_SCAN_RADIUS of spawnX.

  // 9a. Wood: if the random woodland did not leave enough FOLIAGE in reach, seed
  //     a guaranteed cluster beside the colony.
  if (countMaterialNear(spawnX, FOLIAGE, RESOURCE_SCAN_RADIUS) < SPAWN_GUARANTEE_WOOD_CELLS) {
    const woodX = clampX(spawnX + GUARANTEE_WOOD_OFFSET);
    placeGuaranteedGrove(woodX, surfaceY);
  }

  // 9b. Water: carve a guaranteed open-topped, contained pond near home. The
  //     deep water-table pools (step 6) are sealed in stone and NOT reachable
  //     without digging, so a bare WATER count near spawn does not prove the
  //     §5.3 "within reach" guarantee. We therefore always carve one surface
  //     source the colony can actually drink from when the guarantee is on:
  //     an open-topped basin (reachable) walled in stone (won't drain).
  if (SPAWN_GUARANTEE_WATER) {
    const waterX = clampX(spawnX + GUARANTEE_WATER_OFFSET);
    carveSurfacePond(waterX, surfaceY[waterX]);
  }

  // 10. Starter camp (Task W5, GDD §8/§10): an OPEN-SIDED roofed WOOD canopy
  //     centred on the spawn column so the colony LIVES under a warm roof on the
  //     cold world AND can freely walk out for water/food. Built LAST so it
  //     overwrites any woodland/surface noise inside its footprint with a clean,
  //     flat, sheltered span.
  const shelterPoint = buildStarterCamp(spawnX, spawnSurface);

  return { spawnX, spawnY, stockpilePoint, zombieEdge, shelterPoint };
}

/**
 * Build the starter-camp shelter (Task W5, revised for the OPEN-CAMP model —
 * GDD §8 "enclosed space that provides warmth AND a retreat point"): a WOOD
 * ROOF CANOPY centred at (cx) whose floor sits at `groundRow`, with OPEN SIDES
 * so the colony warms under the roof yet freely walks OUT for water/food.
 * Returns a standable, SHELTERED feet-cell under the canopy (camp centre).
 *
 * THE FIX: the old model walled BOTH sides of the nook, sealing survivors into
 * a box they could not path out of — so a warm colony died of THIRST (no route
 * to the pond/grove). A roof-only canopy keeps them warm (isSheltered reads the
 * roof overhead) while leaving every side open to walk through.
 *
 * Geometry (see CAMP_* in config and the roof-only shelter probe in survivor.ts):
 *   feetRow  = groundRow - 1            (a body stands here, floor below it)
 *   headRow  = feetRow - (BODY_H - 1)   (top of the figure)
 *   roofRow  = headRow - CAMP_ROOF_CLEARANCE   (a few cells ABOVE the head)
 *   roof     : row roofRow, columns cx-HALF .. cx+HALF (WOOD span)
 *   posts    : a FEW WOOD cells hanging from each roof END, ABOVE the head row
 *              only — decorative/structural corner posts that do NOT span the
 *              body height, so they never block horizontal exit (open sides).
 * The interior is cleared to AIR and the floor filled solid so a body stands
 * cleanly on a flat span; the roof clears the head + the burial-pin probe but
 * stays inside SHELTER_ROOF_SCAN so isShelteredAt detects it. placeMaterial
 * seeds WOOD integrity so the camp is breachable later (GDD §7.4 / §8 "must
 * hold against breaching").
 */
function buildStarterCamp(cx: number, groundRow: number): { x: number; y: number } {
  const feetRow = groundRow - 1;
  const headRow = feetRow - (BODY_H - 1);
  const roofRow = headRow - CAMP_ROOF_CLEARANCE;
  const leftX = cx - CAMP_HALF_WIDTH;
  const rightX = cx + CAMP_HALF_WIDTH;

  for (let x = leftX; x <= rightX; x++) {
    if (x < 0 || x >= WORLD_W) continue;
    // Clear the interior (and any surface bump/foliage inside it) down to the
    // feet row, so the canopy is open and standable from the roof to the floor.
    for (let y = roofRow + 1; y <= feetRow; y++) put(x, y, AIR);
    // Fill a solid DIRT floor from the floor row down to the first natural solid
    // cell, so the camp floor is always supported (never a floating slab that
    // the falling-sand sim would drop) even where the local surface dips.
    for (let y = groundRow; y < WORLD_H; y++) {
      if (isSolidForBody(material[idx(x, y)])) break; // reached natural ground
      put(x, y, DIRT);
    }
  }

  // WOOD roof spanning the canopy, a few cells above the head — placeMaterial
  // seeds WOOD integrity (breachable).
  for (let x = leftX; x <= rightX; x++) {
    if (x < 0 || x >= WORLD_W) continue;
    placeMaterial(x, roofRow, WOOD);
  }

  // No body-height posts: a clean WOOD canopy with OPEN sides. (Earlier corner
  // posts at rows roofRow+1..headRow-2 wedged a body that did a step-up near the
  // edge — a raised head at headRow-STEP_UP_MAX collides them — stranding the
  // colony. The roof alone (a few cells above the head) is what `isSheltered`
  // keys on, so survivors walk freely in/out underneath it.)

  return { x: cx, y: feetRow };
}

// ---------------------------------------------------------------------------
// Helpers (all bounds-safe; write straight into the typed arrays).
// ---------------------------------------------------------------------------

function clampX(x: number): number {
  if (x < 0) return 0;
  if (x > WORLD_W - 1) return WORLD_W - 1;
  return x;
}

/** Set a cell's material (and seed/clear its integrity to match the material). */
function put(x: number, y: number, id: number): void {
  if (!inBounds(x, y)) return;
  const i = idx(x, y);
  material[i] = id;
  const m = MATERIALS[id];
  integrity[i] = m && m.hasIntegrity ? m.baseIntegrity : 0;
}

/**
 * Fill a filled circle of `id`. If onlySolid, only overwrite existing solid
 * terrain (DIRT/STONE/SAND/ORE) — never AIR/WATER/FOLIAGE — so pockets stay
 * underground and never punch into the sky.
 */
function fillBlob(cx: number, cy: number, r: number, id: number, onlySolid: boolean): void {
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(x, y)) continue;
      if (onlySolid) {
        const cur = material[idx(x, y)];
        if (cur !== DIRT && cur !== STONE && cur !== SAND && cur !== ORE) continue;
      }
      put(x, y, id);
    }
  }
}

/** Short random-walk that converts STONE→ORE (GDD §5.3 ore veins). */
function walkVein(rng: () => number, sx: number, sy: number): void {
  let x = sx;
  let y = sy;
  for (let step = 0; step < ORE_VEIN_LEN; step++) {
    if (!inBounds(x, y) || material[idx(x, y)] !== STONE) break;
    material[idx(x, y)] = ORE; // ORE has no integrity → no seeding needed
    // 8-neighbour wander.
    const dir = Math.floor(rng() * 8);
    const dx = [-1, 0, 1, -1, 1, -1, 0, 1][dir];
    const dy = [-1, -1, -1, 0, 0, 1, 1, 1][dir];
    x += dx;
    y += dy;
  }
}

/**
 * Carve a sealed underground WATER pocket: an ellipse where ONLY STONE cells
 * become WATER. Because the pocket sits deep in solid stone, the unconverted
 * ring around it remains stone — a contained floor + walls that will not drain
 * when the sim runs (GDD §5.3 contained water table).
 */
function carveSealedPool(cx: number, cy: number, halfW: number, halfH: number): void {
  const aw2 = halfW * halfW;
  const ah2 = halfH * halfH;
  for (let dy = -halfH; dy <= halfH; dy++) {
    for (let dx = -halfW; dx <= halfW; dx++) {
      // Keep a 1-cell margin inside the ellipse edge so a stone shell remains.
      if ((dx * dx) / aw2 + (dy * dy) / ah2 > 0.82) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(x, y)) continue;
      if (material[idx(x, y)] !== STONE) continue; // only ever inside stone
      material[idx(x, y)] = WATER; // WATER has no integrity
    }
  }
}

/**
 * Place one woodland cluster ON the surface: FOLIAGE columns rising
 * FOLIAGE_HEIGHT (with a little per-column variation) into the AIR above the
 * local surface row (GDD §5.3 trees + bushes). Foliage is placed via put() so
 * its integrity seeds (chop/breach read it).
 */
function placeWoodland(rng: () => number, cx: number, surfaceY: Int32Array): void {
  const half = WOODLAND_CLUSTER_W >> 1;
  for (let dx = -half; dx <= half; dx++) {
    const x = cx + dx;
    if (x < 0 || x >= WORLD_W) continue;
    // Taper the canopy toward the cluster edges for a rounded clump.
    const edge = 1 - Math.abs(dx) / (half + 1);
    const h = Math.max(1, Math.round(FOLIAGE_HEIGHT * (0.55 + 0.45 * edge) + (rng() - 0.5) * 2));
    const top = surfaceY[x];
    for (let k = 1; k <= h; k++) put(x, top - k, FOLIAGE);
  }
}

/**
 * Guaranteed dense grove for the spawn zone — a wide, full-height FOLIAGE block
 * so the FOLIAGE count comfortably clears SPAWN_GUARANTEE_WOOD_CELLS within
 * reach of home (GDD §5.3 spawn wood guarantee).
 */
function placeGuaranteedGrove(cx: number, surfaceY: Int32Array): void {
  const half = WOODLAND_CLUSTER_W >> 1;
  for (let dx = -half; dx <= half; dx++) {
    const x = cx + dx;
    if (x < 0 || x >= WORLD_W) continue;
    const top = surfaceY[x];
    for (let k = 1; k <= FOLIAGE_HEIGHT; k++) put(x, top - k, FOLIAGE);
  }
}

/**
 * Carve an open-topped, contained pond at the surface near spawn (GDD §5.3
 * spawn water guarantee). The interior is excavated to WATER and ringed with a
 * STONE floor + side walls, so it is BOTH reachable from the surface (a survivor
 * stands on the rim and drinks) AND will not drain when the sim runs.
 */
function carveSurfacePond(cx: number, surfaceRow: number): void {
  const left = cx - SPAWN_POND_HALF_W;
  const right = cx + SPAWN_POND_HALF_W;
  const floor = surfaceRow + SPAWN_POND_DEPTH; // stone floor row

  for (let x = left; x <= right; x++) {
    if (x < 0 || x >= WORLD_W) continue;
    const isWall = x === left || x === right;
    for (let y = surfaceRow; y <= floor; y++) {
      if (isWall || y === floor) {
        put(x, y, STONE); // side walls + floor seal the basin
      } else {
        put(x, y, WATER); // interior column of water, open at the top
      }
    }
    // Strip any foliage sitting directly over the open water so it is drinkable.
    for (let k = 1; k <= FOLIAGE_HEIGHT && !isWall; k++) {
      if (material[idx(x, surfaceRow - k)] === FOLIAGE) put(x, surfaceRow - k, AIR);
    }
  }
}

/**
 * Count cells of `id` within `radius` columns of `cx` (full column height).
 * Used by the spawn-zone guarantees (GDD §5.3).
 */
function countMaterialNear(cx: number, id: number, radius: number): number {
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(WORLD_W - 1, cx + radius);
  let n = 0;
  for (let x = x0; x <= x1; x++) {
    for (let y = 0; y < WORLD_H; y++) {
      if (material[idx(x, y)] === id) n++;
    }
  }
  return n;
}
