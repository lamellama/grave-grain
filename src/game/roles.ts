/**
 * game/roles.ts - Role definitions, wood-tier tools & tool-gated assignment
 * (GDD 6.2 roles, 6.3 tools/crafting/durability, 9 foliage harvest).
 *
 * Pure & DOM-free: this layer describes WHAT each role harvests and the gating
 * rules for assigning it; the per-survivor behaviour loop (find -> path -> work ->
 * deposit) lives in the survivor controller (p6-t4). It reads the live grid for
 * target queries (mirroring survivor.ts' bounded ring-scan) and the global
 * stockpile for craft gating, so it stays headless-testable.
 *
 * MVP scope (GDD 6.2/14): the four roles Miner / Lumberjack / Forager / Guard
 * at the WOOD tool tier only - no iron/stone tiers, no upgrade path, no
 * workstation. Diggers / Fisherman / Builder-Hauler are vertical-slice.
 *
 * Material distinction (GDD 9, 5.2): TREES and BUSHES in the world are FOLIAGE
 * (now permeable to bodies). A lumberjack CHOPS foliage -> wood; a forager
 * GATHERS the same foliage -> food - same material, different action/output/
 * timing. WOOD (id 6) is a placed STRUCTURE and is NEVER a harvest target. The
 * miner targets EXPOSED stone/ore (a rock cell with an AIR face) - you cannot
 * mine fully-buried rock.
 */

import type { ResourceKind } from './resources';
import { canAfford, spend, stockpilePoint } from './resources';
import { get } from '../engine/grid';
import { AIR, STONE, ORE, FOLIAGE, WATER } from '../engine/materials';
import { RESOURCE_SCAN_RADIUS, WOOD_TOOL_DURABILITY, ROLE_TINT_MIX } from '../config';
import {
  CHOP_TICKS,
  MINE_TICKS,
  GATHER_TICKS,
  AXE_WOOD_COST,
  PICKAXE_WOOD_COST,
  WEAPON_WOOD_COST,
  BASKET_WOOD_COST,
  HAMMER_WOOD_COST,
  HAMMER_DURABILITY,
  BUILD_TICKS,
  BUILDER_TINT,
  SHOVEL_WOOD_COST,
  SHOVEL_DURABILITY,
  DIG_TICKS,
  ROD_WOOD_COST,
  FISH_TICKS,
  DIGGER_DOWN_TINT,
  DIGGER_UP_TINT,
  FISHERMAN_TINT,
} from '../config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Roles (GDD 6.2); 'none' is the unassigned default. The two diggers and the
 * fisherman are the GDD 14 "Beyond" additions (item 4) on top of the MVP five.
 */
export type RoleName =
  | 'none'
  | 'miner'
  | 'lumberjack'
  | 'forager'
  | 'guard'
  | 'builder'
  | 'diggerDown'
  | 'diggerUp'
  | 'fisherman';

// ---------------------------------------------------------------------------
// Role tints (GDD 12 UX readability, task 11-5 - render-only)
// ---------------------------------------------------------------------------

/**
 * Per-role RGB tint colour. At draw time each body pixel is blended toward its
 * role's tint by ROLE_TINT_MIX so roles are visually distinct. 'none' carries a
 * sentinel (black) - tintForRole returns rgb UNCHANGED for 'none'.
 */
export const ROLE_TINT: Record<RoleName, [number, number, number]> = {
  none:       [  0,   0,   0], // sentinel - tintForRole returns rgb unchanged
  miner:      [110, 120, 135], // slate-grey
  lumberjack: [150,  90,  40], // brown / orange
  forager:    [ 60, 140,  60], // forest green
  guard:      [ 70, 110, 170], // steel-blue
  builder:    BUILDER_TINT,    // amber/tan (GDD 6.2 builder role)
  diggerDown: DIGGER_DOWN_TINT, // deep purple (GDD 6.2 down-diagonal digger)
  diggerUp:   DIGGER_UP_TINT,   // plum/magenta (GDD 6.2 up-diagonal digger)
  fisherman:  FISHERMAN_TINT,   // teal (GDD 6.2 fisherman)
};

/**
 * Blend `rgb` toward the role's tint by ROLE_TINT_MIX (render-only helper).
 * 'none' returns `rgb` unchanged (no tint).
 * Pure - no side-effects, no globals mutated - so it is safe to call per-pixel.
 */
export function tintForRole(
  rgb: [number, number, number],
  role: RoleName,
): [number, number, number] {
  if (role === 'none') return rgb;
  const t = ROLE_TINT[role];
  const m = ROLE_TINT_MIX;
  return [
    Math.round(rgb[0] * (1 - m) + t[0] * m),
    Math.round(rgb[1] * (1 - m) + t[1] * m),
    Math.round(rgb[2] * (1 - m) + t[2] * m),
  ];
}

/**
 * CSS `rgb(...)` swatch colour for a role's sprite tint (v0.8 playtest L). Used
 * to colour-match the Assign-menu buttons to the on-screen body tint - derived
 * from ROLE_TINT so the menu and the sprite never drift. 'none' (Unassign) has
 * no tint, so it gets a neutral grey.
 */
export function roleTintCss(role: RoleName): string {
  if (role === 'none') return 'rgb(120,120,120)'; // neutral - Unassign
  const t = ROLE_TINT[role];
  return `rgb(${t[0]},${t[1]},${t[2]})`;
}

/** Wood-tier tool kinds. Weapons are tools too (GDD 6.3). */
export type ToolKind = 'pickaxe' | 'axe' | 'basket' | 'weapon' | 'hammer' | 'shovel' | 'rod';

/** A held tool: a kind plus remaining durability (counts down to break). */
export interface Tool {
  kind: ToolKind;
  durability: number;
}

/**
 * Static role descriptor (GDD 6.2). `harvestMaterial`/`output` are null for the
 * miner (decided at harvest by the cell - STONE->stone, ORE->ore) and the guard
 * (no harvest). `craftCost` is what the colony spends to auto-craft the required
 * wood-tier tool.
 */
export interface RoleDef {
  requiredTool: ToolKind | null;
  output: ResourceKind | null;
  harvestMaterial: number | null;
  workTicks: number;
  craftCost: Partial<Record<ResourceKind, number>>;
}

// ---------------------------------------------------------------------------
// Tools (GDD 6.3 - durability, wood is brittle)
// ---------------------------------------------------------------------------

/** Fresh tool of the given kind at full wood-tier durability. */
export function makeTool(kind: ToolKind): Tool {
  // Hammer/shovel use their own higher durability so a builder can finish a
  // wall line and a digger a full-length tunnel (one use per column).
  const durability =
    kind === 'hammer' ? HAMMER_DURABILITY :
    kind === 'shovel' ? SHOVEL_DURABILITY :
    WOOD_TOOL_DURABILITY;
  return { kind, durability };
}

/**
 * Spend one use of a tool. Decrements durability by 1 and returns true if this
 * use JUST broke it (durability reached <= 0) - the caller then discards it.
 */
export function useTool(tool: Tool): boolean {
  tool.durability -= 1;
  return tool.durability <= 0;
}

// ---------------------------------------------------------------------------
// Role table (GDD 6.2)
// ---------------------------------------------------------------------------

export const ROLES: Record<RoleName, RoleDef> = {
  // BQ-3 will add the driving behaviour loop for builder; role data is here.
  builder: {
    requiredTool: 'hammer',
    output: null,
    harvestMaterial: null,
    workTicks: BUILD_TICKS,
    craftCost: { wood: HAMMER_WOOD_COST },
  },
  none: {
    requiredTool: null,
    output: null,
    harvestMaterial: null,
    workTicks: 0,
    craftCost: {},
  },
  // Fells trees: walks THROUGH foliage and chops it to wood (GDD 9). The axe
  // is FREE (AXE_WOOD_COST=0) so a colony at 0 wood can always bootstrap its
  // wood economy through this role (playtest v0.9 P).
  lumberjack: {
    requiredTool: 'axe',
    output: 'wood',
    harvestMaterial: FOLIAGE,
    workTicks: CHOP_TICKS,
    craftCost: { wood: AXE_WOOD_COST },
  },
  // Gathers from bushes: same FOLIAGE material, but yields food (GDD 9).
  forager: {
    requiredTool: 'basket',
    output: 'food',
    harvestMaterial: FOLIAGE,
    workTicks: GATHER_TICKS,
    craftCost: { wood: BASKET_WOOD_COST },
  },
  // Mines EXPOSED stone/ore; output decided per-cell at harvest (mineOutput).
  miner: {
    requiredTool: 'pickaxe',
    output: null,
    harvestMaterial: null,
    workTicks: MINE_TICKS,
    craftCost: { wood: PICKAXE_WOOD_COST },
  },
  // Holds a point and fights (combat lands in Phase 7); no harvest.
  guard: {
    requiredTool: 'weapon',
    output: null,
    harvestMaterial: null,
    workTicks: 0,
    craftCost: { wood: WEAPON_WOOD_COST },
  },
  // Tunnels diagonally DOWN a set distance or until hitting rock (GDD 6.2):
  // output is ACCESS (depth, exposed ore), not a stockpile resource. The dig
  // loop is self-driven (driveDigger in survivor.ts), so no harvestMaterial.
  diggerDown: {
    requiredTool: 'shovel',
    output: null,
    harvestMaterial: null,
    workTicks: DIG_TICKS,
    craftCost: { wood: SHOVEL_WOOD_COST },
  },
  // Tunnels diagonally UP - ramps and escape routes (GDD 6.2).
  diggerUp: {
    requiredTool: 'shovel',
    output: null,
    harvestMaterial: null,
    workTicks: DIG_TICKS,
    craftCost: { wood: SHOVEL_WOOD_COST },
  },
  // Fishes AT water (GDD 6.2): stands on the bank and pulls food from the
  // WATER cell WITHOUT consuming it - renewable food, paid for in FISH_TICKS.
  fisherman: {
    requiredTool: 'rod',
    output: 'food',
    harvestMaterial: WATER,
    workTicks: FISH_TICKS,
    craftCost: { wood: ROD_WOOD_COST },
  },
};

// ---------------------------------------------------------------------------
// Target queries over the live grid (GDD 6.2 findTarget - mirrors the bounded
// ring-scan in survivor.ts; reads the world directly so targets track edits).
// ---------------------------------------------------------------------------

/**
 * Nearest cell of material `mat` within `maxR` (Chebyshev) of (cx, cy), or null.
 * Scans ring by ring outward (closest ring first) and returns the Euclidean-
 * closest hit in the FIRST ring that contains one - cheap, early-exiting probe.
 * Mirrors survivor.ts' nearestMaterial.
 */
function nearestMaterial(
  cx: number,
  cy: number,
  mat: number,
  maxR: number,
): { x: number; y: number } | null {
  for (let r = 1; r <= maxR; r++) {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // perimeter only
        const x = cx + dx;
        const y = cy + dy;
        if (get(x, y) === mat) {
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = { x, y };
          }
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Is (x, y) an EXPOSED rock cell? True only for STONE/ORE with at least one
 * orthogonally-adjacent AIR neighbour (GDD 6.2 "find exposed stone/ore" - a
 * miner can't reach fully-buried rock). This adjacency test is the subtle part:
 * a buried block has solid neighbours on all four sides and is skipped.
 */
export function isExposedRock(x: number, y: number): boolean {
  const m = get(x, y);
  if (m !== STONE && m !== ORE) return false;
  return (
    get(x + 1, y) === AIR ||
    get(x - 1, y) === AIR ||
    get(x, y + 1) === AIR ||
    get(x, y - 1) === AIR
  );
}

/**
 * Nearest EXPOSED STONE/ORE cell within `maxR` (Chebyshev) of (cx, cy), or null.
 * Same ring-scan as nearestMaterial but the cell predicate is the exposed-rock
 * adjacency test (GDD 6.2).
 */
function nearestExposedRock(
  cx: number,
  cy: number,
  maxR: number,
): { x: number; y: number } | null {
  for (let r = 1; r <= maxR; r++) {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // perimeter only
        const x = cx + dx;
        const y = cy + dy;
        if (isExposedRock(x, y)) {
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = { x, y };
          }
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Find the work target for a role from (fromX, fromY), or null if none in range:
 *   lumberjack/forager -> nearest FOLIAGE (tree/bush) within RESOURCE_SCAN_RADIUS.
 *   miner             -> nearest EXPOSED stone/ore (skips fully-buried rock).
 *   fisherman         -> nearest WATER cell (the bank stand is survivor.ts' job).
 *   guard             -> the stockpile hold point (MVP "hold a point", GDD 6.2).
 *   builder           -> null (target acquisition is queue-driven - BQ-3 in survivor.ts).
 *   diggerDown/Up     -> null (the dig face is self-propelled - driveDigger).
 *   none              -> null.
 */
export function findTarget(
  role: RoleName,
  fromX: number,
  fromY: number,
): { x: number; y: number } | null {
  switch (role) {
    case 'lumberjack':
    case 'forager':
      return nearestMaterial(fromX, fromY, FOLIAGE, RESOURCE_SCAN_RADIUS);
    case 'miner':
      return nearestExposedRock(fromX, fromY, RESOURCE_SCAN_RADIUS);
    case 'fisherman':
      return nearestMaterial(fromX, fromY, WATER, RESOURCE_SCAN_RADIUS);
    case 'guard':
      return { x: stockpilePoint.x, y: stockpilePoint.y };
    case 'builder':
      // Builder targets are pulled from the blueprint queue (BQ-3), not
      // grid-scanned here. Return null; survivor.ts drives the pick.
      return null;
    case 'diggerDown':
    case 'diggerUp':
      // Diggers carve their own advancing face from the body's position
      // (driveDigger in survivor.ts) - there is no scanned target.
      return null;
    case 'none':
    default:
      return null;
  }
}

/**
 * Output kind for a mined cell (GDD 6.2): STONE->'stone', ORE->'ore', else null.
 * Helper for the miner's harvest in p6-t4 (output is decided per-cell).
 */
export function mineOutput(cellMaterial: number): ResourceKind | null {
  if (cellMaterial === STONE) return 'stone';
  if (cellMaterial === ORE) return 'ore';
  return null;
}

// ---------------------------------------------------------------------------
// Tool-gated assignment (GDD 6.2 - assignable only if the required tool exists
// or can be auto-crafted from the stockpile).
// ---------------------------------------------------------------------------

/**
 * Can `role` be assigned given the tools the colony already owns? True if:
 *   - the role needs no tool (requiredTool === null), OR
 *   - the colony already owns that tool kind (in `ownedTools`), OR
 *   - the craft cost is affordable from the current stockpile.
 */
export function canAssign(role: RoleName, ownedTools: ToolKind[]): boolean {
  const def = ROLES[role];
  if (def.requiredTool === null) return true;
  if (ownedTools.includes(def.requiredTool)) return true;
  return canAfford(def.craftCost);
}

/**
 * Auto-craft the wood-tier tool a role requires, spending from the stockpile.
 * Returns null if the role needs no tool OR the spend fails (insufficient
 * stockpile). On success the stockpile is debited and a fresh tool is returned.
 */
export function craftToolFor(role: RoleName): Tool | null {
  const def = ROLES[role];
  if (def.requiredTool === null) return null;
  if (!spend(def.craftCost)) return null;
  return makeTool(def.requiredTool);
}
