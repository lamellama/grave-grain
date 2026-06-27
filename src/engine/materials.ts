/**
 * engine/materials.ts - Material definitions and properties
 * Data-oriented material table indexed by id (GDD 5.2, AGENTS 4).
 * Designed to extend into Phase 2+ without rewrite.
 */

import {
  DENSITY_AIR,
  DENSITY_WATER,
  DENSITY_SAND,
  DENSITY_STONE,
  DENSITY_DIRT,
  DENSITY_ASH,
  DENSITY_FIRE,
  DENSITY_SMOKE,
  DENSITY_FLESH,
  DENSITY_BONE,
  DENSITY_BLOOD,
  DENSITY_SNOW,
  WOOD_INTEGRITY,
  FOLIAGE_INTEGRITY,
  WALL_INTEGRITY,
} from '../config';

/**
 * Material type definition - strict shape for all material rows.
 * Phase 2+ adds more properties; this is the MVP minimal set that supports
 * falling sand, water flow, fire spread, and zombie breaching.
 */
export interface Material {
  name: string;
  color: string; // hex color for rendering
  density: number; // 0-255; heavier displaces lighter; 255=immovable static
  isFluid: boolean; // true for water/liquids (spreads horizontally)
  isStatic: boolean; // true for stone (density=255, doesn't move)
  flammable: boolean; // true if fire can spread to/from this material
  permeableToBodies: boolean; // true only for foliage (characters pass through)
  hasIntegrity: boolean; // true for structures that can be breached
  baseIntegrity: number; // starting integrity value (Phase 2+)
}

// Material IDs - Phase 1 (GDD 5.2, PLAN 14)
export const AIR = 0;
export const SAND = 1;
export const STONE = 2;
export const WATER = 3;
// Material IDs - Phase 2 additions (do NOT renumber above)
export const DIRT = 4;
export const ORE = 5;
export const WOOD = 6;
export const FOLIAGE = 7;
export const FIRE = 8;
export const SMOKE = 9;   // doubles as steam
export const ASH = 10;
// Material IDs - Phase 4 body matter (GDD 5.2; do NOT renumber above)
export const FLESH = 11;
export const BONE = 12;
export const BLOOD = 13;
// Material IDs - Phase 8 player building (GDD 8; do NOT renumber above)
export const WALL = 14;
// Material ID - plant-a-seed growth (post-MVP backlog, GDD 9; do NOT renumber)
export const SAPLING = 15;
// Material IDs - Weather & Temperature (GDD 10, Beyond T1; do NOT renumber)
export const SNOW = 16;
// Material ID - VS-2 campfire (managed contained fire, GDD 8/6.1; do NOT renumber)
export const CAMPFIRE = 17;

/**
 * MATERIALS - indexed lookup table of material properties.
 * Access: MATERIALS[SAND].name -> "sand"
 * Indexed by material id to allow `MATERIALS[gridCell]` queries (GDD 5.2).
 * Phase 2+ extends this with DIRT, ORE, WOOD, FOLIAGE, FIRE, etc.
 */
export const MATERIALS: Material[] = [
  // AIR (id=0)
  {
    name: 'air',
    color: '#1a1a1a', // dark background
    density: DENSITY_AIR,
    isFluid: false,
    isStatic: false,
    flammable: false,
    permeableToBodies: true,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // SAND (id=1)
  {
    name: 'sand',
    color: '#d9c27a', // sandy tan
    density: DENSITY_SAND,
    isFluid: false,
    isStatic: false,
    flammable: false,
    permeableToBodies: false,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // STONE (id=2)
  {
    name: 'stone',
    color: '#6b6b6b', // dark gray
    density: DENSITY_STONE,
    isFluid: false,
    isStatic: true,
    flammable: false,
    permeableToBodies: false,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // WATER (id=3)
  {
    name: 'water',
    color: '#3a6ea5', // blue
    density: DENSITY_WATER,
    isFluid: true,
    isStatic: false,
    flammable: false,
    permeableToBodies: false,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // DIRT (id=4)
  {
    name: 'dirt',
    color: '#7a5230', // brown
    density: DENSITY_DIRT,
    isFluid: false,
    isStatic: false,
    flammable: false,
    permeableToBodies: false,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // ORE (id=5)
  {
    name: 'ore',
    color: '#b8a14a', // speckled grey/gold
    density: DENSITY_STONE, // static
    isFluid: false,
    isStatic: true,
    flammable: false,
    permeableToBodies: false,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // WOOD (id=6)
  {
    name: 'wood',
    color: '#5a3a1a', // dark brown
    density: DENSITY_STONE, // static
    isFluid: false,
    isStatic: true,
    flammable: true,
    permeableToBodies: false,
    hasIntegrity: true,
    baseIntegrity: WOOD_INTEGRITY,
  },
  // FOLIAGE (id=7)
  {
    name: 'foliage',
    color: '#3a7a2a', // green
    density: DENSITY_STONE, // static
    isFluid: false,
    isStatic: true,
    flammable: true,
    permeableToBodies: true,
    hasIntegrity: true,
    baseIntegrity: FOLIAGE_INTEGRITY,
  },
  // FIRE (id=8)
  {
    name: 'fire',
    color: '#ff7016', // orange
    density: DENSITY_FIRE,
    isFluid: false,
    isStatic: false,
    flammable: false,
    permeableToBodies: false,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // SMOKE (id=9) - doubles as steam
  {
    name: 'smoke',
    color: '#9a9a9a', // light grey
    density: DENSITY_SMOKE,
    isFluid: false,
    isStatic: false,
    flammable: false,
    permeableToBodies: false,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // ASH (id=10)
  {
    name: 'ash',
    color: '#3a3a3a', // dark grey
    density: DENSITY_ASH,
    isFluid: false,
    isStatic: false,
    flammable: false,
    permeableToBodies: false,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // FLESH (id=11) - body matter: flammable, bleeds when damaged (GDD 5.2).
  // A live body pixel and the cell it sheds share this colour & resolution -
  // that match is the load-bearing illusion (GDD 14 gate point 5).
  {
    name: 'flesh',
    color: '#b5503f', // red-meat
    density: DENSITY_FLESH,
    isFluid: false,
    isStatic: false,
    flammable: true,
    permeableToBodies: false,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // BONE (id=12) - body matter: rigid, harder to destroy than flesh (GDD 5.2).
  {
    name: 'bone',
    color: '#e8e0cf', // off-white
    density: DENSITY_BONE,
    isFluid: false,
    isStatic: false,
    flammable: false,
    permeableToBodies: false,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // BLOOD (id=13) - body matter: thin fluid, stains, DOUSES NOTHING (GDD 5.2).
  {
    name: 'blood',
    color: '#7a1414', // dark red
    density: DENSITY_BLOOD,
    isFluid: true,
    isStatic: false,
    flammable: false,
    permeableToBodies: false,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // WALL (id=14) - player-placed STONE wall: "the real barrier" (GDD 8).
  // hasIntegrity:true with a HIGH baseIntegrity so breaching (7.4) chips it
  // slowly, unlike raw STONE (id=2, hasIntegrity:false -> never breached) and
  // unlike the cheap, flammable WOOD fence. A bluer/lighter grey distinguishes
  // it from raw stone (#6b6b6b) on screen.
  {
    name: 'wall',
    color: '#8a93a0', // light blue-grey, distinct from raw stone
    density: DENSITY_STONE, // static, immovable
    isFluid: false,
    isStatic: true,
    flammable: false,
    permeableToBodies: false,
    hasIntegrity: true,
    baseIntegrity: WALL_INTEGRITY,
  },
  // SAPLING (id=15) - a planted seed that grows UPWARD into FOLIAGE over time
  // (post-MVP backlog, GDD 9: "plants grow over time on suitable soil; water
  // accelerates growth"). It does NOT fall like a powder and is NOT a static
  // structure: it stays pinned in place and matures via the growth rule
  // (simulation.updateSapling), which reuses the integrity slot as a growth
  // countdown. A young yellow-green sprout colour, distinct from grown FOLIAGE's
  // deeper green (#3a7a2a). permeableToBodies so survivors/zombies walk straight
  // through it like foliage (isSolidForBody -> false). flammable (a sapling can
  // burn). No structural integrity: the integrity slot is the growth timer, not
  // a breach value, so hasIntegrity:false / baseIntegrity:0.
  {
    name: 'sapling',
    color: '#9ccb5a', // young yellow-green sprout (distinct from foliage green)
    density: DENSITY_ASH, // light; never used to displace (it doesn't fall/swap)
    isFluid: false,
    isStatic: false, // pinned by the growth rule, NOT by the static fast-path
    flammable: true,
    permeableToBodies: true, // walk through like foliage (GDD 5.2 / 9)
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // SNOW (id=16) - Weather & Temperature (GDD 10, Beyond T1). A light powder
  // that falls from the sky during snow weather (T2) and melts to WATER near
  // heat (T3). Lighter than sand/ash so it settles above other materials.
  // No behaviour in this task - table entry only (behaviour added in T2-T5).
  {
    name: 'snow',
    color: '#ebf0ff', // pale blue-white (rgb ~235,240,255)
    density: DENSITY_SNOW,
    isFluid: false,
    isStatic: false,
    flammable: false,
    permeableToBodies: false,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
  // CAMPFIRE (id=17) - VS-2 Task T-C: a MANAGED contained fire (GDD 8/6.1).
  // A long-burning HEAT SOURCE that warms survivors (the warmth detectors count
  // it) but, unlike raw spreading FIRE (id=8), NEVER spreads and NEVER ignites
  // bodies - the flee/ignition checks all key on FIRE, so a CAMPFIRE warms a camp
  // without eating structures. Density DENSITY_FIRE (static-in-place like fire;
  // its rule never moves it). flammable:false (it doesn't itself catch). No
  // structural integrity: the integrity slot is REUSED as a fuel countdown
  // (simulation.updateCampfire), exactly the FIRE-lifetime / SAPLING-growth
  // trick, so hasIntegrity:false / baseIntegrity:0 (seeded to CAMPFIRE_FUEL on
  // first visit). A deeper ember-red than fire orange, to read as a hearth.
  {
    name: 'campfire',
    color: '#e0571a', // ember red-orange, distinct from fire #ff7016
    density: DENSITY_FIRE,
    isFluid: false,
    isStatic: false, // pinned by its rule (never moved), NOT the static fast-path
    flammable: false,
    permeableToBodies: false,
    hasIntegrity: false,
    baseIntegrity: 0,
  },
];

/**
 * Helper: get density of a material by id.
 * Safe out-of-range: returns DENSITY_AIR.
 */
export function density(id: number): number {
  if (id < 0 || id >= MATERIALS.length) {
    return DENSITY_AIR;
  }
  return MATERIALS[id].density;
}

/**
 * Helper: is a material a fluid? (spreads horizontally to seek level)
 * Safe out-of-range: returns false.
 */
export function isFluid(id: number): boolean {
  if (id < 0 || id >= MATERIALS.length) {
    return false;
  }
  return MATERIALS[id].isFluid;
}

/**
 * Helper: is a material static? (immovable, like stone)
 * Safe out-of-range: returns false.
 */
export function isStatic(id: number): boolean {
  if (id < 0 || id >= MATERIALS.length) {
    return false;
  }
  return MATERIALS[id].isStatic;
}

/**
 * Helper: is a material flammable? (fire can spread to/from it - WOOD/FOLIAGE)
 * Safe out-of-range: returns false.
 */
export function isFlammable(id: number): boolean {
  if (id < 0 || id >= MATERIALS.length) {
    return false;
  }
  return MATERIALS[id].flammable;
}

/**
 * Helper: does a material BLOCK a living body? (locomotion collision - GDD 5.1)
 * Solid for everything EXCEPT the cells a body passes/falls through: AIR, WATER,
 * FIRE, SMOKE, BLOOD, plus any material flagged `permeableToBodies`.
 *
 * GDD 5.2 / 9: FOLIAGE is the one solid material bodies IGNORE for collision -
 * survivors and zombies walk straight through woodland (foliage still blocks
 * fluids and acts as fire fuel; harvest is by reach/adjacency, not overlap).
 * That is expressed by its `permeableToBodies` flag, so we honour it here rather
 * than hard-coding FOLIAGE: SAND/STONE/DIRT/ORE/WOOD/ASH/FLESH/BONE stay solid.
 * Out-of-range ids are treated as solid (fail safe - never tunnel).
 *
 * BLOOD (Phase 4) joins the non-solid set: it is a thin fluid, so a body must
 * not stand on a blood smear (loose FLESH/BONE piles still bury & support).
 */
export function isSolidForBody(id: number): boolean {
  if (id < 0 || id >= MATERIALS.length) return true; // out-of-range -> solid (fail safe)
  if (MATERIALS[id].permeableToBodies) return false; // foliage et al. - walk through
  return !(id === AIR || id === WATER || id === FIRE || id === SMOKE || id === BLOOD);
}

