/**
 * engine/materials.ts — Material definitions and properties
 * Data-oriented material table indexed by id (GDD §5.2, AGENTS §4).
 * Designed to extend into Phase 2+ without rewrite.
 */

import {
  DENSITY_AIR,
  DENSITY_WATER,
  DENSITY_SAND,
  DENSITY_STONE,
} from '../config';

/**
 * Material type definition — strict shape for all material rows.
 * Phase 2+ adds more properties; this is the MVP minimal set that supports
 * falling sand, water flow, fire spread, and zombie breaching.
 */
export interface Material {
  name: string;
  color: string; // hex color for rendering
  density: number; // 0–255; heavier displaces lighter; 255=immovable static
  isFluid: boolean; // true for water/liquids (spreads horizontally)
  isStatic: boolean; // true for stone (density=255, doesn't move)
  flammable: boolean; // true if fire can spread to/from this material
  permeableToBodies: boolean; // true only for foliage (characters pass through)
  hasIntegrity: boolean; // true for structures that can be breached
  baseIntegrity: number; // starting integrity value (Phase 2+)
}

// Material IDs (MVP Phase 1 set only — GDD §5.2, PLAN §14)
export const AIR = 0;
export const SAND = 1;
export const STONE = 2;
export const WATER = 3;

/**
 * MATERIALS — indexed lookup table of material properties.
 * Access: MATERIALS[SAND].name → "sand"
 * Indexed by material id to allow `MATERIALS[gridCell]` queries (GDD §5.2).
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
