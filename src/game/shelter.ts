/**
 * game/shelter.ts - per-group shelter PROJECT planning (VS-3, GDD 8/6.1).
 *
 * Each survivor GROUP (groups.ts) owns at most ONE shelter project: a roofed hut
 * sited near the group's centroid, sized by member count. The project is a
 * BLUEPRINT - a list of structure cells (left/right WALL columns + a WOOD roof)
 * plus a DOORWAY (a full-height gap on one side so survivors can walk in/out -
 * a sealed box would trap and kill the colony, the VS-2 open-camp lesson) and a
 * campfire spot inside. T3 hands these cells to the builder/blueprint queue;
 * here we only PLAN the geometry and own one project per group.
 *
 * The roof is the functional part: a body standing on the interior floor sees a
 * WOOD/WALL roof within SHELTER_ROOF_SCAN, so isSheltered() passes once built
 * (SHELTER_WALL_HEIGHT is constrained to keep the roof in scan of a standing
 * head). Planning is pure over (members, grid) -> deterministic.
 *
 * Module-level state + reset(), mirroring resources.ts / buildqueue.ts / groups.ts.
 */

import type { Survivor } from '../characters/survivor';
import type { StructureKind } from './building';
import { get, inBounds } from '../engine/grid';
import { isSolidForBody } from '../engine/materials';
import {
  WORLD_W,
  WORLD_H,
  SHELTER_PER_SURVIVOR_AREA,
  SHELTER_MIN_SIZE,
  SHELTER_MIN_WIDTH,
  SHELTER_WALL_HEIGHT,
  SHELTER_DOORWAY_HEIGHT,
} from '../config';

/** One blueprint cell of a shelter (a wall or roof piece to be built). */
export interface ShelterCell {
  x: number;
  y: number;
  kind: StructureKind; // 'wall' (columns), 'fence' (WOOD roof), 'door' (doorway)
}

/** A group's shelter project = blueprint + key points. */
export interface ShelterProject {
  groupId: number;
  cells: ShelterCell[]; // walls + roof, EXCLUDING the doorway gap
  campfire: { x: number; y: number }; // where the hearth goes (interior floor)
  interior: { x: number; y: number }; // a representative standable interior cell
  iw: number; // interior width (cells)
  area: number; // interior footprint area (cells) this hut provides
}

// One project per group id.
const projects = new Map<number, ShelterProject>();

/** Reset all shelter projects (new-game init / test harness). */
export function resetShelters(): void {
  projects.clear();
}

/** The group's project, or null if none planned yet. */
export function getShelterProject(groupId: number): ShelterProject | null {
  return projects.get(groupId) ?? null;
}

/** Abandon a group's project (T4 merge-consolidate / cleanup). */
export function clearShelterProject(groupId: number): void {
  projects.delete(groupId);
}

/** All group ids that currently own a project. */
export function shelterGroupIds(): number[] {
  return Array.from(projects.keys()).sort((a, b) => a - b);
}

/**
 * First SOLID row at column x scanning DOWNWARD from `fromY`, or -1 if the
 * column is open to the bottom. The hut floor sits on this surface.
 *
 * The scan starts at the GROUP'S FEET, not at y=0 (playtest v0.10 R "shelter
 * built floating in the air"): a top-down scan returns the first solid the sky
 * sees - which, for a colony standing INSIDE the starter camp, is the camp's
 * ROOF - and the hut was planned on top of it, floating above their heads.
 * Scanning down from where the members actually stand finds the ground under
 * their boots (their own feet row counts if they stand flush against a slope).
 */
function surfaceRowFrom(x: number, fromY: number): number {
  if (x < 0 || x >= WORLD_W) return -1;
  for (let y = Math.max(0, fromY); y < WORLD_H; y++) {
    if (isSolidForBody(get(x, y))) return y;
  }
  return -1;
}

/**
 * PLAN (do not store) a shelter for `members` of `survivors`. Pure over the live
 * grid: centroid -> surface site -> sized hut geometry. Returns null if the site
 * is unusable (no surface / out of bounds). Deterministic for fixed inputs.
 */
export function planShelter(
  groupId: number,
  members: number[],
  survivors: Survivor[],
): ShelterProject | null {
  const live = members.filter(
    (i) => survivors[i] && survivors[i].body.alive && !survivors[i].turned,
  );
  if (live.length === 0) return null;

  // Centroid of the group's feet - column AND row (the row anchors the
  // downward surface scan so the hut sits on the ground under their boots).
  let sumX = 0;
  let sumY = 0;
  for (const i of live) {
    sumX += survivors[i].body.x;
    sumY += survivors[i].body.y;
  }
  const centroidX = Math.round(sumX / live.length);
  const centroidFeetY = Math.round(sumY / live.length);

  // Size by member count: interior footprint area -> interior width.
  const interiorHeight = SHELTER_WALL_HEIGHT - 1; // floor-to-just-below-roof
  const targetArea = Math.max(
    SHELTER_MIN_SIZE,
    live.length * SHELTER_PER_SURVIVOR_AREA,
  );
  let iw = Math.max(SHELTER_MIN_WIDTH, Math.ceil(targetArea / interiorHeight));

  // Place the hut centred on the centroid; clamp so walls stay in bounds.
  let leftWallX = centroidX - Math.floor(iw / 2) - 1;
  let rightWallX = leftWallX + iw + 1;
  if (leftWallX < 1) {
    leftWallX = 1;
    rightWallX = leftWallX + iw + 1;
  }
  if (rightWallX > WORLD_W - 2) {
    rightWallX = WORLD_W - 2;
    leftWallX = rightWallX - iw - 1;
    if (leftWallX < 1) {
      leftWallX = 1;
      iw = rightWallX - leftWallX - 1;
    }
  }
  if (iw < 1) return null;

  // Floor at the first solid BELOW the group's feet (not the first solid the
  // sky sees - that was the floating-shelter bug); feet row is one above it.
  const surface = surfaceRowFrom(centroidX, centroidFeetY);
  if (surface <= SHELTER_WALL_HEIGHT) return null; // no room above the surface
  const feetRow = surface - 1;
  const roofRow = feetRow - (SHELTER_WALL_HEIGHT - 1);
  if (roofRow < 0) return null;

  const cells: ShelterCell[] = [];

  // Roof: a WOOD span across the full hut width (wall tops included).
  for (let x = leftWallX; x <= rightWallX; x++) {
    cells.push({ x, y: roofRow, kind: 'fence' }); // 'fence' == WOOD
  }

  // Left wall: full height (roofRow+1 .. feetRow), WALL.
  for (let y = roofRow + 1; y <= feetRow; y++) {
    cells.push({ x: leftWallX, y, kind: 'wall' });
  }

  // Right wall: WALL above the doorway; the bottom SHELTER_DOORWAY_HEIGHT cells
  // are a DOOR (v0.10 playtest R8 "zombie proof doors"): the living walk
  // through it as if it were open (permeableToBodies), while the undead are
  // blocked and must gnaw its DOOR_INTEGRITY down - so the finished hut lets
  // survivors in and out but makes the horde queue up and chew.
  const doorTop = feetRow - SHELTER_DOORWAY_HEIGHT; // last walled row above the door
  for (let y = roofRow + 1; y <= doorTop; y++) {
    cells.push({ x: rightWallX, y, kind: 'wall' });
  }
  for (let y = doorTop + 1; y <= feetRow; y++) {
    cells.push({ x: rightWallX, y, kind: 'door' });
  }

  const interior = { x: centroidX, y: feetRow };
  // Campfire at the interior's LEFT end (away from the right-side doorway).
  const campfire = { x: leftWallX + 1, y: feetRow };

  return {
    groupId,
    cells,
    campfire,
    interior,
    iw,
    area: iw * interiorHeight,
  };
}

/**
 * Ensure the group has a project: return the existing one, or plan + store a new
 * one. Returns null if no valid site could be planned (caller retries later).
 */
export function ensureShelterProject(
  groupId: number,
  members: number[],
  survivors: Survivor[],
): ShelterProject | null {
  const existing = projects.get(groupId);
  if (existing) return existing;
  const project = planShelter(groupId, members, survivors);
  if (project) projects.set(groupId, project);
  return project;
}
