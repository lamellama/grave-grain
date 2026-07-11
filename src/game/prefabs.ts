/**
 * game/prefabs.ts - purchasable PRE-BUILT structures (round 11, GDD 8/6.1).
 *
 * "Pre-built structures that can be purchased with enough resources": the
 * player taps a site with a prefab verb and the WHOLE structure is placed at
 * once, paid ATOMICALLY from the colony stockpile at the same per-cell prices
 * the manual verbs charge (resources.spend - all or nothing, no half-huts).
 *
 * Two prefabs here (+ the 1-cell 'spike' trap, which is an ordinary Build
 * structure in building.ts):
 *
 *   HUT - the planShelter geometry (WALL columns + WOOD roof + full-height
 *   DOOR on the right) with the interior carved clear and the CAMPFIRE
 *   already lit inside ("huts, with campfires inside"). Since round 11 the
 *   hut IS the camp: survivors no longer plan their own shelters (the R9 camp
 *   flag is retired) - buying a hut re-homes the colony to it (main watches
 *   getHutVersion), the roof makes isSheltered() pass inside, and the hearth
 *   feeds the warmth need.
 *
 *   WELL - a stone-lined basin ("the water will not soak into the ground":
 *   applySoak only drains water resting on DIRT/SAND, and the lining is
 *   stone) holding a 3x2 pool flush with the surface, under a raised stone
 *   collar and a WOOD cap. The collar is taller than STEP_UP_MAX so no body
 *   can wander/climb in ("make sure people don't get stuck inside them") and
 *   the cap hides the pool from the sky, so clear-weather evaporation never
 *   sees it either - survivors drink from outside the collar (the water lies
 *   within CONSUME_REACH of the rim stand cells) and drinking never consumes
 *   water, so a well is permanent.
 *
 * The stone shell is written as NATIVE stone (integrity slot 0): mortared,
 * never falls, and - unlike round-11 loose blocks - not gnawable, exactly
 * like the worldgen pond basins. Pure over (grid, stockpile); no DOM, no RNG.
 * Module-level hut registry + reset(), mirroring camp.ts.
 */

import type { ResourceKind } from './resources';
import * as resources from './resources';
import { get, set, setIntegrity, placeMaterial, inBounds } from '../engine/grid';
import { markTerrainEdit } from '../engine/navgrid';
import {
  AIR,
  STONE,
  WATER,
  WOOD,
  WALL,
  DOOR,
  CAMPFIRE,
  isSolidForBody,
} from '../engine/materials';
import {
  WORLD_W,
  WORLD_H,
  SHELTER_MIN_WIDTH,
  SHELTER_WALL_HEIGHT,
  SHELTER_DOORWAY_HEIGHT,
  FENCE_COST,
  WALL_COST,
  DOOR_COST,
  CAMPFIRE_COST,
} from '../config';

export type PrefabKind = 'hut' | 'well';

/** One cell of a prefab plan. `native` stone is written with integrity 0. */
interface PrefabCell {
  x: number;
  y: number;
  id: number;
  native?: boolean;
}

/** A sited, priced prefab ready to place. */
export interface PrefabPlan {
  kind: PrefabKind;
  cells: PrefabCell[];
  cost: Partial<Record<ResourceKind, number>>;
  /** A representative standable interior cell (hut) / the pool top (well). */
  anchor: { x: number; y: number };
}

// ---------------------------------------------------------------------------
// Hut registry - the huts ARE the camp (round 11; replaces the R9 flag)
// ---------------------------------------------------------------------------

export interface Hut {
  /** Standable interior cell (feet row) - the re-home target. */
  x: number;
  y: number;
}

const huts: Hut[] = [];
let hutVersion = 0;

/** All placed huts, oldest first. */
export function getHuts(): readonly Hut[] {
  return huts;
}

/** Bumped on every hut purchase; 0 = none yet (main watches this to re-home). */
export function getHutVersion(): number {
  return hutVersion;
}

/** The most recently purchased hut, or null. */
export function latestHut(): Hut | null {
  return huts.length > 0 ? huts[huts.length - 1] : null;
}

/** Reset the registry (new-game init / test harness). */
export function resetHuts(): void {
  huts.length = 0;
  hutVersion = 0;
}

// ---------------------------------------------------------------------------
// Siting
// ---------------------------------------------------------------------------

/**
 * Snap a tap to the local STANDING row (the open cell whose below is solid) -
 * the plantCampFlagAt rule: a tap in the air drops to the surface, a tap
 * inside the ground rises to the first open cell above it. Returns null when
 * the column has no such row.
 */
function snapToStand(x: number, y: number): { x: number; y: number } | null {
  const cx = Math.max(0, Math.min(WORLD_W - 1, Math.round(x)));
  let cy = Math.max(0, Math.min(WORLD_H - 1, Math.round(y)));
  if (isSolidForBody(get(cx, cy))) {
    while (cy > 0 && isSolidForBody(get(cx, cy))) cy--;
    if (isSolidForBody(get(cx, cy))) return null; // solid to the sky
  } else {
    while (cy < WORLD_H - 1 && !isSolidForBody(get(cx, cy + 1))) cy++;
    if (!isSolidForBody(get(cx, cy + 1))) return null; // open to the void
  }
  return { x: cx, y: cy };
}

/** Sum helper: add `n` cells of a per-cell cost into `total`. */
function addCost(
  total: Partial<Record<ResourceKind, number>>,
  per: Partial<Record<ResourceKind, number>>,
  n: number,
): void {
  for (const k of Object.keys(per) as ResourceKind[]) {
    total[k] = (total[k] ?? 0) + (per[k] ?? 0) * n;
  }
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * Plan a HUT centred on the tap (pure - nothing written): the planShelter
 * geometry at the fixed SHELTER_MIN_WIDTH interior, plus the interior carve
 * and the lit hearth. Returns null when the site doesn't fit.
 */
export function planHutAt(x: number, y: number): PrefabPlan | null {
  const stand = snapToStand(x, y);
  if (!stand) return null;
  const iw = SHELTER_MIN_WIDTH;
  let leftWallX = stand.x - Math.floor(iw / 2) - 1;
  let rightWallX = leftWallX + iw + 1;
  if (leftWallX < 1) {
    leftWallX = 1;
    rightWallX = leftWallX + iw + 1;
  }
  if (rightWallX > WORLD_W - 2) {
    rightWallX = WORLD_W - 2;
    leftWallX = rightWallX - iw - 1;
    if (leftWallX < 1) return null;
  }
  const feetRow = stand.y;
  const roofRow = feetRow - (SHELTER_WALL_HEIGHT - 1);
  if (roofRow < 1 || feetRow >= WORLD_H - 1) return null;

  const cells: PrefabCell[] = [];

  // Interior carve first (walls/door/hearth overwrite their own cells after).
  for (let cx = leftWallX + 1; cx <= rightWallX - 1; cx++) {
    for (let cy = roofRow + 1; cy <= feetRow; cy++) {
      cells.push({ x: cx, y: cy, id: AIR });
    }
  }

  // Roof: WOOD span across the full width (wall tops included).
  let roofN = 0;
  for (let cx = leftWallX; cx <= rightWallX; cx++) {
    cells.push({ x: cx, y: roofRow, id: WOOD });
    roofN++;
  }

  // Left wall: full-height WALL.
  let wallN = 0;
  for (let cy = roofRow + 1; cy <= feetRow; cy++) {
    cells.push({ x: leftWallX, y: cy, id: WALL });
    wallN++;
  }

  // Right wall: WALL above the doorway, full-height DOOR below (the living
  // walk through; the undead must gnaw - the planShelter shape).
  const doorTop = feetRow - SHELTER_DOORWAY_HEIGHT;
  let doorN = 0;
  for (let cy = roofRow + 1; cy <= doorTop; cy++) {
    cells.push({ x: rightWallX, y: cy, id: WALL });
    wallN++;
  }
  for (let cy = doorTop + 1; cy <= feetRow; cy++) {
    cells.push({ x: rightWallX, y: cy, id: DOOR });
    doorN++;
  }

  // The hearth, already lit, at the interior's left end (away from the door).
  cells.push({ x: leftWallX + 1, y: feetRow, id: CAMPFIRE });

  const cost: Partial<Record<ResourceKind, number>> = {};
  addCost(cost, WALL_COST, wallN);
  addCost(cost, FENCE_COST, roofN);
  addCost(cost, DOOR_COST, doorN);
  addCost(cost, CAMPFIRE_COST, 1);

  return {
    kind: 'hut',
    cells,
    cost,
    anchor: { x: Math.round((leftWallX + rightWallX) / 2), y: feetRow },
  };
}

// Well geometry half-width: pool spans cx-1..cx+1, shell spans cx-2..cx+2.
const WELL_HALF = 2;

/**
 * Plan a WELL centred on the tap (pure): stone floor + side columns sunk into
 * the ground holding a 3-wide, 2-deep pool flush with the surface; a raised
 * stone collar (3 cells - taller than STEP_UP_MAX, nothing wanders in) and a
 * WOOD cap (sky can't see the pool - no evaporation, and rain isn't needed:
 * drinking never consumes water). Returns null when the site doesn't fit.
 */
export function planWellAt(x: number, y: number): PrefabPlan | null {
  const stand = snapToStand(x, y);
  if (!stand) return null;
  const cx = stand.x;
  const S = stand.y + 1; // first solid row (the surface the pool sits flush with)
  const floorRow = S + 2; // stone floor under the 2-deep pool
  const capRow = S - 5; // WOOD cap above the 3-tall collar + 1 air gap
  if (cx - WELL_HALF < 1 || cx + WELL_HALF > WORLD_W - 2) return null;
  if (floorRow >= WORLD_H - 1 || capRow < 1) return null;

  const cells: PrefabCell[] = [];
  let stoneN = 0;
  let woodN = 0;

  // Side columns: native stone from just under the cap down to the floor row.
  // They MEET the cap - no gap a slope-walking body could step through into
  // the shaft (the "don't get stuck inside" guarantee is a sealed shell).
  for (const sx of [cx - WELL_HALF, cx + WELL_HALF]) {
    for (let cy = capRow + 1; cy <= floorRow; cy++) {
      cells.push({ x: sx, y: cy, id: STONE, native: true });
      stoneN++;
    }
  }
  // Floor: native stone across the pool width.
  for (let px = cx - WELL_HALF + 1; px <= cx + WELL_HALF - 1; px++) {
    cells.push({ x: px, y: floorRow, id: STONE, native: true });
    stoneN++;
  }
  // Pool: 3 wide, 2 deep, top row flush with the surface.
  for (let px = cx - WELL_HALF + 1; px <= cx + WELL_HALF - 1; px++) {
    for (let cy = S; cy <= S + 1; cy++) {
      cells.push({ x: px, y: cy, id: WATER });
    }
  }
  // Head space between collar walls, under the cap: carved clear.
  for (let px = cx - WELL_HALF + 1; px <= cx + WELL_HALF - 1; px++) {
    for (let cy = S - 4; cy <= S - 1; cy++) {
      cells.push({ x: px, y: cy, id: AIR });
    }
  }
  // Cap: a WOOD lid across the full shell width.
  for (let px = cx - WELL_HALF; px <= cx + WELL_HALF; px++) {
    cells.push({ x: px, y: capRow, id: WOOD });
    woodN++;
  }

  const cost: Partial<Record<ResourceKind, number>> = {};
  addCost(cost, WALL_COST, stoneN); // stone shell priced like wall cells
  addCost(cost, FENCE_COST, woodN); // wood cap priced like fence cells

  return { kind: 'well', cells, cost, anchor: { x: cx, y: S - 1 } };
}

// ---------------------------------------------------------------------------
// Pricing + placement
// ---------------------------------------------------------------------------

// Prefab prices are site-independent (fixed geometry), so compute each once
// from a nominal mid-world plan for the toolbar affordability greying.
function nominalCost(kind: PrefabKind): Partial<Record<ResourceKind, number>> {
  const iw = SHELTER_MIN_WIDTH;
  if (kind === 'hut') {
    const wallN =
      (SHELTER_WALL_HEIGHT - 1) + (SHELTER_WALL_HEIGHT - 1 - SHELTER_DOORWAY_HEIGHT);
    const cost: Partial<Record<ResourceKind, number>> = {};
    addCost(cost, WALL_COST, wallN);
    addCost(cost, FENCE_COST, iw + 2);
    addCost(cost, DOOR_COST, SHELTER_DOORWAY_HEIGHT);
    addCost(cost, CAMPFIRE_COST, 1);
    return cost;
  }
  const cost: Partial<Record<ResourceKind, number>> = {};
  addCost(cost, WALL_COST, 2 * 7 + 3); // side columns (capRow+1..floorRow) + floor
  addCost(cost, FENCE_COST, 2 * WELL_HALF + 1); // cap
  return cost;
}

const PREFAB_COST: Record<PrefabKind, Partial<Record<ResourceKind, number>>> = {
  hut: nominalCost('hut'),
  well: nominalCost('well'),
};

/** The fixed price of a prefab (for toolbar greying / tooltips). */
export function prefabCost(kind: PrefabKind): Partial<Record<ResourceKind, number>> {
  return PREFAB_COST[kind];
}

/** True if the stockpile can afford this prefab right now. */
export function canPlacePrefab(kind: PrefabKind): boolean {
  return resources.canAfford(PREFAB_COST[kind]);
}

/**
 * Purchase + place a prefab at the tap point: plan the geometry, spend the
 * stockpile ATOMICALLY (bails placing nothing if unaffordable or unsiteable),
 * then write every cell and notify the navgrid. A placed HUT joins the camp
 * registry and bumps the hut version (main re-homes the colony). Returns
 * true iff placed and paid for.
 */
export function placePrefabAt(kind: PrefabKind, x: number, y: number): boolean {
  const plan = kind === 'hut' ? planHutAt(x, y) : planWellAt(x, y);
  if (!plan) return false;
  if (!resources.spend(plan.cost)) return false;

  for (const c of plan.cells) {
    if (!inBounds(c.x, c.y)) continue;
    if (c.native) {
      // NATIVE stone: mortared, never falls, not gnawable (worldgen-style).
      set(c.x, c.y, c.id);
      setIntegrity(c.x, c.y, 0);
    } else {
      placeMaterial(c.x, c.y, c.id);
    }
    markTerrainEdit(c.x, c.y);
  }

  if (kind === 'hut') {
    huts.push({ x: plan.anchor.x, y: plan.anchor.y });
    hutVersion++;
  }
  return true;
}
